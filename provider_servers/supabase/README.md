# Supabase setup

Supabase is a supported provider for Personal Connection and Team Workspaces.
It does **not** need the Firebase Cloud Function or MySQL/Deno gateway from
the other folders. The app uses Supabase Auth, its database REST/RPC API,
PostgreSQL row-level security (RLS), and private Storage policies directly.

## Get the correct SQL

Use the complete SQL + RLS script shown by your installed app for the selected
connection scope. A generic SQL snapshot here could drift from the app's
schema, table names and owner-setup requirements. This folder is a setup guide,
not a second copy of those scripts.

1. Create a Supabase project and enable **Anonymous Sign-Ins** in Authentication.
2. In the app, open **Settings > Personal Connection** for your own connected
   devices, or **Settings > Team Workspaces** for a permission-controlled team.
   Choose Supabase and open that connection's provider setup / SQL + RLS action.
3. Copy the **complete initial SQL + RLS** script for that scope. In Supabase
   SQL Editor, check the Database dropdown and choose **Row limit > No limit**
   if displayed results are currently limited. That setting controls displayed
   query results, not RLS or app access permissions.
4. Check that you are in the intended project, then run the entire script.
   Resolve any SQL errors before continuing. Do not run only the table-creation
   part or disable RLS to bypass a setup error.
5. Enter the Project URL / table endpoint shown by the app and a publishable
   (`sb_publishable_...`) or legacy anon key. Never enter a `service_role` key,
   `sb_secret_...` key, or database password as the app's client key.
6. Complete owner setup and **Test connection**. Follow the selected scope's
   instructions for the optional `sbp_...` setup token; it is a separate
   privileged account token, not the project client key. Revoke it after setup.
7. Only after setup succeeds, enable sync and create an encrypted device key
   or team invitation. Pair test devices, verify changes in both directions,
   and verify that unauthorized and revoked identities cannot read or write.

Before upgrading an existing project, back up its data and private files and
review the latest in-app script on a staging project. Do not drop production
tables or disable their access policies just to make an upgrade pass.

## Different from the publisher backend

The app publisher's Supabase project verifies Pro purchases and linked-device
licenses. RevenueCat webhooks and publisher entitlement functions belong to
that separate service. Users do **not** deploy those functions into their
Personal Connection or Team Workspace database, and must not receive the
publisher's secrets. Your work-data database is not the publisher's license
database.

See the [full provider setup guide](https://nealw1993.github.io/lean-six-sigma-legal/provider-setup.html#supabase)
and [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).
