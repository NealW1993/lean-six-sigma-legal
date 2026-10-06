# Lean Six Sigma Sync Protocol v1

The Flutter app uses one HTTPS `POST` endpoint for Firebase, MySQL, and custom
providers. Supabase remains a direct REST/RPC integration.

Every request has this envelope:

```json
{
  "protocol": "lean-six-sigma-sync",
  "version": 1,
  "operation": "capabilities",
  "data": {}
}
```

The endpoint requires `Content-Type: application/json` and
`X-Six-Sigma-Client-Key`. All operations except `capabilities`,
`auth_anonymous`, and `auth_refresh` also require
`Authorization: Bearer <short-lived-device-token>`.

Success and failure envelopes are stable:

```json
{"ok":true,"data":{}}
{"ok":false,"code":"forbidden","error":"Workspace membership required."}
```

## Required security properties

- Issue an independent identity and rotating refresh token to every device.
- Store only hashes of refresh tokens and one-time invitation capabilities.
- Authorize every personal operation against active vault membership.
- Authorize every shared operation against active workspace membership.
- Allow only owners to repair ownership or change member permissions.
- Allow invitation creation only to owners or members with `can_invite`.
- Bind each write to the authenticated identity -- for a team record, the
  person that identity acts for -- ignoring any user id a client sends.
- Return file URLs that expire in 15 minutes or less and are scoped to one
  object and HTTP method.
- Never return database passwords, service credentials, private signing keys,
  refresh-token hashes, or another user's refresh token.
- Enforce HTTPS outside loopback development.

## Team records

Team workspaces sync record by record. `pull_shared_records` takes
`{"workspace_id"}` and returns every record the caller may read:
`id`, `kind`, `revision`, `deleted`, `body`, `updatedAt`, and the caller's
`owned`, `editedByMe`, `control`, `canWrite`, and `canDelete`, plus
`"carriedLinks": true` when the server keeps carried links (below).

`push_shared_records` takes `{"workspace_id","changes"}`, where each change is
`{"id","kind","baseRevision","body"}` or `{"id","kind","baseRevision","deleted":true}`,
and answers with the same result as a pull. Apply a push all-or-nothing:

- Refuse it with `409 conflict` when any `baseRevision` is not the record's
  current revision (`0` for a new record).
- Refuse a change the caller may not make, a reply or attachment whose parent
  is not live and readable, an item outside a live project of the workspace,
  or a new link to an item that is not live and readable. A link the record
  already carries stays as it is, so an edit by someone who cannot open the
  linked item does not remove it for teammates who can.
- Strip `userId`, `creatorId`, `isDirty`, `updatedAt`, `authorKey`,
  `authorProof`, `localPath`, `localAttachmentPaths`, and `audioPath` from
  every body, and stamp authorship and the workspace name yourself.

Answer the legacy `push_shared_snapshot` and `pull_shared_snapshots` with
`426 upgrade_required`.

`remove_workspace_member` (`{"workspace_id","member_user_id"}`) is for the
owner only, never removes the owner, and succeeds again for someone already
removed, so a retried revoke completes. `cancel_workspace_invite`
(`{"workspace_id","invite_hash"}`) is for the owner or a member with
`can_invite`, and withdraws only an invitation nobody has redeemed.

The machine-readable operation and schema contract is in `openapi.yaml`.
Reference implementations live in `provider_servers/firebase` and
`provider_servers/mysql`.

