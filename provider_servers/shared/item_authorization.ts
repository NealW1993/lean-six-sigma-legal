// Shared, storage-independent authorization for the Firebase and MySQL kits.
// Callers must lock the workspace and read current membership in the same
// transaction as applying changes. Never accept Actor fields from a request.
export type Json = Record<string, unknown>;
export type RecordKind = typeof recordKinds[number];
export const recordKinds = ["projects", "notes", "meetings", "fishbones",
  "calculations", "dataSets", "fmeaSheets", "sipocs", "topics",
  "topicComments", "syncedAttachments"] as const;
export interface Actor {
  uid: string; principal: string; owner: boolean; canEdit: boolean;
  canDelete: boolean; name: string;
}
export interface TeamRecord {
  id: string; kind: RecordKind; owner: string; editor: string;
  revision: number; deleted: boolean; body: Json; updatedAt: string;
}
export class AuthorizationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
const fail = (code: string, message: string, status = 403): never => {
  throw new AuthorizationError(status, code, message);
};
export function asObject(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid_record", "Expected an object.", 400);
  }
  return value as Json;
}
function idOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return fail("invalid_id", "Invalid record identifier.", 400);
  }
  return value;
}
/** The ids a record's body links to, ignoring malformed entries. */
function linkIds(body: Json | undefined): Set<string> {
  const links = body?.linkedItems;
  return new Set(Array.isArray(links)
    ? links.flatMap(link => link && typeof link === "object" ? [String((link as Json).id)] : [])
    : []);
}
function access(record: TeamRecord): Json {
  if (record.kind === "projects") return {read: true, write: true, delete: false};
  if (record.kind === "topics" || record.kind === "topicComments") {
    return {read: true, write: false, delete: false};
  }
  return asObject(record.body.access ?? {read: true, write: false, delete: false});
}
export function controls(actor: Actor, record: TeamRecord): boolean {
  return actor.owner || actor.principal === record.owner;
}
export function allowed(actor: Actor, record: TeamRecord, action: "read" | "write" | "delete",
  records: ReadonlyMap<string, TeamRecord>, visiting = new Set<string>()): boolean {
  if (visiting.has(record.id)) return false;
  visiting.add(record.id);
  if (record.kind === "syncedAttachments" || record.kind === "topicComments") {
    const parentId = record.body[record.kind === "syncedAttachments" ? "itemId" : "topicId"];
    const parent = typeof parentId === "string" ? records.get(parentId) : undefined;
    if (!parent || parent.deleted || !allowed(actor, parent,
      record.kind === "syncedAttachments" ? action : "read", records, visiting)) return false;
  }
  if (actor.owner) return true;
  if (action !== "read" && !actor.canEdit) return false;
  if (action === "delete" && !actor.canDelete && record.owner !== actor.principal) return false;
  if (record.owner === actor.principal) return true;
  const permissions = access(record);
  return permissions.read === true && (action === "read" || permissions[action] === true);
}
function normalized(body: Json, old: TeamRecord | undefined, kind: RecordKind,
  actor: Actor, workspace: string, name: string, now: string): Json {
  const result = {...body};
  for (const key of ["userId", "creatorId", "isDirty", "updatedAt", "authorKey", "authorProof",
    "localPath", "localAttachmentPaths", "audioPath", "_server"]) delete result[key];
  result.userId = actor.principal;
  result.creatorId = old?.owner ?? actor.principal;
  result.isDirty = false;
  result.createdAt = old?.body.createdAt ?? now;
  result.updatedAt = now;
  if (kind === "projects" || kind === "topics" || kind === "topicComments") result.groupName = name;
  if (kind === "topics" || kind === "topicComments") {
    result.authorName = old?.body.authorName ?? actor.name;
    if (!actor.owner && result.pinned === true && old?.body.pinned !== true) {
      fail("owner_required", "Only the workspace owner can pin a topic.");
    }
  }
  if (kind === "syncedAttachments") {
    if (result.scope !== "shared" || result.scopeId !== workspace ||
      typeof result.storagePath !== "string" ||
      !result.storagePath.startsWith(`shared/${workspace}/${result.id}/`) ||
      result.storagePath.includes("..") || result.storagePath.includes("\\") ||
      !/^[a-f0-9]{64}$/.test(String(result.sha256)) ||
      !Number.isSafeInteger(result.sizeBytes) || Number(result.sizeBytes) < 1 ||
      Number(result.sizeBytes) > 104857600) fail("invalid_manifest", "Invalid attachment manifest.", 400);
    if (old && ["itemId", "storagePath", "sha256", "sizeBytes", "mimeType"].some(
      key => result[key] !== old.body[key])) fail("immutable_manifest", "Create a new attachment for changed content.");
    result.workspaceName = name;
  } else if (kind !== "projects" && kind !== "topics" && kind !== "topicComments") {
    const permissions = asObject(result.access ?? {read: true, write: false, delete: false});
    if (["read", "write", "delete"].some(key => typeof permissions[key] !== "boolean") ||
      Object.keys(permissions).some(key => !["read", "write", "delete"].includes(key))) {
      fail("invalid_access", "Access flags must be explicit booleans.", 400);
    }
    result.access = permissions;
  }
  return result;
}

export function applyChanges(current: ReadonlyMap<string, TeamRecord>, input: unknown,
  actor: Actor, workspace: string, name: string, now: string): Map<string, TeamRecord> {
  if (!Array.isArray(input) || input.length > 2000) fail("invalid_changes", "Send at most 2000 changes.", 400);
  const changes = input as unknown[];
  const result = new Map(current);
  const seen = new Set<string>();
  for (const raw of changes) {
    const change = asObject(raw);
    const id = idOf(change.id);
    if (seen.has(id)) fail("duplicate_change", "A record can change only once per request.", 400);
    seen.add(id);
    const old = current.get(id);
    const kind = change.kind as RecordKind;
    if (!recordKinds.includes(kind) || (old && old.kind !== kind)) fail("invalid_kind", "Record kind cannot change.", 400);
    if (!Number.isSafeInteger(change.baseRevision) || change.baseRevision !== (old?.revision ?? 0)) {
      fail("conflict", "This item changed. Refresh before retrying.", 409);
    }
    if (old && (!allowed(actor, old, change.deleted === true ? "delete" : "write", current))) {
      fail("item_forbidden", "You do not have permission to change this item.");
    }
    if (!old && (!actor.canEdit && !actor.owner)) fail("read_only", "This workspace is read-only.");
    if (change.deleted === true) {
      if (!old) fail("missing_item", "Cannot delete an unknown item.", 409);
      result.set(id, {...old!, revision: old!.revision + 1, deleted: true, editor: actor.principal, updatedAt: now});
      continue;
    }
    if (old?.deleted && !controls(actor, old)) fail("restore_forbidden", "Only the creator or owner can restore this item.");
    const body = normalized(asObject(change.body), old, kind, actor, workspace, name, now);
    if (body.id !== id) fail("identity_mismatch", "Record ID does not match.", 400);
    if (old && !controls(actor, old) && JSON.stringify(access(old)) !== JSON.stringify(body.access ?? access(old))) {
      fail("grant_forbidden", "Only the creator or owner can change item permissions.");
    }
    result.set(id, {id, kind, owner: old?.owner ?? actor.principal, editor: actor.principal,
      revision: (old?.revision ?? 0) + 1, deleted: false, body, updatedAt: now});
  }
  // Validate references after applying the batch so new projects and children
  // can be created together. All lookups are within this workspace only.
  for (const id of seen) {
    const record = result.get(id)!;
    if (record.deleted) continue;
    const body = record.body;
    if (record.kind === "syncedAttachments" || record.kind === "topicComments") {
      const parent = result.get(String(body[record.kind === "syncedAttachments" ? "itemId" : "topicId"]));
      if (!parent || parent.deleted || parent.kind === "syncedAttachments" ||
        (record.kind === "topicComments" && parent.kind !== "topics") ||
        !allowed(actor, parent, record.kind === "syncedAttachments" ? "write" : "read", result)) {
        fail("invalid_parent", "The parent item is unavailable or restricted.");
      }
    } else if (record.kind !== "projects" && record.kind !== "topics") {
      if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.some(value => {
        const project = result.get(String(value));
        return !project || project.kind !== "projects" || project.deleted || !allowed(actor, project, "read", result);
      })) fail("invalid_project", "Every item must belong to a project in this workspace.");
    }
    // A link the record already carried stays. An item since deleted or made
    // private stops new links to it; an edit by someone who cannot open it
    // must not strip the link from teammates who can.
    const carried = linkIds(current.get(id)?.body);
    if (Array.isArray(body.linkedItems) && body.linkedItems.some(value => {
      const linkId = String(asObject(value).id);
      if (carried.has(linkId)) return false;
      const linked = result.get(linkId);
      return !linked || linked.deleted || !allowed(actor, linked, "read", result);
    })) fail("invalid_link", "A linked item is unavailable or restricted.");
  }
  return result;
}

export function projectRecords(records: ReadonlyMap<string, TeamRecord>, actor: Actor,
  workspace: string, name: string): Json {
  const payload: Json = {schemaVersion: 1, sharedProtocol: 2, sharedGroupId: workspace,
    workspaceName: name, records: [], tombstones: {}, notifications: [], carriedLinks: true};
  const projected = payload.records as Json[];
  const notifications = payload.notifications as Json[];
  for (const record of records.values()) {
    if (!allowed(actor, record, "read", records)) continue;
    projected.push({...record, owned: record.owner === actor.principal,
      editedByMe: record.editor === actor.principal, control: controls(actor, record),
      canWrite: !record.deleted && allowed(actor, record, "write", records),
      canDelete: !record.deleted && allowed(actor, record, "delete", records)});
    if (!record.deleted && record.kind !== "syncedAttachments") notifications.push({
      id: `${record.id}:${record.revision}`, userId: record.editor, groupId: workspace,
      title: "Workspace updated", body: String(record.body.title ?? record.body.name ?? "Item updated"),
      createdAt: record.updatedAt, isRead: false,
    });
  }
  return payload;
}

export function authorizeFile(records: ReadonlyMap<string, TeamRecord>, actor: Actor,
  path: string, action: "read" | "write" | "delete"): TeamRecord {
  const record = [...records.values()].find(item => item.kind === "syncedAttachments" && item.body.storagePath === path);
  if (!record || record.deleted || !allowed(actor, record, action, records)) {
    return fail("attachment_forbidden", "The attachment is unavailable or restricted.");
  }
  return record;
}
