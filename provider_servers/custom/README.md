# Custom HTTPS provider

Implement `provider_protocol/openapi.yaml` when Firebase, Supabase, or the
bundled MySQL gateway is not appropriate. The Flutter app needs one HTTPS POST
endpoint and one mobile-safe public client key.

A conforming provider must:

1. Return Protocol v1 capabilities before authentication.
2. Implement anonymous device identity creation and rotating refresh tokens.
3. Enforce personal-vault and shared-workspace membership on every operation.
4. Bind writes to the authenticated identity instead of trusting `user_id`
   supplied in JSON.
5. Store only hashes of refresh tokens and invitation tokens.
6. Atomically consume invitations so one token cannot be redeemed twice.
7. Return method- and object-scoped attachment URLs that expire within 15
   minutes, or proxy verified bytes through the endpoint.
8. Apply request-size limits, rate limits, secret-redacting logs, backups, and
   tested restore procedures.
9. Never expose database credentials, private signing keys, administrative
   tokens, or other users' refresh tokens to the app.

Use the MySQL server as executable reference behavior even when the underlying
database is PostgreSQL, SQL Server, SQLite, DynamoDB, MongoDB, or another host.
The app's **Test connection** action validates the protocol envelope and device
authentication but does not replace server-side penetration testing.

