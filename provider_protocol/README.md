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
- Bind each snapshot write to the authenticated user, ignoring any conflicting
  user id sent by a client.
- Return file URLs that expire in 15 minutes or less and are scoped to one
  object and HTTP method.
- Never return database passwords, service credentials, private signing keys,
  refresh-token hashes, or another user's refresh token.
- Enforce HTTPS outside loopback development.

The machine-readable operation and schema contract is in `openapi.yaml`.
Reference implementations live in `provider_servers/firebase` and
`provider_servers/mysql`.

