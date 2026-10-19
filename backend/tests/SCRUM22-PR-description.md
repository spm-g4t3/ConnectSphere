Persist attendee registrations through one atomic PostgreSQL RPC. The event row
remains locked while current eligibility, duplicates and capacity are checked and
the registration is saved. Settings, submission and browse availability use the
same canonical event_registrations records. The attendee UI shows server-confirmed
success, understandable failure feedback and refreshed availability.

## Integration and deployment

- Integrated origin/dev `7c2dd16`, including merged #68's organiser settings API/UI
  and #74's significant-change fixes. Preserve dev's reviewed 050/082/091 SQL and
  organiser-only route/service; no duplicate attendee submission route is added.
- Unapplied SCRUM-22 migrations were renumbered above dev's 097:
  **098_event_registration_persistence.sql -> 099_registration_eligibility.sql ->
  100_register_for_event.sql**. Apply pending dev dependencies first, then this
  batch in one transaction before deploying the matching API/UI.
- Feature flags stay removed. Drain the old API for the database-first rollout.
  Do not replay applied migrations or archived registration SQL. Existing legacy
  registrations are reconciled without dropping history or restoring withdrawals.

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/098_event_registration_persistence.sql -f backend/db/migrations/099_registration_eligibility.sql -f backend/db/migrations/100_register_for_event.sql
```

## Validation and limits

Retained both the organiser-settings SQL suite and the atomic registration SQL
suite. Focused coverage checks persistence, capacity, duplicates, authorisation,
privacy, rollback, availability and compatibility with schedule-change notices.
Local CI passed: backend 7,474 tests/176 suites with two workers; frontend 3,486
tests/151 suites; lint (23 existing warnings) and production build. Coverage gates
remain unchanged. Remote SQL, deployed browser/PostgREST checks and real two-session
PostgreSQL races were not run. See `SCRUM22-PR68-integration.md` for manual checks.

A null closing time is intentional: registration ends when disabled or when the
event starts. All authenticated Attendees currently meet additional eligibility;
this remains the team decision to confirm in SCRUM-22 notes.
