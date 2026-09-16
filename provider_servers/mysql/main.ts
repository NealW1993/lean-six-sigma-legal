import { jwtVerify, SignJWT } from "jose";
import {
  createPool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

const env = (name: string, fallback = ""): string =>
  Deno.env.get(name)?.trim() || fallback;
const port = Number(env("PORT", "8080"));
const publicBaseUrl = env("PUBLIC_BASE_URL").replace(/\/$/, "");
const clientKey = env("SIX_SIGMA_CLIENT_KEY");
const setupToken = env("SIX_SIGMA_SETUP_TOKEN");
const jwtSecretText = env("JWT_SECRET");
const fileRoot = env("FILE_STORAGE_PATH", "./data/files").replace(/[\\/]$/, "");
const jwtSecret = new TextEncoder().encode(jwtSecretText);
const protocol = "lean-six-sigma-sync";
const version = 1;
const accessSeconds = 15 * 60;
const refreshDays = 90;
const maxSnapshotBytes = 12 * 1024 * 1024;
const maxFileBytes = 100 * 1024 * 1024;

for (
  const [name, value] of Object.entries({
    PUBLIC_BASE_URL: publicBaseUrl,
    SIX_SIGMA_CLIENT_KEY: clientKey,
    SIX_SIGMA_SETUP_TOKEN: setupToken,
    JWT_SECRET: jwtSecretText,
    MYSQL_PASSWORD: env("MYSQL_PASSWORD"),
  })
) {
  if (!value || (name === "JWT_SECRET" && value.length < 32)) {
    throw new Error(`Missing or unsafe ${name}.`);
  }
}

const pool = createPool({
  host: env("MYSQL_HOST", "127.0.0.1"),
  port: Number(env("MYSQL_PORT", "3306")),
  database: env("MYSQL_DATABASE", "six_sigma_sync"),
  user: env("MYSQL_USER", "six_sigma_app"),
  password: env("MYSQL_PASSWORD"),
  connectionLimit: 12,
  enableKeepAlive: true,
  timezone: "Z",
});

type Json = Record<string, unknown>;
type Db = typeof pool | PoolConnection;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function value(data: Json, key: string, max = 500, required = true): string {
  const result = String(data[key] ?? "").trim();
  if (result.length > max) {
    throw new ApiError(400, "invalid_input", `${key} is too long.`);
  }
  if (required && !result) {
    throw new ApiError(400, "invalid_input", `${key} is required.`);
  }
  return result;
}

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i++) different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return different === 0;
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const digestInput = Uint8Array.from(bytes).buffer;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput))]
    .map((item) => item.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}

async function accessToken(userId: string): Promise<string> {
  return await new SignJWT({ kind: "device" }).setProtectedHeader({
    alg: "HS256",
  }).setSubject(userId).setIssuer(protocol).setAudience("sync").setIssuedAt()
    .setExpirationTime(`${accessSeconds}s`).sign(jwtSecret);
}

async function session(userId: string, refreshToken: string): Promise<Json> {
  return {
    user_id: userId,
    access_token: await accessToken(userId),
    refresh_token: refreshToken,
    expires_in: accessSeconds,
  };
}

async function authenticate(request: Request): Promise<string> {
  const match = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) {
    throw new ApiError(
      401,
      "missing_identity",
      "A device identity is required.",
    );
  }
  try {
    const verified = await jwtVerify(match[1], jwtSecret, {
      issuer: protocol,
      audience: "sync",
    });
    const userId = verified.payload.sub ?? "";
    if (!userId || verified.payload.kind !== "device") {
      throw new Error("wrong token type");
    }
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM sync_users WHERE id = ? AND revoked_at IS NULL",
      [userId],
    );
    if (rows.length !== 1) throw new Error("revoked identity");
    return userId;
  } catch {
    throw new ApiError(
      401,
      "invalid_identity",
      "The device identity is invalid or expired.",
    );
  }
}

async function one(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<Json | null> {
  const [rows] = await db.execute<RowDataPacket[]>(sql, params);
  return rows.length ? object(rows[0]) : null;
}

async function rows(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<Json[]> {
  const [result] = await db.execute<RowDataPacket[]>(sql, params);
  return result.map(object);
}

async function transaction<T>(
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const parsed = value ? new Date(String(value)) : null;
  return parsed && !Number.isNaN(parsed.valueOf())
    ? parsed.toISOString()
    : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function personalJson(row: Json): Json {
  return {
    user_id: row.user_id,
    vault_id: row.vault_id,
    role: row.role,
    member_role: row.role,
    device_name: row.device_name,
    joined_at: iso(row.joined_at),
    last_seen_at: iso(row.last_seen_at),
  };
}

function workspaceJson(row: Json): Json {
  return {
    user_id: row.user_id,
    role: row.role,
    member_role: row.role,
    can_invite: bool(row.can_invite),
    display_name: row.display_name,
    joined_at: iso(row.joined_at),
  };
}

async function personalMember(
  db: Db,
  userId: string,
  vaultId?: string,
): Promise<Json> {
  const row = await one(
    db,
    "SELECT * FROM personal_members WHERE user_id = ? AND active = TRUE",
    [userId],
  );
  if (!row) {
    throw new ApiError(
      403,
      "not_a_vault_member",
      "Personal vault membership required.",
    );
  }
  if (vaultId && row.vault_id !== vaultId) {
    throw new ApiError(
      403,
      "wrong_vault",
      "This identity belongs to a different vault.",
    );
  }
  return row;
}

async function workspaceMember(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<Json> {
  const row = await one(
    db,
    "SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = TRUE",
    [workspaceId, userId],
  );
  if (!row) {
    throw new ApiError(
      403,
      "not_a_workspace_member",
      "Workspace membership required.",
    );
  }
  return row;
}

function assertSetup(data: Json): void {
  if (!safeEqual(value(data, "setup_token", 500, false), setupToken)) {
    throw new ApiError(
      403,
      "invalid_setup_token",
      "The provider setup token is invalid.",
    );
  }
}

async function createIdentity(): Promise<Json> {
  const userId = crypto.randomUUID();
  const refresh = randomToken();
  await pool.execute(
    "INSERT INTO sync_users (id, refresh_token_hash, refresh_expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? DAY))",
    [userId, await sha256(refresh), refreshDays],
  );
  return await session(userId, refresh);
}

async function refreshIdentity(data: Json): Promise<Json> {
  const prior = value(data, "refresh_token", 2000);
  const priorHash = await sha256(prior);
  const next = randomToken();
  return await transaction(async (db) => {
    const row = await one(
      db,
      "SELECT id FROM sync_users WHERE refresh_token_hash = ? AND revoked_at IS NULL AND refresh_expires_at > UTC_TIMESTAMP(6) FOR UPDATE",
      [priorHash],
    );
    if (!row) {
      throw new ApiError(
        401,
        "refresh_token_used",
        "The refresh token is invalid, expired, or already used.",
      );
    }
    const userId = String(row.id);
    await db.execute(
      "UPDATE sync_users SET refresh_token_hash = ?, refresh_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? DAY) WHERE id = ?",
      [await sha256(next), refreshDays, userId],
    );
    return await session(userId, next);
  });
}

function parsedPayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function execute(
  operation: string,
  data: Json,
  userId: string,
): Promise<unknown> {
  switch (operation) {
    case "initialize_personal_schema":
      return { ready: true };
    case "personal_vault_membership": {
      const row = await one(
        pool,
        "SELECT * FROM personal_members WHERE user_id = ? AND active = TRUE",
        [userId],
      );
      return row ? personalJson(row) : null;
    }
    case "initialize_personal_vault": {
      const vaultId = value(data, "vault_id", 100);
      const deviceName = value(data, "device_name", 120);
      await transaction(async (db) => {
        const member = await one(
          db,
          "SELECT vault_id FROM personal_members WHERE user_id = ? FOR UPDATE",
          [userId],
        );
        if (member && member.vault_id !== vaultId) {
          throw new ApiError(
            409,
            "already_paired",
            "This identity already belongs to another vault.",
          );
        }
        const vault = await one(
          db,
          "SELECT owner_user_id FROM personal_vaults WHERE id = ? FOR UPDATE",
          [vaultId],
        );
        if (vault && vault.owner_user_id !== userId) {
          throw new ApiError(
            409,
            "vault_exists",
            "That vault already has a different owner.",
          );
        }
        if (!vault) {
          await db.execute(
            "INSERT INTO personal_vaults (id, owner_user_id) VALUES (?, ?)",
            [vaultId, userId],
          );
        }
        await db.execute(
          "INSERT INTO personal_members (user_id, vault_id, role, device_name) VALUES (?, ?, 'owner', ?) ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), active = TRUE, last_seen_at = UTC_TIMESTAMP(6)",
          [userId, vaultId, deviceName],
        );
      });
      return personalJson({
        user_id: userId,
        vault_id: vaultId,
        role: "owner",
        device_name: deviceName,
      });
    }
    case "create_personal_invite": {
      const vaultId = value(data, "vault_id", 100);
      const member = await personalMember(pool, userId, vaultId);
      if (member.role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can invite devices.",
        );
      }
      const hash = value(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      }
      await pool.execute(
        "INSERT INTO personal_invites (invite_hash, vault_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
        [hash, vaultId, userId, new Date(value(data, "expires_at", 80))],
      );
      return { created: true };
    }
    case "redeem_personal_invite": {
      const vaultId = value(data, "vault_id", 100);
      const hash = value(data, "invite_hash", 64);
      const deviceName = value(data, "device_name", 120);
      await transaction(async (db) => {
        const invite = await one(
          db,
          "SELECT * FROM personal_invites WHERE invite_hash = ? FOR UPDATE",
          [hash],
        );
        if (
          !invite || invite.vault_id !== vaultId || invite.consumed_at ||
          new Date(String(invite.expires_at)).valueOf() <= Date.now()
        ) {
          throw new ApiError(
            409,
            "invite_invalid",
            "The invitation is invalid, expired, or already used.",
          );
        }
        const member = await one(
          db,
          "SELECT vault_id FROM personal_members WHERE user_id = ? FOR UPDATE",
          [userId],
        );
        if (member && member.vault_id !== vaultId) {
          throw new ApiError(
            409,
            "already_paired",
            "This identity belongs to another vault.",
          );
        }
        await db.execute(
          "INSERT INTO personal_members (user_id, vault_id, role, device_name) VALUES (?, ?, 'member', ?) ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), active = TRUE, role = 'member'",
          [userId, vaultId, deviceName],
        );
        await db.execute(
          "UPDATE personal_invites SET consumed_at = UTC_TIMESTAMP(6), consumed_by = ? WHERE invite_hash = ?",
          [userId, hash],
        );
      });
      return personalJson({
        user_id: userId,
        vault_id: vaultId,
        role: "member",
        device_name: deviceName,
      });
    }
    case "list_personal_devices": {
      const vaultId = value(data, "vault_id", 100);
      if ((await personalMember(pool, userId, vaultId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can list devices.",
        );
      }
      return (await rows(
        pool,
        "SELECT * FROM personal_members WHERE vault_id = ? AND active = TRUE ORDER BY joined_at",
        [vaultId],
      )).map(personalJson);
    }
    case "rename_personal_device": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      await pool.execute(
        "UPDATE personal_members SET device_name = ?, last_seen_at = UTC_TIMESTAMP(6) WHERE user_id = ?",
        [value(data, "device_name", 120), userId],
      );
      return { updated: true };
    }
    case "revoke_personal_device": {
      const vaultId = value(data, "vault_id", 100);
      if ((await personalMember(pool, userId, vaultId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can revoke devices.",
        );
      }
      const target = value(data, "device_user_id", 100);
      if (target === userId) {
        throw new ApiError(
          400,
          "cannot_revoke_owner",
          "The primary device cannot revoke itself.",
        );
      }
      const [result] = await pool.execute(
        "UPDATE personal_members SET active = FALSE, revoked_at = UTC_TIMESTAMP(6) WHERE user_id = ? AND vault_id = ? AND role <> 'owner'",
        [target, vaultId],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new ApiError(404, "device_not_found", "Device not found.");
      }
      return { revoked: true };
    }
    case "touch_personal_device": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      await pool.execute(
        "UPDATE personal_members SET last_seen_at = UTC_TIMESTAMP(6) WHERE user_id = ?",
        [userId],
      );
      return { updated: true };
    }
    case "publish_personal_key_update": {
      const vaultId = value(data, "vault_id", 100);
      if ((await personalMember(pool, userId, vaultId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can transfer keys.",
        );
      }
      const updateId = value(data, "update_id", 64);
      const sealed = value(data, "sealed_keys", 16000);
      const expiresAt = new Date(value(data, "expires_at", 80));
      const latest = Date.now() + 8 * 24 * 60 * 60 * 1000;
      if (
        !/^[0-9a-f]{64}$/.test(updateId) || !sealed.startsWith("pdk1.") ||
        Number.isNaN(expiresAt.valueOf()) ||
        expiresAt.valueOf() <= Date.now() || expiresAt.valueOf() > latest
      ) {
        throw new ApiError(
          400,
          "invalid_key_transfer",
          "Invalid key transfer request.",
        );
      }
      await transaction(async (db) => {
        await db.execute(
          "INSERT INTO personal_key_updates (vault_id, update_id, sealed_keys, created_by, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE update_id = VALUES(update_id), sealed_keys = VALUES(sealed_keys), created_by = VALUES(created_by), created_at = UTC_TIMESTAMP(6), expires_at = VALUES(expires_at)",
          [vaultId, updateId, sealed, userId, expiresAt],
        );
        await db.execute(
          "DELETE FROM personal_key_receipts WHERE vault_id = ?",
          [vaultId],
        );
      });
      return { published: true };
    }
    case "personal_key_update": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      const row = await one(
        pool,
        "SELECT u.update_id, u.sealed_keys, u.created_at, u.expires_at, r.user_id AS received_by FROM personal_key_updates u LEFT JOIN personal_key_receipts r ON r.vault_id = u.vault_id AND r.update_id = u.update_id AND r.user_id = ? WHERE u.vault_id = ? AND u.expires_at > UTC_TIMESTAMP(6)",
        [userId, vaultId],
      );
      return row
        ? {
          update_id: row.update_id,
          sealed_keys: row.sealed_keys,
          created_at: iso(row.created_at),
          expires_at: iso(row.expires_at),
          received: Boolean(row.received_by),
        }
        : null;
    }
    case "confirm_personal_key_update": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      const updateId = value(data, "update_id", 64);
      const waiting = await one(
        pool,
        "SELECT update_id FROM personal_key_updates WHERE vault_id = ? AND update_id = ?",
        [vaultId, updateId],
      );
      if (!waiting) {
        throw new ApiError(
          409,
          "key_transfer_gone",
          "That key transfer is no longer waiting.",
        );
      }
      await pool.execute(
        "INSERT INTO personal_key_receipts (vault_id, user_id, update_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE update_id = VALUES(update_id), received_at = UTC_TIMESTAMP(6)",
        [vaultId, userId, updateId],
      );
      return { confirmed: true };
    }
    case "personal_key_update_status": {
      const vaultId = value(data, "vault_id", 100);
      if ((await personalMember(pool, userId, vaultId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can see key transfers.",
        );
      }
      return (await rows(
        pool,
        "SELECT u.update_id, u.created_at, u.expires_at, r.user_id, r.received_at FROM personal_key_updates u LEFT JOIN personal_key_receipts r ON r.vault_id = u.vault_id AND r.update_id = u.update_id WHERE u.vault_id = ?",
        [vaultId],
      )).map((row) => ({
        update_id: row.update_id,
        created_at: iso(row.created_at),
        expires_at: iso(row.expires_at),
        user_id: row.user_id ?? null,
        received_at: iso(row.received_at),
      }));
    }
    case "cancel_personal_key_update": {
      const vaultId = value(data, "vault_id", 100);
      if ((await personalMember(pool, userId, vaultId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the primary device can cancel a key transfer.",
        );
      }
      await transaction(async (db) => {
        await db.execute(
          "DELETE FROM personal_key_updates WHERE vault_id = ?",
          [vaultId],
        );
        await db.execute(
          "DELETE FROM personal_key_receipts WHERE vault_id = ?",
          [vaultId],
        );
      });
      return { cancelled: true };
    }
    case "push_personal_snapshot": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      const payload = JSON.stringify(object(data.payload));
      if (new TextEncoder().encode(payload).length > maxSnapshotBytes) {
        throw new ApiError(413, "payload_too_large", "Snapshot is too large.");
      }
      await pool.execute(
        "INSERT INTO personal_snapshots (vault_id, user_id, payload) VALUES (?, ?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = UTC_TIMESTAMP(6)",
        [vaultId, userId, payload],
      );
      return { saved: true };
    }
    case "pull_personal_snapshots": {
      const vaultId = value(data, "vault_id", 100);
      await personalMember(pool, userId, vaultId);
      return (await rows(
        pool,
        "SELECT user_id, payload FROM personal_snapshots WHERE vault_id = ?",
        [vaultId],
      )).map((row) => ({
        user_id: row.user_id,
        payload: parsedPayload(row.payload),
      }));
    }
    case "initialize_workspace": {
      assertSetup(data);
      const workspaceId = value(data, "workspace_id", 100);
      const name = value(data, "workspace_name", 200);
      const displayName = value(data, "display_name", 120);
      await transaction(async (db) => {
        const workspace = await one(
          db,
          "SELECT owner_user_id FROM workspaces WHERE id = ? FOR UPDATE",
          [workspaceId],
        );
        if (workspace && workspace.owner_user_id !== userId) {
          throw new ApiError(
            409,
            "owner_exists",
            "This workspace already has another owner.",
          );
        }
        if (!workspace) {
          await db.execute(
            "INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)",
            [workspaceId, name, userId],
          );
        } else {await db.execute(
            "UPDATE workspaces SET name = ? WHERE id = ?",
            [name, workspaceId],
          );}
        await db.execute(
          "INSERT INTO workspace_members (workspace_id, user_id, role, can_invite, display_name) VALUES (?, ?, 'owner', TRUE, ?) ON DUPLICATE KEY UPDATE role = 'owner', can_invite = TRUE, display_name = VALUES(display_name), active = TRUE",
          [workspaceId, userId, displayName],
        );
      });
      return { initialized: true };
    }
    case "repair_workspace_owner": {
      assertSetup(data);
      const workspaceId = value(data, "workspace_id", 100);
      const previous = value(data, "previous_user_id", 100);
      if (value(data, "replacement_user_id", 100) !== userId) {
        throw new ApiError(
          403,
          "identity_mismatch",
          "Replacement identity mismatch.",
        );
      }
      await transaction(async (db) => {
        const workspace = await one(
          db,
          "SELECT owner_user_id FROM workspaces WHERE id = ? FOR UPDATE",
          [workspaceId],
        );
        if (!workspace || workspace.owner_user_id !== previous) {
          throw new ApiError(
            409,
            "owner_changed",
            "The stored owner no longer matches.",
          );
        }
        await db.execute(
          "UPDATE workspaces SET owner_user_id = ? WHERE id = ?",
          [userId, workspaceId],
        );
        await db.execute(
          "UPDATE workspace_members SET active = FALSE, revoked_at = UTC_TIMESTAMP(6) WHERE workspace_id = ? AND user_id = ?",
          [workspaceId, previous],
        );
        await db.execute(
          "INSERT INTO workspace_members (workspace_id, user_id, role, can_invite, display_name) VALUES (?, ?, 'owner', TRUE, ?) ON DUPLICATE KEY UPDATE role = 'owner', can_invite = TRUE, display_name = VALUES(display_name), active = TRUE, revoked_at = NULL",
          [workspaceId, userId, value(data, "display_name", 120)],
        );
      });
      return { repaired: true };
    }
    case "workspace_permissions":
      return workspaceJson(
        await workspaceMember(pool, userId, value(data, "workspace_id", 100)),
      );
    case "set_workspace_display_name": {
      const workspaceId = value(data, "workspace_id", 100);
      await workspaceMember(pool, userId, workspaceId);
      await pool.execute(
        "UPDATE workspace_members SET display_name = ? WHERE workspace_id = ? AND user_id = ?",
        [value(data, "display_name", 120), workspaceId, userId],
      );
      return { updated: true };
    }
    case "create_workspace_invite": {
      const workspaceId = value(data, "workspace_id", 100);
      const member = await workspaceMember(pool, userId, workspaceId);
      if (member.role !== "owner" && !bool(member.can_invite)) {
        throw new ApiError(
          403,
          "invite_forbidden",
          "Invitation permission required.",
        );
      }
      const hash = value(data, "invite_hash", 64);
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        throw new ApiError(400, "invalid_hash", "Invalid invitation hash.");
      }
      await pool.execute(
        "INSERT INTO workspace_invites (invite_hash, workspace_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
        [hash, workspaceId, userId, new Date(value(data, "expires_at", 80))],
      );
      return { created: true };
    }
    case "redeem_workspace_invite": {
      const workspaceId = value(data, "workspace_id", 100);
      const hash = value(data, "invite_hash", 64);
      await transaction(async (db) => {
        const invite = await one(
          db,
          "SELECT * FROM workspace_invites WHERE invite_hash = ? FOR UPDATE",
          [hash],
        );
        if (
          !invite || invite.workspace_id !== workspaceId ||
          invite.consumed_at ||
          new Date(String(invite.expires_at)).valueOf() <= Date.now()
        ) {
          throw new ApiError(
            409,
            "invite_invalid",
            "The invitation is invalid, expired, or already used.",
          );
        }
        await db.execute(
          "INSERT INTO workspace_members (workspace_id, user_id, role, can_invite, display_name) VALUES (?, ?, 'member', FALSE, 'Member') ON DUPLICATE KEY UPDATE active = TRUE, role = 'member', can_invite = FALSE, revoked_at = NULL",
          [workspaceId, userId],
        );
        await db.execute(
          "UPDATE workspace_invites SET consumed_at = UTC_TIMESTAMP(6), consumed_by = ? WHERE invite_hash = ?",
          [userId, hash],
        );
      });
      return { role: "member", can_invite: false };
    }
    case "list_workspace_members": {
      const workspaceId = value(data, "workspace_id", 100);
      if ((await workspaceMember(pool, userId, workspaceId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the owner can list members.",
        );
      }
      return (await rows(
        pool,
        "SELECT * FROM workspace_members WHERE workspace_id = ? AND active = TRUE ORDER BY joined_at",
        [workspaceId],
      )).map(workspaceJson);
    }
    case "set_member_invite_permission": {
      const workspaceId = value(data, "workspace_id", 100);
      if ((await workspaceMember(pool, userId, workspaceId)).role !== "owner") {
        throw new ApiError(
          403,
          "owner_required",
          "Only the owner can change permissions.",
        );
      }
      const [result] = await pool.execute(
        "UPDATE workspace_members SET can_invite = ? WHERE workspace_id = ? AND user_id = ? AND active = TRUE AND role = 'member'",
        [
          data.can_invite === true,
          workspaceId,
          value(data, "member_user_id", 100),
        ],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new ApiError(404, "member_not_found", "Member not found.");
      }
      return { updated: true };
    }
    case "push_shared_snapshot": {
      const workspaceId = value(data, "workspace_id", 100);
      await workspaceMember(pool, userId, workspaceId);
      const payload = JSON.stringify(object(data.payload));
      if (new TextEncoder().encode(payload).length > maxSnapshotBytes) {
        throw new ApiError(413, "payload_too_large", "Snapshot is too large.");
      }
      await pool.execute(
        "INSERT INTO shared_snapshots (workspace_id, user_id, payload) VALUES (?, ?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = UTC_TIMESTAMP(6)",
        [workspaceId, userId, payload],
      );
      return { saved: true };
    }
    case "pull_shared_snapshots": {
      const workspaceId = value(data, "workspace_id", 100);
      await workspaceMember(pool, userId, workspaceId);
      return (await rows(
        pool,
        "SELECT user_id, payload FROM shared_snapshots WHERE workspace_id = ?",
        [workspaceId],
      )).map((row) => ({
        user_id: row.user_id,
        payload: parsedPayload(row.payload),
      }));
    }
    case "attachment_upload_url":
    case "attachment_download_url": {
      const claims = await attachmentClaims(data, userId);
      const method = operation === "attachment_upload_url" ? "PUT" : "GET";
      const token = await new SignJWT({ ...claims, kind: "file", method })
        .setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(
          protocol,
        ).setAudience("file").setIssuedAt().setExpirationTime("10m").sign(
          jwtSecret,
        );
      return {
        url: `${publicBaseUrl}/files?token=${encodeURIComponent(token)}`,
        method,
        headers: method === "PUT" ? { "Content-Type": claims.mime_type } : {},
      };
    }
    case "attachment_delete": {
      const claims = await attachmentClaims(data, userId);
      try {
        await Deno.remove(localFile(String(claims.storage_path)));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      return { deleted: true };
    }
    default:
      throw new ApiError(
        400,
        "unsupported_operation",
        "This provider does not support that operation.",
      );
  }
}

async function attachmentClaims(data: Json, userId: string): Promise<Json> {
  const scope = value(data, "scope", 20);
  const scopeId = value(data, "scope_id", 100);
  const id = value(data, "id", 100);
  const storagePath = value(data, "storage_path", 1000);
  if (
    (scope !== "personal" && scope !== "shared") ||
    !storagePath.startsWith(`${scope}/${scopeId}/${id}/`) ||
    storagePath.includes("..") || storagePath.includes("\\")
  ) throw new ApiError(400, "invalid_path", "The attachment path is invalid.");
  if (scope === "personal") await personalMember(pool, userId, scopeId);
  else await workspaceMember(pool, userId, scopeId);
  const size = Number(data.size_bytes);
  const digest = value(data, "sha256", 64);
  if (
    !Number.isSafeInteger(size) || size < 1 || size > maxFileBytes ||
    !/^[0-9a-f]{64}$/i.test(digest)
  ) {
    throw new ApiError(
      400,
      "invalid_manifest",
      "The attachment manifest is invalid.",
    );
  }
  return {
    scope,
    scope_id: scopeId,
    storage_path: storagePath,
    size_bytes: size,
    sha256: digest.toLowerCase(),
    mime_type: value(data, "mime_type", 200),
  };
}

function localFile(storagePath: string): string {
  if (
    !/^(personal|shared)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9._ -]+$/
      .test(storagePath)
  ) throw new ApiError(400, "invalid_path", "The attachment path is invalid.");
  return `${fileRoot}/${storagePath}`;
}

async function fileRequest(request: Request, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  let verified;
  try {
    verified = await jwtVerify(token, jwtSecret, {
      issuer: protocol,
      audience: "file",
    });
  } catch {
    return jsonResponse(401, {
      ok: false,
      code: "invalid_file_token",
      error: "The file link is invalid or expired.",
    });
  }
  try {
    const claims = object(verified.payload);
    if (
      claims.kind !== "file" || claims.method !== request.method ||
      !verified.payload.sub
    ) throw new Error("invalid file token");
    const scope = String(claims.scope);
    const scopeId = String(claims.scope_id);
    if (scope === "personal") {
      await personalMember(pool, verified.payload.sub, scopeId);
    } else await workspaceMember(pool, verified.payload.sub, scopeId);
    const path = localFile(String(claims.storage_path));
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (
        bytes.length !== Number(claims.size_bytes) ||
        await sha256(bytes) !== claims.sha256
      ) {
        throw new ApiError(
          400,
          "file_verification_failed",
          "File size or SHA-256 did not match the manifest.",
        );
      }
      await Deno.mkdir(path.substring(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(path, bytes, { create: true });
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method === "GET") {
      const bytes = await Deno.readFile(path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": String(claims.mime_type),
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
        },
      });
    }
    throw new ApiError(405, "method_not_allowed", "Use GET or PUT.");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return jsonResponse(404, {
        ok: false,
        code: "file_not_found",
        error: "File not found.",
      });
    }
    if (error instanceof ApiError) {
      return jsonResponse(error.status, {
        ok: false,
        code: error.code,
        error: error.message,
      });
    }
    console.error(JSON.stringify({ code: "file_storage_failure" }));
    return jsonResponse(500, {
      ok: false,
      code: "file_storage_failure",
      error: "The file store could not complete the request.",
    });
  }
}

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return jsonResponse(200, { ok: true });
  if (url.pathname === "/files") return await fileRequest(request, url);
  if (url.pathname !== "/api") {
    return jsonResponse(404, {
      ok: false,
      code: "not_found",
      error: "Not found.",
    });
  }
  try {
    if (request.method !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Use POST.");
    }
    if (
      !safeEqual(request.headers.get("x-six-sigma-client-key") ?? "", clientKey)
    ) throw new ApiError(401, "invalid_client", "Invalid client key.");
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxSnapshotBytes + 1024 * 1024) {
      throw new ApiError(413, "request_too_large", "Request is too large.");
    }
    const body = object(await request.json());
    if (body.protocol !== protocol || body.version !== version) {
      throw new ApiError(
        400,
        "unsupported_protocol",
        "Sync Protocol v1 is required.",
      );
    }
    const operation = value(body, "operation", 100);
    if (operation === "capabilities") {
      return jsonResponse(200, {
        ok: true,
        data: {
          protocol,
          version,
          personal: true,
          shared: true,
          attachments: true,
          authentication: "rotating-device-jwt",
        },
      });
    }
    if (operation === "auth_anonymous") {
      return jsonResponse(200, { ok: true, data: await createIdentity() });
    }
    if (operation === "auth_refresh") {
      return jsonResponse(200, {
        ok: true,
        data: await refreshIdentity(object(body.data)),
      });
    }
    const userId = await authenticate(request);
    const result = await execute(operation, object(body.data), userId);
    return jsonResponse(200, { ok: true, data: result });
  } catch (error) {
    const known = error instanceof ApiError ? error : new ApiError(
      500,
      "server_error",
      "The provider could not complete the request.",
    );
    console.error(
      JSON.stringify({
        event: "sync_request_failed",
        code: known.code,
        status: known.status,
      }),
    );
    return jsonResponse(known.status, {
      ok: false,
      code: known.code,
      error: known.message,
    });
  }
});
