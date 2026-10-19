# SCRUM-363 integration with dev

Current refresh: origin/dev `0fef506` includes merged PR #70 (SCRUM-22).
Five documentation/test conflicts were resolved, retaining the registration
deployment guide, all organiser-arrangement tests and one retired-route test.
The schedule-change SQL regression from dev is retained. No application code,
SQL migration or coverage threshold changed in this refresh.
Validation for this refresh: 36 backend tests and 92 frontend tests passed across
six focused suites. The resolved frontend test file passed ESLint; Git conflict
and whitespace checks passed. Full CI was not repeated for documentation/test-only changes.

The integration and full CI evidence below describe the preceding dev merge.

Source: origin/dev `7c2dd16`, including merged PR #68 registration settings and
PR #74 significant changes. Nine merge conflicts were resolved; the merge is
left uncommitted. The reviewed dev registration migrations 050/082/091 and its
organiser-only settings route/service remain unchanged from dev.

## Integrated behaviour

- The coordinator detail retains both Confirm Event and Revise event details.
  Confirmation uses the shared readiness checklist and its existing protected RPC.
- Dev's significant-change RPC originally saved fields while still Confirmed;
  migration 099's field guard correctly refused that intermediate write.
- New migration 100 closes any pending safety review and transitions to Approved
  through the existing status/history function before saving changed fields.
  Event/arrangement locks, validation, flags and notifications stay transactional.
  Direct confirmed edits are still refused; failures roll back status and history.
- The registration settings screen and attendee submission remain reachable.
  Settings, persistence and availability use canonical event_registrations.
  Dev's retired attendee routes in the settings router are not restored.
- Both registration SQL suites are retained: dev settings tests in
  eventRegistrationDatabase.test.js and atomic tests in
  atomicEventRegistrationDatabase.test.js. Fixtures include 091's notification
  prerequisites; the complete notification-type expectation follows merged dev.

## Focused evidence

- SCRUM363_AC8_actual_significant_change_preserves_field_locks_and_reconfirms_after_fresh_safety_review:
  actual SQL Confirmed -> Approved -> safety review -> Safety approved -> Confirmed,
  with fresh submissions, actor history and preserved registrations/settings.
  This case changes attendance within venue capacity; flagged-arrangement
  resolution still needs separate deployed verification.
- SCRUM363_AC8_a_failed_significant_change_rolls_back_the_early_transition_and_all_history.
- SCRUM363_AC8_compatibility_migration_is_rerunnable_invoker_security_and_backend_only.
- SCRUM363_AC8_confirmation_and_significant_change_actions_remain_reachable_without_stale_success:
  frontend integration with mocked service responses, not deployed evidence.
- Existing significant-change SQL tests also execute migration 100.

## Validation

- Backend coverage: 7,620 passed, 3 existing TODOs, 178 suites; thresholds passed.
- Frontend coverage: 3,573 passed, 153 suites, with two workers; thresholds passed.
- Focused frontend integration: 220 passed across seven suites.
- Lint: zero errors, 24 warnings. Production build passed with its bundle-size warning.
- The first full frontend run stalled and timed out across unrelated suites.
  The two-worker rerun passed without changing tests, timeouts or coverage gates.
- Git conflict-marker and whitespace checks passed. No commit or push was made.

## Deployment - manual only

Apply only pending prerequisite migrations from dev, including registration
050/082/091 and significant-change/equipment 096/097. Retain SCRUM-22's requested
092-094 sequence. Apply readiness 098, confirmation 099 and compatibility 100 in
that order before deploying the matching confirmation API/UI.

After prerequisites, on a configured disposable/staging connection:

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/098_event_readiness_details.sql -f backend/db/migrations/099_confirmation_revision.sql -f backend/db/migrations/100_significant_change_confirmation_compatibility.sql
```

Do not replay applied or archived migrations. No remote migrations, live scripts,
environment edits or Jira changes were made. The existing manual PostgreSQL
concurrency checks and deployed browser/PostgREST checks have not been run.
SCRUM-175 confirmation/reconfirmation notifications remain outside this merge;
no AC9 pass is claimed from significant-change notices.
