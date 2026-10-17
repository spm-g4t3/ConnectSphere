# Migrations

- Never edit a migration that has been applied; add a new, higher-numbered file.
- Re-runnable: `create or replace`, `if exists` / `if not exists`, drop-then-add for constraints.
- Changing a function's signature: `drop function if exists <name>(<old arg types>)` first, or the old overload stays callable.
- Whole-list constraints (e.g. `notifications_type_known`): copy the list from the latest migration that sets it, then add yours.
- No `security definer`. Functions run with the caller's permissions (see `015_assignment_function.sql`); the API calls them as service_role.
- Caller and role checks belong inside the function too, matching the route's `requireRole`. Refuse a null caller.
- Error codes the API maps: 42501 forbidden, P0002 not found, 55000/40001 conflict, 22023 bad input.
- Cover new or changed functions with a PGlite test in `backend/tests/db/`, applying only the migrations it needs.
