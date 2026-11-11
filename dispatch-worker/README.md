# 2FLY Dispatch integration deployment

This upgrades the existing `twofly-dispatch-photos` Worker without removing the old standalone tracker endpoints.

## Before deployment
1. Export/back up the existing `2fly-dispatch-db` from Cloudflare D1.
2. Confirm the standalone tracker still opens and note its current allowed origin.
3. Run `02_integrated_dispatch_schema.sql` against the EXISTING `2fly-dispatch-db`. It only adds `dispatch_*` tables and reuses the existing photo budget.
4. Keep `CLEANUP_ENABLED=false` for the first production check.

## Worker settings
Reuse the existing bindings:
- `DB` -> `2fly-dispatch-db`
- `PHOTOS` -> `2fly-dispatch-photos`

Add variables/secrets:
- `SUPABASE_URL`: current 2FLY Numbers Supabase URL
- `SUPABASE_ANON_KEY`: current 2FLY Numbers anon key (store as Worker secret rather than committing it)
- `ALLOWED_ORIGINS`: include `https://2flynumbers.netlify.app`
- Preserve `ALLOWED_ORIGIN` for the standalone tracker.
- `VAPID_PUBLIC_KEY`: generated public key
- `VAPID_PRIVATE_KEY`: Worker secret
- `VAPID_SUBJECT`: a valid mailto: or https: contact controlled by the owner

The Worker keeps Web Push failures out of the order-save path. In-app notifications and queues remain the source of truth.

## Retention
- Unattached/orphan integrated uploads: eligible after 48 hours.
- Packing, waybill and additional proof: eligible 60 days after shipment, but NOT while the order has any open missing-item case.
- Missing-item issue/resolution photos: eligible 60 days after the issue is resolved.
- Enable `CLEANUP_ENABLED=true` only after production verification; scheduled cleanup runs every 10 minutes and deletes at most small batches.

## Rollback
The old tracker endpoints remain in the Worker. If the integrated frontend has an issue, leave the new D1 tables in place and roll the Worker/site files back to the prior GitHub commit; no migration deletes the old tracker tables.