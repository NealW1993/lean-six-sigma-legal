import {initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {FieldValue, Firestore, getFirestore, Timestamp} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import {defineSecret} from "firebase-functions/params";
import {onRequest} from "firebase-functions/v2/https";
import {timingSafeEqual} from "node:crypto";

initializeApp();

const clientKey = defineSecret("SIX_SIGMA_CLIENT_KEY");
const setupToken = defineSecret("SIX_SIGMA_SETUP_TOKEN");
const protocol = "lean-six-sigma-sync";
const version = 1;
const maxPayloadBytes = 12 * 1024 * 1024;
const signedUrlLifetimeMs = 5 * 60 * 1000;

type Json = Record<string, unknown>;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(data: Json, key: string, max = 500): string {
  const value = String(data[key] ?? "").trim();
  if (value.length > max) throw new ApiError(400, "invalid_input", `${key} is too long.`);
  return value;
}

function required(data: Json, key: string, max = 500): string {
  const value = text(data, key, max);
  if (!value) throw new ApiError(400, "invalid_input", `${key} is required.`);
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertSetup(data: Json): void {
  const configured = setupToken.value();
  if (configured && !safeEqual(text(data, "setup_token", 500), configured)) {
    throw new ApiError(403, "invalid_setup_token", "The provider setup token is invalid.");
  }
}

async function userId(authorization: string | undefined): Promise<string> {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) throw new ApiError(401, "missing_identity", "A device identity is required.");
  try {
    return (await getAuth().verifyIdToken(match[1], true)).uid;
  } catch {
    throw new ApiError(401, "invalid_identity", "The device identity is invalid or expired.");
  }
}

async function personalMember(db: Firestore, uid: string, vaultId?: string): Promise<Json> {
  const snap = await db.collection("personal_members").doc(uid).get();
  if (!snap.exists || snap.get("active") === false) {
    throw new ApiError(403, "not_a_vault_member", "Personal vault membership required.");
  }
  const row = object(snap.data());
  if (vaultId && row.vault_id !== vaultId) {
    throw new ApiError(403, "wrong_vault", "This identity belongs to a different vault.");
  }
  return row;
}

async function workspaceMember(db: Firestore, uid: string, workspaceId: string): Promise<Json> {
  const snap = await db.collection("workspaces").doc(workspaceId).collection("members").doc(uid).get();
  if (!snap.exists || snap.get("active") === false) {
    throw new ApiError(403, "not_a_workspace_member", "Workspace membership required.");
  }
  return object(snap.data());
}

function membershipJson(row: Json): Json {
  return {
    vault_id: row.vault_id,
    role: row.role,
    member_role: row.role,
    device_name: row.device_name ?? "Device",
    user_id: row.user_id,
    joined_at: row.joined_at instanceof Timestamp ? row.joined_at.toDate().toISOString() : null,
    last_seen_at: row.last_seen_at instanceof Timestamp ? row.last_seen_at.toDate().toISOString() : null,
  };
}

function workspaceMemberJson(row: Json): Json {
  return {
    user_id: row.user_id,
    role: row.role,
    member_role: row.role,
    can_invite: row.can_invite === true,
    display_name: row.display_name ?? "Member",
    joined_at: row.joined_at instanceof Timestamp ? row.joined_at.toDate().toISOString() : null,
  };
}

async function authorizeAttachment(db: Firestore, uid: string, data: Json): Promise<string> {
  const scope = required(data, "scope", 20);
  const scopeId = required(data, "scope_id", 100);
  const id = required(data, "id", 100);
  const path = required(data, "storage_path", 1000);
  const expected = `${scope}/${scopeId}/${id}/`;
  if ((scope !== "personal" && scope !== "shared") || !path.startsWith(expected) || path.includes("..")) {
    throw new ApiError(400, "invalid_path", "The attachment path is invalid.");
  }
  if (scope === "personal") await personalMember(db, uid, scopeId);
  else await workspaceMember(db, uid, scopeId);
  return path;
}

async function execute(db: Firestore, operation: string, data: Json, uid: string): Promise<unknown> {
  const now = FieldValue.serverTimestamp();
  switch (operation) {
    case "initialize_personal_schema":
      return {ready: true};
    case "personal_vault_membership": {
      const snap = await db.collection("personal_members").doc(uid).get();
      return snap.exists && snap.get("active") !== false ? membershipJson(object(snap.data())) : null;
    }
    case "initialize_personal_vault": {
      const vaultId = required(data, "vault_id", 100);
      const deviceName = required(data, "device_name", 120);
      await db.runTransaction(async (tx) => {
        const memberRef = db.collection("personal_members").doc(uid);
        const vaultRef = db.collection("personal_vaults").doc(vaultId);
        const [member, vault] = await Promise.all([tx.get(memberRef), tx.get(vaultRef)]);
        if (member.exists && member.get("vault_id") !== vaultId) {
          throw new ApiError(409, "already_paired", "This identity already belongs to another vault.");
        }
        if (vault.exists && vault.get("owner_user_id") !== uid) {
          throw new ApiError(409, "vault_exists", "That vault already has a different owner.");
        }
        tx.set(vaultRef, {owner_user_id: uid, created_at: vault.get("created_at") ?? now}, {merge: true});
        tx.set(memberRef, {vault_id: vaultId, user_id: uid, role: "owner", device_name: deviceName, active: true, joined_at: now, last_seen_at: now});
      });
      return membershipJson({vault_id: vaultId, user_id: uid, role: "owner", device_name: deviceName});
    }
    case "create_personal_invite": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can invite devices.");
      const hash = required(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      await db.collection("personal_invites").doc(hash).set({vault_id: vaultId, created_by: uid, expires_at: Timestamp.fromDate(new Date(required(data, "expires_at", 80))), consumed_at: null, created_at: now});
      return {created: true};
    }
    case "redeem_personal_invite": {
      const vaultId = required(data, "vault_id", 100);
      const hash = required(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      const deviceName = required(data, "device_name", 120);
      await db.runTransaction(async (tx) => {
        const inviteRef = db.collection("personal_invites").doc(hash);
        const memberRef = db.collection("personal_members").doc(uid);
        const invite = await tx.get(inviteRef);
        if (!invite.exists || invite.get("vault_id") !== vaultId || invite.get("consumed_at") || invite.get("expires_at").toMillis() <= Date.now()) {
          throw new ApiError(409, "invite_invalid", "The invitation is invalid, expired, or already used.");
        }
        const existing = await tx.get(memberRef);
        if (existing.exists && existing.get("vault_id") !== vaultId) throw new ApiError(409, "already_paired", "This device belongs to another vault.");
        tx.set(memberRef, {vault_id: vaultId, user_id: uid, role: "member", device_name: deviceName, active: true, joined_at: now, last_seen_at: now});
        tx.update(inviteRef, {consumed_at: now, consumed_by: uid});
      });
      return membershipJson({vault_id: vaultId, user_id: uid, role: "member", device_name: deviceName});
    }
    case "list_personal_devices": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can list devices.");
      const rows = await db.collection("personal_members").where("vault_id", "==", vaultId).where("active", "==", true).get();
      return rows.docs.map((doc) => membershipJson(object(doc.data())));
    }
    case "rename_personal_device": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      await db.collection("personal_members").doc(uid).update({device_name: required(data, "device_name", 120), last_seen_at: now});
      return {updated: true};
    }
    case "revoke_personal_device": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can revoke devices.");
      const target = required(data, "device_user_id", 200);
      if (target === uid) throw new ApiError(400, "cannot_revoke_owner", "The primary device cannot revoke itself.");
      const targetRef = db.collection("personal_members").doc(target);
      const targetRow = await targetRef.get();
      if (!targetRow.exists || targetRow.get("vault_id") !== vaultId) throw new ApiError(404, "device_not_found", "Device not found.");
      await targetRef.update({active: false, revoked_at: now});
      return {revoked: true};
    }
    case "touch_personal_device": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      await db.collection("personal_members").doc(uid).update({last_seen_at: now});
      return {updated: true};
    }
    case "publish_personal_key_update": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can transfer keys.");
      const updateId = required(data, "update_id", 64);
      const sealed = required(data, "sealed_keys", 16000);
      const expiresAt = new Date(required(data, "expires_at", 80));
      const latest = Date.now() + 8 * 24 * 60 * 60 * 1000;
      if (!/^[0-9a-f]{64}$/.test(updateId) || !sealed.startsWith("pdk1.") || Number.isNaN(expiresAt.valueOf()) || expiresAt.valueOf() <= Date.now() || expiresAt.valueOf() > latest) {
        throw new ApiError(400, "invalid_key_transfer", "Invalid key transfer request.");
      }
      const vaultRef = db.collection("personal_vaults").doc(vaultId);
      const receipts = await vaultRef.collection("key_receipts").get();
      const batch = db.batch();
      batch.set(vaultRef.collection("key_update").doc("current"), {update_id: updateId, sealed_keys: sealed, created_by: uid, created_at: now, expires_at: Timestamp.fromDate(expiresAt)});
      receipts.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return {published: true};
    }
    case "personal_key_update": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      const vaultRef = db.collection("personal_vaults").doc(vaultId);
      const update = await vaultRef.collection("key_update").doc("current").get();
      if (!update.exists || update.get("expires_at").toMillis() <= Date.now()) return null;
      const receipt = await vaultRef.collection("key_receipts").doc(uid).get();
      const created = update.get("created_at");
      return {
        update_id: update.get("update_id"),
        sealed_keys: update.get("sealed_keys"),
        created_at: created instanceof Timestamp ? created.toDate().toISOString() : null,
        expires_at: update.get("expires_at").toDate().toISOString(),
        received: receipt.exists && receipt.get("update_id") === update.get("update_id"),
      };
    }
    case "confirm_personal_key_update": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      const updateId = required(data, "update_id", 64);
      const vaultRef = db.collection("personal_vaults").doc(vaultId);
      const update = await vaultRef.collection("key_update").doc("current").get();
      if (!update.exists || update.get("update_id") !== updateId) {
        throw new ApiError(409, "key_transfer_gone", "That key transfer is no longer waiting.");
      }
      await vaultRef.collection("key_receipts").doc(uid).set({user_id: uid, update_id: updateId, received_at: now});
      return {confirmed: true};
    }
    case "personal_key_update_status": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can see key transfers.");
      const vaultRef = db.collection("personal_vaults").doc(vaultId);
      const update = await vaultRef.collection("key_update").doc("current").get();
      if (!update.exists) return [];
      const updateId = update.get("update_id");
      const created = update.get("created_at");
      const base = {
        update_id: updateId,
        created_at: created instanceof Timestamp ? created.toDate().toISOString() : null,
        expires_at: update.get("expires_at").toDate().toISOString(),
      };
      const receipts = await vaultRef.collection("key_receipts").where("update_id", "==", updateId).get();
      if (receipts.empty) return [{...base, user_id: null, received_at: null}];
      return receipts.docs.map((doc) => {
        const at = doc.get("received_at");
        return {...base, user_id: doc.get("user_id"), received_at: at instanceof Timestamp ? at.toDate().toISOString() : null};
      });
    }
    case "cancel_personal_key_update": {
      const vaultId = required(data, "vault_id", 100);
      const member = await personalMember(db, uid, vaultId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the primary device can cancel a key transfer.");
      const vaultRef = db.collection("personal_vaults").doc(vaultId);
      const receipts = await vaultRef.collection("key_receipts").get();
      const batch = db.batch();
      batch.delete(vaultRef.collection("key_update").doc("current"));
      receipts.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return {cancelled: true};
    }
    case "push_personal_snapshot": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      const payload = object(data.payload);
      if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes) throw new ApiError(413, "payload_too_large", "Snapshot is too large.");
      await db.collection("personal_vaults").doc(vaultId).collection("snapshots").doc(uid).set({user_id: uid, payload, updated_at: now});
      return {saved: true};
    }
    case "pull_personal_snapshots": {
      const vaultId = required(data, "vault_id", 100);
      await personalMember(db, uid, vaultId);
      const rows = await db.collection("personal_vaults").doc(vaultId).collection("snapshots").get();
      return rows.docs.map((doc) => ({user_id: doc.get("user_id"), payload: doc.get("payload")}));
    }
    case "initialize_workspace": {
      assertSetup(data);
      const workspaceId = required(data, "workspace_id", 100);
      const name = required(data, "workspace_name", 200);
      const displayName = required(data, "display_name", 120);
      await db.runTransaction(async (tx) => {
        const workspaceRef = db.collection("workspaces").doc(workspaceId);
        const memberRef = workspaceRef.collection("members").doc(uid);
        const workspace = await tx.get(workspaceRef);
        if (workspace.exists && workspace.get("owner_user_id") !== uid) throw new ApiError(409, "owner_exists", "This workspace already has another owner.");
        tx.set(workspaceRef, {name, owner_user_id: uid, created_at: workspace.get("created_at") ?? now}, {merge: true});
        tx.set(memberRef, {user_id: uid, role: "owner", can_invite: true, display_name: displayName, active: true, joined_at: now});
      });
      return {initialized: true};
    }
    case "repair_workspace_owner": {
      assertSetup(data);
      const workspaceId = required(data, "workspace_id", 100);
      const previous = required(data, "previous_user_id", 200);
      if (required(data, "replacement_user_id", 200) !== uid) throw new ApiError(403, "identity_mismatch", "Replacement identity mismatch.");
      await db.runTransaction(async (tx) => {
        const workspaceRef = db.collection("workspaces").doc(workspaceId);
        const workspace = await tx.get(workspaceRef);
        if (!workspace.exists || workspace.get("owner_user_id") !== previous) throw new ApiError(409, "owner_changed", "The stored owner no longer matches.");
        tx.update(workspaceRef, {owner_user_id: uid});
        tx.set(workspaceRef.collection("members").doc(uid), {user_id: uid, role: "owner", can_invite: true, display_name: required(data, "display_name", 120), active: true, joined_at: now});
        tx.set(workspaceRef.collection("members").doc(previous), {active: false, revoked_at: now}, {merge: true});
      });
      return {repaired: true};
    }
    case "workspace_permissions":
      return await workspaceMember(db, uid, required(data, "workspace_id", 100));
    case "set_workspace_display_name": {
      const workspaceId = required(data, "workspace_id", 100);
      await workspaceMember(db, uid, workspaceId);
      await db.collection("workspaces").doc(workspaceId).collection("members").doc(uid).update({display_name: required(data, "display_name", 120)});
      return {updated: true};
    }
    case "create_workspace_invite": {
      const workspaceId = required(data, "workspace_id", 100);
      const member = await workspaceMember(db, uid, workspaceId);
      if (member.role !== "owner" && member.can_invite !== true) throw new ApiError(403, "invite_forbidden", "Invitation permission required.");
      const hash = required(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      await db.collection("workspace_invites").doc(hash).set({workspace_id: workspaceId, created_by: uid, expires_at: Timestamp.fromDate(new Date(required(data, "expires_at", 80))), consumed_at: null, created_at: now});
      return {created: true};
    }
    case "redeem_workspace_invite": {
      const workspaceId = required(data, "workspace_id", 100);
      const hash = required(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      await db.runTransaction(async (tx) => {
        const inviteRef = db.collection("workspace_invites").doc(hash);
        const invite = await tx.get(inviteRef);
        if (!invite.exists || invite.get("workspace_id") !== workspaceId || invite.get("consumed_at") || invite.get("expires_at").toMillis() <= Date.now()) throw new ApiError(409, "invite_invalid", "The invitation is invalid, expired, or already used.");
        tx.set(db.collection("workspaces").doc(workspaceId).collection("members").doc(uid), {user_id: uid, role: "member", can_invite: false, display_name: "Member", active: true, joined_at: now});
        tx.update(inviteRef, {consumed_at: now, consumed_by: uid});
      });
      return {role: "member", can_invite: false};
    }
    case "list_workspace_members": {
      const workspaceId = required(data, "workspace_id", 100);
      const member = await workspaceMember(db, uid, workspaceId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the owner can list members.");
      const rows = await db.collection("workspaces").doc(workspaceId).collection("members").where("active", "==", true).get();
      return rows.docs.map((doc) => workspaceMemberJson(object(doc.data())));
    }
    case "set_member_invite_permission": {
      const workspaceId = required(data, "workspace_id", 100);
      const member = await workspaceMember(db, uid, workspaceId);
      if (member.role !== "owner") throw new ApiError(403, "owner_required", "Only the owner can change permissions.");
      const target = required(data, "member_user_id", 200);
      const targetRef = db.collection("workspaces").doc(workspaceId).collection("members").doc(target);
      const targetRow = await targetRef.get();
      if (!targetRow.exists || targetRow.get("role") === "owner") throw new ApiError(400, "invalid_member", "Select an active non-owner member.");
      await targetRef.update({can_invite: data.can_invite === true});
      return {updated: true};
    }
    case "push_shared_snapshot": {
      const workspaceId = required(data, "workspace_id", 100);
      await workspaceMember(db, uid, workspaceId);
      const payload = object(data.payload);
      if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes) throw new ApiError(413, "payload_too_large", "Snapshot is too large.");
      await db.collection("workspaces").doc(workspaceId).collection("snapshots").doc(uid).set({user_id: uid, payload, updated_at: now});
      return {saved: true};
    }
    case "pull_shared_snapshots": {
      const workspaceId = required(data, "workspace_id", 100);
      await workspaceMember(db, uid, workspaceId);
      const rows = await db.collection("workspaces").doc(workspaceId).collection("snapshots").get();
      return rows.docs.map((doc) => ({user_id: doc.get("user_id"), payload: doc.get("payload")}));
    }
    case "attachment_upload_url":
    case "attachment_download_url": {
      const path = await authorizeAttachment(db, uid, data);
      const action = operation === "attachment_upload_url" ? "write" : "read";
      const options: {version: "v4"; action: "write" | "read"; expires: number; contentType?: string} = {version: "v4", action, expires: Date.now() + signedUrlLifetimeMs};
      if (action === "write") options.contentType = required(data, "mime_type", 200);
      const [url] = await getStorage().bucket().file(path).getSignedUrl(options);
      return {url, method: action === "write" ? "PUT" : "GET", headers: action === "write" ? {"Content-Type": options.contentType} : {}};
    }
    case "attachment_delete": {
      const path = await authorizeAttachment(db, uid, data);
      await getStorage().bucket().file(path).delete({ignoreNotFound: true});
      return {deleted: true};
    }
    default:
      throw new ApiError(400, "unsupported_operation", "This provider does not support that operation.");
  }
}

export const sixSigmaApi = onRequest(
  {secrets: [clientKey, setupToken], timeoutSeconds: 60, memory: "512MiB"},
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST.");
      if (!safeEqual(req.get("X-Six-Sigma-Client-Key") ?? "", clientKey.value())) throw new ApiError(401, "invalid_client", "Invalid client key.");
      const body = object(req.body);
      if (body.protocol !== protocol || body.version !== version) throw new ApiError(400, "unsupported_protocol", "Sync Protocol v1 is required.");
      const operation = required(body, "operation", 100);
      if (operation === "capabilities") {
        res.status(200).json({ok: true, data: {protocol, version, personal: true, shared: true, attachments: true, authentication: "firebase-anonymous"}});
        return;
      }
      const uid = await userId(req.get("Authorization") ?? undefined);
      const result = await execute(getFirestore(), operation, object(body.data), uid);
      res.status(200).json({ok: true, data: result});
    } catch (error) {
      const known = error instanceof ApiError ? error : new ApiError(500, "server_error", "The provider could not complete the request.");
      console.error({event: "sync_request_failed", code: known.code, status: known.status});
      res.status(known.status).json({ok: false, code: known.code, error: known.message});
    }
  },
);
