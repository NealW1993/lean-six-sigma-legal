# MySQL sync provider

The app never connects to MySQL directly. This Deno HTTPS gateway owns the
database credentials, issues independent device identities, enforces personal
vault/workspace membership, and provides short-lived attachment links.

## Production setup

1. Copy `.env.example` to `.env` and generate unique random values for every
   secret. Copy `SIX_SIGMA_CLIENT_KEY` into the app; the separate
   `SIX_SIGMA_SETUP_TOKEN` is also entered temporarily for owner initialization.
   Database passwords and `JWT_SECRET` never go into the app.
2. Run `docker compose up -d --build`. The MySQL container executes
   `schema.sql` only when its data volume is first created.
3. Put port 8080 behind an HTTPS reverse proxy such as Caddy, nginx, or your
   managed container platform. Keep MySQL port 3306 private.
4. Add request-size limits (at least 13 MB for snapshots and 100 MB for files),
   rate limiting, access logs that redact `Authorization`, and automated DB/file
   backups.
5. In the app choose **MySQL server**, paste `https://your-host/api`,
   `SIX_SIGMA_CLIENT_KEY`, and the setup token for first owner initialization.
6. Run `deno task check` and the repository provider tests before deployment.

For a live staging security test, set `QC_BASE_URL`, `QC_CLIENT_KEY`, and
`QC_SETUP_TOKEN` to the deployed gateway values and run
`deno task test:integration`. The test creates disposable identities and scopes
to verify cross-vault denial, workspace roles, one-time invites, refresh-token
rotation, attachment digests, and file-link revocation.

Use a dedicated DB user limited to this database. Rotate `JWT_SECRET` only with
a migration plan because it invalidates all device sessions. Rotating the client
key requires updating every connected app. The setup token may be rotated after
owners are provisioned.

## Existing installations

An existing Docker volume does **not** rerun `schema.sql` when the image is
rebuilt. Back up the database and file volume, compare the schema changes,
apply the required changes in staging, and run the integration tests before
upgrading production. Do not delete the volume to apply an upgrade.

## Pairing checklist

In Settings > Connections, save and test the Personal Connection before
creating an encrypted invitation. Verify a two-device sync, owner-only member
management, denial for an unrelated identity, and revoked-device denial.
Keep the setup token separate from the public client key and invitation
passphrase. Record the deployed kit version with each backup.
