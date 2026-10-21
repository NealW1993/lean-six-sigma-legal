# Release status: October 21, 2026

This page is not a store release announcement or a security certification.

## Team permissions

Current reference-provider source implements team record protocol 2. Each
team item is stored on its own, and the provider checks its read, edit, delete
and access-grant permissions for each member before returning or changing it:
Supabase in database functions behind row-level security, Firebase in its Admin
Function, and MySQL in its gateway. App builds that still send whole-workspace
snapshots are refused until they are updated. These protections require a
matching, deployed server; publishing source does not update a running service.

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

- [Privacy policy](privacy.html) and [terms](terms.html): effective October 21.
- [Provider setup](provider-setup.html): current providers and team permissions.
- [Current UI preview](release-preview/2026-10-21/index.html): October 21
  current-widget captures of Windows and Android layouts in light/dark, plus
  duo marketing compositions. Fictional data only. Verify parity with the
  signed release before using images in a store listing.
- [Historical September preview](release-preview/2026-09-23/README.md): retained
  as a dated record, not the current UI.

## October 21 verification

The app repository's final Flutter run passed 2,958 tests with 33 opt-in cases
skipped; analysis reported no issues. Separate runs passed 25 real PostgreSQL
authorization cases, 28 shared TypeScript permission tests, and the disposable
MySQL HTTP/database integration. Firebase builds on Node 22 and its production
dependency audit reports no known vulnerabilities after dependency patches.
The shared authorization fix prevents a member from unpinning an owner's
topic and avoids treating JSON property order as an access-grant change.

These results do not certify a hosted deployment or authorize store release.
Firebase adversarial deployment/emulator testing, a reviewed legacy migration,
signed-client upgrade/revocation tests and production store configuration remain
release gates. Android debug ARM64 16 KB alignment checks passed, but the final
signed AAB, Windows MSIX/WACK and native iOS archive still need validation.

Documentation now distinguishes credential encryption from work-data
encryption (the app does not add end-to-end encryption to work records), notes
signed attachment URL expiry, and clarifies that uninstalling does not erase
remote copies. The setup guide identifies the correct Supabase work-data
project, private bucket setting, and Firebase Blaze billing prerequisite.

Public provider source is a reference kit, not a hosted production deployment.
Publishing documentation or preview images does not deploy a database migration,
update installed apps, upload a store binary, or alter an existing store listing.
Store submissions need signed-build hardware testing, correct publisher identity,
reviewer access and publisher review of privacy disclosures.
