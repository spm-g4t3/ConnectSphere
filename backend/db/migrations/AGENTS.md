# Migrations

## How the schema is built
- `backend/db/baseline/01..09` is the schema as of migration 102. Never edit it and never paste it into live; live already has it.
- Every change is a new file here, numbered from 103 upward. `git fetch origin dev` and take a number above the highest there.
- A fresh database is the baseline files in order, then these files in order. Live gets each new file pasted into the Supabase SQL editor.
- A migration must apply cleanly both on live and on top of the baseline.
- A function's truth is the latest migration that defines it, else the baseline: `git grep -n "function <name>" backend/db`.

## Writing a migration
- Never edit a migration that has been applied; add a new, higher-numbered file.
- Re-runnable: `create or replace`, `if exists` / `if not exists`, drop-then-add for constraints.
- Changing a function's signature: `drop function if exists <name>(<old arg types>)` first, or the old overload stays callable.
- Whole-list constraints (e.g. `notifications_type_known`): copy the list from the latest migration that sets it, else from `baseline/05_notifications.sql`, then add yours.
- No `security definer`. Functions run with the caller's permissions; the API calls them as service_role.
- Caller and role checks belong inside the function too, matching the route's `requireRole`. Refuse a null caller.
- Error codes the API maps: 42501 forbidden, P0002 not found, 55000/40001 conflict, 22023 bad input.

## Testing and checking live
- Cover new or changed functions with a PGlite test in `backend/tests/db/` using `createSchemaDb()` (baseline plus every migration here). Never load a subset of files or a stand-in schema.
- After pasting into live, run `backend/scripts/schema-fingerprint.sql` in the Supabase SQL editor, export the CSV, and diff it (inside `backend/`):
  `node scripts/schema-fingerprint.js build baseline <built.csv>`, then
  `node scripts/schema-fingerprint.js diff <built.csv> <live.csv> --ignore extension`.
  Expect only the known live-only leftovers: the old `event_request_clarifications` tables, `event_requests.coordinator_id` and `clarification_reply_by`, `bookings.safety_review_*`, `registrations_legacy_archive`, and an 8-argument `create_booking_request` overload. Anything else is drift to fix.
