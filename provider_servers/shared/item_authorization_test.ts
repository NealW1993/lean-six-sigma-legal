import {
  type Actor, type TeamRecord, type RecordKind, type Json,
  applyChanges, projectRecords, authorizeFile, AuthorizationError,
} from "./item_authorization.ts";

const owner: Actor = {uid: "owner-device", principal: "owner", owner: true,
  canEdit: true, canDelete: true, name: "Owner"};
const member: Actor = {uid: "member-device", principal: "member", owner: false,
  canEdit: true, canDelete: true, name: "Member"};
const now = "2026-10-20T12:00:00Z";
const workspace = "test-team";
const kinds: RecordKind[] = ["notes", "meetings", "fishbones", "calculations",
  "dataSets", "fmeaSheets", "sipocs"];

function assert(ok: unknown, message = "assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
function denied(code: string, fn: () => unknown) {
  try { fn(); } catch (error) {
    assert(error instanceof AuthorizationError && error.code === code,
      `Expected ${code}, got ${String(error)}`);
    return;
  }
  throw new Error(`Expected ${code}, but operation succeeded`);
}
function record(kind: RecordKind, body: Json = {}, principal = "owner"): TeamRecord {
  return {id: "item", kind, owner: principal, editor: principal, revision: 1,
    deleted: false, updatedAt: now, body: {id: "item", projectIds: ["project"],
      access: {read: false, write: false, delete: false}, ...body}};
}
function records(item: TeamRecord) {
  const project = {...record("projects"), id: "project", body: {id: "project"}};
  return new Map([[project.id, project], [item.id, item]]);
}
function push(current: Map<string, TeamRecord>, item: TeamRecord,
  actor = member, overrides: Json = {}) {
  return applyChanges(current, [{id: item.id, kind: item.kind,
    baseRevision: item.revision, body: item.body, ...overrides}], actor,
    workspace, "Test team", now);
}

for (const kind of kinds) {
  Deno.test(`${kind}: private bodies and notifications are not projected`, () => {
    const item = record(kind, {title: "private sentinel"});
    assert(!JSON.stringify(projectRecords(records(item), member, workspace,
      "Test team")).includes("private sentinel"));
    assert(JSON.stringify(projectRecords(records(item), owner, workspace,
      "Test team")).includes("private sentinel"));
  });
  Deno.test(`${kind}: members cannot forge edit, deletion, or access grants`, () => {
    const item = record(kind);
    const current = records(item);
    denied("item_forbidden", () => push(current, item));
    denied("item_forbidden", () => push(current, item, member, {deleted: true}));
    denied("item_forbidden", () => push(current, item, member, {body: {
      ...item.body, creatorId: member.principal,
      access: {read: true, write: true, delete: true},
    }}));
    assert(current.get(item.id)?.revision === 1);
  });
  Deno.test(`${kind}: an editor cannot change permissions or take ownership`, () => {
    const item = record(kind, {access: {read: true, write: true, delete: false}});
    const current = records(item);
    denied("grant_forbidden", () => push(current, item, member, {body: {
      ...item.body, access: {read: true, write: true, delete: true},
    }}));
    const result = push(current, item, member, {body: {
      ...item.body, creatorId: member.principal, userId: owner.principal,
    }}).get(item.id)!;
    assert(result.owner === owner.principal);
    assert(result.body.creatorId === owner.principal);
    assert(result.body.userId === member.principal);
    denied("item_forbidden", () => push(current, item, member, {deleted: true}));
  });
}

Deno.test("stale revisions and changes of record kind are rejected", () => {
  const item = record("notes");
  denied("conflict", () => push(records(item), item, owner, {baseRevision: 0}));
  denied("invalid_kind", () => push(records(item), item, owner, {kind: "calculations"}));
});
Deno.test("workspace read-only restriction also applies to the creator", () => {
  const item = record("notes", {}, member.principal);
  denied("item_forbidden", () => push(records(item), item,
    {...member, canEdit: false}, {deleted: true}));
  denied("item_forbidden", () => push(records(item), item,
    {...member, canEdit: false}));
});
Deno.test("new items use authenticated ownership, not client creator claims", () => {
  const item = record("notes");
  const current = records(item);
  current.delete(item.id);
  const result = push(current, item, member, {baseRevision: 0,
    body: {...item.body, creatorId: owner.principal}}).get(item.id)!;
  assert(result.owner === member.principal && result.body.creatorId === member.principal);
});
Deno.test("paired devices with the same server principal retain item access", () => {
  const item = record("notes", {}, member.principal);
  const result = push(records(item), item, {...member, uid: "paired-device"});
  assert(result.get(item.id)?.revision === 2);
});
Deno.test("attachments inherit private-parent restrictions even for their creator", () => {
  const item = record("notes");
  const attachment = {...record("syncedAttachments", {
    id: "attachment", itemId: item.id,
    storagePath: "shared/test-team/attachment/photo.png",
  }, member.principal), id: "attachment"};
  const current = records(item);
  current.set(attachment.id, attachment);
  for (const action of ["read", "write", "delete"] as const) {
    denied("attachment_forbidden", () => authorizeFile(current, member,
      String(attachment.body.storagePath), action));
  }
  assert(!(projectRecords(current, member, workspace, "Test team").records as Json[])
    .some(value => value.id === attachment.id));
});
Deno.test("same access flags in another JSON key order remain editable", () => {
  const item = record("notes", {access: {read: true, write: true, delete: false}});
  const result = push(records(item), item, member, {body: {...item.body,
    access: {delete: false, write: true, read: true}}});
  assert(result.get(item.id)?.revision === 2);
});
Deno.test("only the workspace owner can pin or unpin a member's topic", () => {
  for (const pinned of [false, true]) {
    const item = record("topics", {pinned}, member.principal);
    denied("owner_required", () => push(records(item), item, member, {
      body: {...item.body, pinned: !pinned},
    }));
    assert(push(records(item), item, owner, {body: {...item.body,
      pinned: !pinned}}).get(item.id)?.body.pinned === !pinned);
    assert(push(records(item), item).get(item.id)?.revision === 2);
  }
});
