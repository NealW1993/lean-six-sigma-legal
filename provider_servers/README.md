# Lean Six Sigma Toolbox provider server kits

These sources let an administrator host Personal Connection and Team Workspace
sync for the app. They are not a managed service or a guarantee of production
security. Keep a tested backup and validate authorization on a staging instance
before storing real work.

## Restricted-team release blocker (September 23, 2026)

The snapshot implementations authorize vault/workspace membership, but do not
independently enforce item-level read, edit, delete or access-grant permissions
inside JSON payloads. App-side checks are not a security boundary against a
modified client or an untrusted team member. Do not deploy these kits for
sensitive records requiring isolation between members. Server-authoritative
item permissions and adversarial integration coverage are still required.

Personal-vault access, team membership and outstanding team invitations are
separate grants. Use the app's coordinated paired-device revocation. Direct
database-only personal-vault removal does not cancel all team access; review
and revoke the relevant memberships and invitations separately when administering
providers manually.

## Choose a provider

- [Supabase](supabase/README.md): use the app's complete SQL + RLS script for
  Personal Connection or Team Workspaces. No separate gateway server is needed.
- [Firebase](firebase/README.md): Anonymous Auth plus an HTTPS Cloud Function,
  Firestore and private Cloud Storage. Deploy the function and both rule sets.
- [MySQL](mysql/README.md): Deno gateway and a private MySQL database, behind
  your HTTPS reverse proxy. Never expose port 3306 to app clients.
- [Custom HTTPS](custom/README.md): implement the [protocol](../provider_protocol/README.md)
  and its [OpenAPI contract](../provider_protocol/openapi.yaml).

Read the [provider setup guide](https://nealw1993.github.io/lean-six-sigma-legal/provider-setup.html)
for the app-side steps. Download this repository's ZIP or clone it, then work
inside the selected kit directory. Example configuration files contain only
placeholders. Generate your own values; never publish populated `.env`,
`.firebaserc`, service-account files, signing keys, or database dumps.

## Before pairing

1. Deploy the complete schema, authorization layer and private file storage.
2. Configure the app endpoint and public client key; complete owner setup with
   the separate setup token when required. Test the connection.
3. Pair two test devices and verify an edit in both directions.
4. Test non-member denial, role restrictions, one-time invite redemption,
   refresh-token rotation, and revoked-device access.
5. Test an upgrade and restore independently of production. Revocation cannot
   retrieve files already downloaded or instantly cancel every signed URL.

The app source, publisher entitlement backend, production secrets, and user
data are not included in this public kit. Dependency licenses remain those of
their respective authors. Publishing these reference files does not transfer
ownership of the app or its branding.
