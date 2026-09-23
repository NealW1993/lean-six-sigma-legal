# Release status: September 23, 2026

The current release candidate is **not approved for restricted-team production
use**. This page is not a store release announcement or a security certification.

## Team authorization limitation

Reference snapshot services enforce authenticated vault/workspace membership.
They do not independently enforce item-level read, edit, delete and access-grant
settings within synchronized JSON payloads. App-side permission controls are
not a secure boundary against modified clients or untrusted team members.
Do not deploy sensitive records requiring isolation between team members until
server-authoritative item authorization and cross-provider tests are complete.

Use the app's coordinated paired-device revocation, which withdraws associated
team invitations/memberships before personal-vault removal. Direct database-only
administration bypasses that workflow and requires separate grant review.

## Documentation and previews

- [Privacy policy](privacy.html) and [terms](terms.html): effective September 23.
- [Provider setup](provider-setup.html): current providers and access limitations.
- [Current UI preview](release-preview/2026-09-23/README.md): Windows and mobile,
  light/dark, plus duo marketing compositions. Fictional demo data only.

Public provider source is a reference kit, not a hosted production deployment.
Publishing documentation or preview images does not deploy a database migration,
update installed apps, upload a store binary, or alter an existing store listing.
Store submissions need signed-build hardware testing, correct publisher identity,
reviewer access and publisher review of privacy disclosures.
