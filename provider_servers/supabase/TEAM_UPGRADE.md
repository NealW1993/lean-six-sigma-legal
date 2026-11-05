# Team database upgrade

## Which project?

This is for the Supabase project whose URL is saved in **Team Workspaces**.
It is not a publisher licensing migration and not a Personal Connection
migration. Anonymous Auth is still used: each installation has an authenticated
identity, and the server checks its membership and item permissions.

If your publisher project only verifies Pro/connected-device licenses, leave
it alone. If you deliberately also store team data there, those team tables
need this upgrade. Separate projects are preferable. Firebase, MySQL and Custom
HTTPS need their own server updates; this PostgreSQL script does not fix them.

## Identify, back up, upgrade

1. In Settings > Team Workspaces > database resources, use **Check team schema**.
   Copy the read-only query into the intended project's Supabase SQL Editor.
   `team_tables_present = false` means the default team schema is absent, not
   that you should install it into a publisher-only database. Custom table
   installations need an administrator to check their corresponding tables.
2. Back up the team database, private Storage files and device-local app data.
   Use a staging copy first. Pause team sync on all devices during the upgrade.
3. In the same settings section choose **View full SQL + RLS**, then **Copy SQL**.
   Run the entire script as the SQL Editor's database administrator in the team
   data project. Re-running it preserves records and installs current functions
   and policies. Never use `provider_servers/mysql/schema.sql` in Supabase.
4. Keep Anonymous Sign-Ins enabled. Keep `six-sigma-shared-files` private
   (**Public bucket off**), with the supplied policies. Do not add allow-all
   policies, give clients service keys, or disable RLS to make a test pass.
5. Run the read-only check again. All four booleans should now be true, but this
   is only a structural check, not proof of function contents or security.
6. Run this administrator-only inventory:

```sql
select w.id, w.name,
       (select count(*) from public.six_sigma_shared_snapshots s
        where s.workspace_id=w.id) as legacy_snapshots,
       (select count(*) from private.six_sigma_team_records r
        where r.workspace_id=w.id) as protocol_2_records,
       exists(select 1 from private.six_sigma_team_migrations m
              where m.workspace_id=w.id) as reviewed_migration
from public.six_sigma_shared_snapshots_workspaces w
order by w.name, w.id;
```

Fresh workspaces with **zero legacy snapshots** need no data migration. Update
every client, test connection, and run the role tests below. Existing protocol 2
workspaces keep their records. Only workspaces with old snapshots and no
reviewed migration need the next section.

Developers can export the exact scripts without opening the app:

```powershell
dart run tool/export_team_sql.dart
```

This writes `build/provider_sql/team_check.sql` and `team_setup.sql`, generated
from the same source as Settings. It does not connect to any database.

## Recover an old workspace

This is a **database-administrator review**, not a one-click client migration.
Old JSON did not reliably establish ownership or grants. Selecting the newest
snapshot or copying its access flags automatically would recreate that flaw.
Ask the database administrator for help with this section.

1. Replace `WORKSPACE_ID` below with the inventory's exact `id`. Export **all**
   returned payloads into a secure local backup, not a public repository or bug
   report. Retain the fingerprint from the same review session.

```sql
select private.six_sigma_legacy_team_fingerprint('WORKSPACE_ID') as fingerprint;
select user_id, updated_at, payload
from public.six_sigma_shared_snapshots
where workspace_id='WORKSPACE_ID'
order by user_id;
```

2. Compare versions of each item with the workspace owner's known-good local
   backup. Resolve duplicate IDs, conflicting versions and tombstones/deletions.
   Do not recover a deleted item merely because an older snapshot contains it.
   Do not trust JSON `creatorId`, `userId`, `access` or authorship proofs.
3. Assemble a reviewed JSON array with **one entry per retained item**:
   `{"id":"EXISTING_ID","kind":"notes","body":{...complete original body...}}`.
   Keep original IDs so links work. Include referenced projects, topic parents,
   linked items and attachment manifests, or resolve those links deliberately.
   Allowed kinds are `projects`, `notes`, `meetings`, `fishbones`, `calculations`,
   `dataSets`, `fmeaSheets`, `sipocs`, `topics`, `topicComments`, `syncedAttachments`.
   Review attachment paths and actual file bytes/digests against the private
   Storage backup. The SQL validates the manifest, not the bytes in Storage.
4. **Projects, topics and topic comments are shared by design.** Review their
   text and linked metadata for sensitive content. Attachments inherit their
   parent's access. The seven ordinary item families are recovered as private
   items controlled by the registered workspace owner. Original item authorship
   cannot be proven; it remains in the quarantined backup, not as a server grant.
5. Execute this template only after replacing both placeholders. The placeholder
   JSON deliberately fails validation; it must not create example work in a
   real workspace. The fingerprint must be the value captured at review time,
   **not a fresh function call embedded in the import**.

```sql
begin;
select private.six_sigma_import_reviewed_team_records(
  'WORKSPACE_ID',
  'PASTE_PREVIOUSLY_REVIEWED_FINGERPRINT',
  $review$ REPLACE_WITH_REVIEWED_JSON_ARRAY $review$::jsonb,
  'REVIEWED_CONTENT_AND_SHARED_PROJECTS_TOPICS'
);
commit;
```

The helper rejects changed source snapshots, empty/malformed input, duplicate
IDs, missing references, invalid file manifests, and any workspace that already
has protocol 2 records or a migration marker. A failed import rolls back both
records and the marker. The registered owner is assigned on the server, not
from the payload. The original snapshots are retained with no app API access.
The audit row records hashes, count, SQL administrator and recovery owner.
Imports over 2,000 records or 12 MiB need a separately reviewed migration plan;
do not split batches or bypass the guard. An intentionally empty workspace
should be replaced with a new workspace while retaining the old backup.

6. Refresh the owner's updated app. Inspect recovered data, then explicitly
   grant the desired access using the app. Do not copy old JSON grants back in
   bulk. Check attachments, notes, meetings, tools, calculations and data sets.
   Unselected snapshot versions stay quarantined; they are not merged later.

## Verify before enabling a team

Use at least an owner, a non-owner member and an unrelated identity:

- Private item bodies, notifications and files must not reach the member.
- A member cannot edit/delete a denied item or grant themselves permission by
  changing JSON, `creatorId`, `userId`, or the requested record revision.
- An allowed edit syncs both directions; a stale edit conflicts, not overwrites.
- Removing a member blocks subsequent reads and writes. Use the app's coordinated
  device revocation when Personal Connection and teams live on separate servers.
- Old snapshot endpoints and direct record-table access remain blocked.
- Personal Connection pairing and publisher Pro verification still work.

Revocation cannot erase copies someone already downloaded. Local PostgreSQL
tests are not proof that a hosted project or a store-signed client was upgraded.
Do not treat a packaging override as security clearance or store approval.
