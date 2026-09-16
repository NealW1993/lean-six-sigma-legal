const baseUrl = Deno.env.get("QC_BASE_URL")?.replace(/\/$/, "") ?? "";
const clientKey = Deno.env.get("QC_CLIENT_KEY") ?? "";
const setupToken = Deno.env.get("QC_SETUP_TOKEN") ?? "";

type Json = Record<string, unknown>;
type Session = { user_id: string; access_token: string; refresh_token: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes).buffer;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

async function api(
  operation: string,
  data: Json = {},
  session?: Session,
  expectedStatus = 200,
  key = clientKey,
): Promise<Json> {
  const response = await fetch(`${baseUrl}/api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Six-Sigma-Client-Key": key,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({
      protocol: "lean-six-sigma-sync",
      version: 1,
      operation,
      data,
    }),
  });
  const body = await response.json() as Json;
  check(
    response.status === expectedStatus,
    `${operation}: expected HTTP ${expectedStatus}, got ${response.status}: ${
      JSON.stringify(body)
    }`,
  );
  return body;
}

function sessionFrom(response: Json): Session {
  const data = response.data as Json;
  const result = {
    user_id: String(data.user_id ?? ""),
    access_token: String(data.access_token ?? ""),
    refresh_token: String(data.refresh_token ?? ""),
  };
  check(
    Object.values(result).every(Boolean),
    "provider returned an incomplete session",
  );
  return result;
}

async function anonymous(): Promise<Session> {
  return sessionFrom(await api("auth_anonymous"));
}

Deno.test({
  name: "MySQL gateway isolates identities, vaults, workspaces, and files",
  ignore: !baseUrl || !clientKey || !setupToken,
  fn: async () => {
    const health = await fetch(`${baseUrl}/health`);
    check(health.ok, "gateway health check failed");
    await api("capabilities", {}, undefined, 401, "wrong-client-key");

    const owner = await anonymous();
    const member = await anonymous();
    const outsider = await anonymous();
    const vaultId = `vault-${crypto.randomUUID()}`;
    const otherVaultId = `vault-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await api("initialize_personal_vault", {
      vault_id: vaultId,
      device_name: "Owner phone",
    }, owner);
    await api("push_personal_snapshot", {
      vault_id: vaultId,
      payload: {
        projects: [{
          id: "private-project",
          name: "Owner only before pairing",
        }],
      },
    }, owner);
    await api("pull_personal_snapshots", { vault_id: vaultId }, member, 403);
    await api("initialize_personal_vault", {
      vault_id: otherVaultId,
      device_name: "Unrelated device",
    }, outsider);
    await api("pull_personal_snapshots", { vault_id: vaultId }, outsider, 403);

    const personalInvite = await digest(
      new TextEncoder().encode(crypto.randomUUID()),
    );
    await api("create_personal_invite", {
      vault_id: vaultId,
      invite_hash: personalInvite,
      expires_at: expiresAt,
    }, owner);
    await api("redeem_personal_invite", {
      vault_id: vaultId,
      invite_hash: personalInvite,
      device_name: "Paired Windows PC",
    }, member);
    await api(
      "redeem_personal_invite",
      {
        vault_id: vaultId,
        invite_hash: personalInvite,
        device_name: "Replay device",
      },
      outsider,
      409,
    );
    const personalPull = await api("pull_personal_snapshots", {
      vault_id: vaultId,
    }, member);
    check(
      JSON.stringify(personalPull).includes("private-project"),
      "paired member could not read the vault",
    );

    const oldRefresh = owner.refresh_token;
    const refreshed = sessionFrom(
      await api("auth_refresh", { refresh_token: oldRefresh }),
    );
    check(
      refreshed.user_id === owner.user_id,
      "refresh changed device identity",
    );
    await api("auth_refresh", { refresh_token: oldRefresh }, undefined, 401);

    const workspaceId = `workspace-${crypto.randomUUID()}`;
    await api("initialize_workspace", {
      setup_token: setupToken,
      workspace_id: workspaceId,
      workspace_name: "Quality Team",
      display_name: "Owner",
    }, refreshed);
    await api(
      "pull_shared_snapshots",
      { workspace_id: workspaceId },
      member,
      403,
    );
    const workspaceInvite = await digest(
      new TextEncoder().encode(crypto.randomUUID()),
    );
    await api("create_workspace_invite", {
      workspace_id: workspaceId,
      invite_hash: workspaceInvite,
      expires_at: expiresAt,
    }, refreshed);
    await api("redeem_workspace_invite", {
      workspace_id: workspaceId,
      invite_hash: workspaceInvite,
    }, member);
    await api(
      "redeem_workspace_invite",
      {
        workspace_id: workspaceId,
        invite_hash: workspaceInvite,
      },
      outsider,
      409,
    );
    await api("push_shared_snapshot", {
      workspace_id: workspaceId,
      payload: { notes: [{ id: "team-note", body: "authorized team data" }] },
    }, member);
    const sharedPull = await api("pull_shared_snapshots", {
      workspace_id: workspaceId,
    }, refreshed);
    check(
      JSON.stringify(sharedPull).includes("team-note"),
      "owner could not read member work",
    );
    await api(
      "create_workspace_invite",
      {
        workspace_id: workspaceId,
        invite_hash: await digest(
          new TextEncoder().encode(`denied-${crypto.randomUUID()}`),
        ),
        expires_at: expiresAt,
      },
      member,
      403,
    );
    await api("set_member_invite_permission", {
      workspace_id: workspaceId,
      member_user_id: member.user_id,
      can_invite: true,
    }, refreshed);
    await api("create_workspace_invite", {
      workspace_id: workspaceId,
      invite_hash: await digest(
        new TextEncoder().encode(`allowed-${crypto.randomUUID()}`),
      ),
      expires_at: expiresAt,
    }, member);

    const bytes = new TextEncoder().encode("cross-device evidence");
    const sha256 = await digest(bytes);
    const attachment = {
      scope: "personal",
      scope_id: vaultId,
      id: "attachment-1",
      storage_path: `personal/${vaultId}/attachment-1/evidence.txt`,
      size_bytes: bytes.length,
      sha256,
      mime_type: "text/plain",
    };
    const upload = (await api("attachment_upload_url", attachment, refreshed))
      .data as Json;
    const uploadResponse = await fetch(String(upload.url), {
      method: String(upload.method),
      headers: upload.headers as HeadersInit,
      body: bytes,
    });
    check(
      uploadResponse.status === 204,
      `verified attachment upload failed: HTTP ${uploadResponse.status} ${await uploadResponse
        .text()}`,
    );

    const tampered = new TextEncoder().encode("tampered evidence bytes");
    const secondUpload = (await api("attachment_upload_url", {
      ...attachment,
      id: "attachment-2",
      storage_path: `personal/${vaultId}/attachment-2/evidence.txt`,
    }, refreshed)).data as Json;
    const tamperedResponse = await fetch(String(secondUpload.url), {
      method: String(secondUpload.method),
      headers: secondUpload.headers as HeadersInit,
      body: tampered,
    });
    check(
      tamperedResponse.status === 400,
      `tampered attachment was accepted: HTTP ${tamperedResponse.status}`,
    );

    const download = (await api("attachment_download_url", attachment, member))
      .data as Json;
    const downloaded = new Uint8Array(
      await (await fetch(String(download.url))).arrayBuffer(),
    );
    check(
      await digest(downloaded) === sha256,
      "downloaded attachment digest changed",
    );

    await api("revoke_personal_device", {
      vault_id: vaultId,
      device_user_id: member.user_id,
    }, refreshed);
    const revokedDownload = await fetch(String(download.url));
    check(
      revokedDownload.status === 403,
      "revoked member reused a signed file URL",
    );
    await api("pull_personal_snapshots", { vault_id: vaultId }, member, 403);
  },
});
