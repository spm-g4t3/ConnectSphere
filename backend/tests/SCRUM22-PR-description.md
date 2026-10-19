Persist attendee registrations through one atomic PostgreSQL RPC. The event row
remains locked while current eligibility, duplicates and capacity are checked and
the registration is saved. Settings, submission and browse availability use the
same canonical event_registrations records. The attendee UI shows server-confirmed
success, understandable failure feedback and refreshed availability.

## Integration and deployment

- Integrated origin/dev `7c2dd16`, including merged #68's organiser settings API/UI
  and #74's significant-change fixes. Preserve dev's reviewed 050/082/091 SQL and
  organiser-only route/service; no duplicate attendee submission route is added.
- SCRUM-22 uses its requested registration migration sequence:
  **092_event_registration_persistence.sql -> 093_registration_eligibility.sql ->
  094_register_for_event.sql**. Apply pending dev dependencies first, then this
  batch in one transaction before deploying the matching API/UI.
- Feature flags stay removed. Drain the old API for the database-first rollout.
  Do not replay applied migrations or archived registration SQL. Existing legacy
  registrations are reconciled without dropping history or restoring withdrawals.

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/092_event_registration_persistence.sql -f backend/db/migrations/093_registration_eligibility.sql -f backend/db/migrations/094_register_for_event.sql
```

## Validation and limits

Follow-up: remove the unused RS409 schedule-conflict handler and its misleading
blocking-change test. Migration 101 allows reactivation only from withdrawn;
cancelled/waitlisted registrations remain unchanged and receive clear refusals.
Browse uses the caller's database status to disable Register through the existing
HTTP contract. Apply 101 after 094, in one transaction, before the matching API.
Follow-up validation: backend coverage passed 7,482 tests across 175 suites with
two workers; 71 targeted frontend tests and targeted ESLint passed. The initial
backend run was stopped after unrelated worker timeouts; no thresholds changed.

Retained both the organiser-settings SQL suite and the atomic registration SQL
suite. Focused coverage checks persistence, capacity, duplicates, authorisation,
privacy, rollback, availability and compatibility with schedule-change notices.
Original PR CI passed: backend 7,474 tests/176 suites with two workers; frontend 3,486
tests/151 suites; lint (23 existing warnings) and production build. Coverage gates
remain unchanged. Remote SQL, deployed browser/PostgREST checks and real two-session
PostgreSQL races were not run. See `SCRUM22-PR68-integration.md` for manual checks.

A null closing time is intentional: registration ends when disabled or when the
event starts. All authenticated Attendees currently meet additional eligibility;
this remains the team decision to confirm in SCRUM-22 notes.
