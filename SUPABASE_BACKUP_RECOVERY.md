# 2FLY Daily Ops — Supabase Backup & Recovery Plan

## Goal
Keep the business able to recover orders, payments, inventory, staff settings, and payment-proof files even if the current Supabase project is paused, restricted, corrupted, or needs to be replaced.

## Important distinction
Supabase database backups and Supabase Storage are separate.

- The database contains orders, payments, inventory, profiles, permissions, settings, and Storage metadata.
- The `payment-proofs` and `waybills` buckets contain the actual uploaded files.
- A database-only backup is not enough to recover deleted Storage objects.

## Current risk controls in the website
- Payment screenshots are compressed in the browser before upload when possible.
- PDFs are preserved as-is.
- Daily Ops no longer depends on the Dispatch D1/R2 integration.
- The Dashboard now paginates through Supabase data rather than assuming one API response contains the full history.

## Recommended backup schedule
For a production business:

1. **Weekly database backup**
   - Export roles, schema, and data using the Supabase CLI.
   - Keep at least 4 weekly copies outside Supabase.

2. **Weekly Storage backup**
   - Copy `payment-proofs` and `waybills` to a separate location.
   - Good destinations: local external drive, Google Drive, OneDrive, or another object-storage provider.

3. **Monthly restore test**
   - Create a temporary Supabase project.
   - Restore the latest database backup and confirm that orders, payments, inventory and permissions work.
   - Do not treat an untested backup as a guaranteed recovery plan.

## Database backup commands
Use the connection string shown under **Supabase Dashboard → Connect**. Never commit the database password to GitHub.

```bash
supabase db dump --remote="[CONNECTION_STRING]" -f roles.sql --role-only
supabase db dump --remote="[CONNECTION_STRING]" -f schema.sql
supabase db dump --remote="[CONNECTION_STRING]" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
```

Store the three files together in a dated folder, for example:

```
2fly-backups/
  2026-11-15/
    roles.sql
    schema.sql
    data.sql
    storage/
```

## Storage backup
Link the Supabase CLI to the project using a personal access token, then copy each important bucket to the dated backup folder.

Back up at minimum:
- `payment-proofs`
- `waybills`

Do not rely on database backups alone for these files.

## Fast migration plan if the current project must be replaced

1. Create a new Supabase project.
2. Restore `roles.sql`, `schema.sql`, then `data.sql`.
3. Re-create/restore the Storage buckets and upload their files.
4. Re-check Auth, RLS policies, RPC functions, views, Storage policies, and staff profiles.
5. Change only `config.js` in the website to the new Supabase URL + anon key.
6. Test:
   - login
   - dashboard
   - new order
   - payment proof
   - payment verification
   - Packing Queue
   - inventory
   - waybill/tracking
7. Only after testing, point production users to the new project.

## Free-plan pausing
If the project is on Supabase Free, automatic pausing is based on low database activity. A business app that is actively queried every day is less likely to be considered inactive, but Free does not provide a no-pause guarantee.

If Daily Ops is business-critical, the safest long-term setup is a paid Supabase project plus off-site backups.

## Never store these in GitHub
- Supabase database password
- service_role key
- personal access token
- backup archives containing customer/payment data

The public anon key used by the browser is different; security must still be enforced with RLS and server-side database policies.
