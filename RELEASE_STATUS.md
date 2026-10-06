# Release status: October 6, 2026

This page is not a store release announcement or a security certification.

## Team permissions

Team workspaces use team record protocol 2 on every reference provider. Each
team item is stored on its own, and the provider checks its read, edit, delete
and access-grant permissions for each member before returning or changing it:
Supabase in database functions behind row-level security, Firebase in its Admin
Function, and MySQL in its gateway. App builds that still send whole-workspace
snapshots are refused until they are updated.

A workspace that already holds team snapshots from an earlier version stops
syncing until an administrator reviews that data. A reviewed migration
procedure is not published yet; do not mark a workspace migrated by hand or
delete its snapshots to bypass the check. New workspaces are unaffected.

Before trusting a deployment with restricted records, test it with two
unrelated member identities using the [provider setup](provider-setup.html)
checklist. Permissions cannot recall copies a member has already downloaded,
exported or backed up.

Use the app's coordinated paired-device revocation, which withdraws associated
team invitations/memberships before personal-vault removal. Direct database-only
administration bypasses that workflow and requires separate grant review.

## Changes since September 23

- Server-side item permissions for team workspaces on Supabase, Firebase and
  MySQL.
- The Firebase and MySQL kits remove members and withdraw invitations, so
  paired-device revocation also works there.
- MySQL databases created from the September 16 kit upgrade with
  [`upgrade.sql`](provider_servers/mysql/upgrade.sql).
- Supabase owners run the app's latest SQL + RLS script again after each app
  update.

## Documentation and previews

- [Privacy policy](privacy.html) and [terms](terms.html): effective October 6.
- [Provider setup](provider-setup.html): current providers and team permissions.
- [UI preview](release-preview/2026-09-23/README.md): September 23 captures of
  Windows and mobile, light/dark, plus duo marketing compositions. Fictional
  demo data only; later interface changes are not shown.

Public provider source is a reference kit, not a hosted production deployment.
Publishing documentation or preview images does not deploy a database migration,
update installed apps, upload a store binary, or alter an existing store listing.
Store submissions need signed-build hardware testing, correct publisher identity,
reviewer access and publisher review of privacy disclosures.
