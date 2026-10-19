# SCRUM-22 / dev integration

Integrated with origin/dev at `7c2dd16`, which includes merged PR #68 (SCRUM-494)
and PR #74 (significant event changes). The organiser settings API/UI comes from
dev. Its 050, 082 and 091 migrations are retained exactly as delivered there.
The former attendee compatibility routes in the settings router stay removed;
registration submits only through `POST /api/open-events/:id/registrations`.

## Merge resolutions

- Keep dev's organiser-only settings route/service, strict capacity validation,
  open-ended registration windows and schedule-conflict notifications. A start
  change goes through; the organiser can still disable registration afterwards.
- Keep SCRUM-22's event-row lock, current eligibility checks, canonical writer,
  duplicate protection, safe refusal mapping and refreshed browse availability.
- Retain dev's settings SQL tests in `eventRegistrationDatabase.test.js` and
  SCRUM-22's atomic/rollback/HTTP SQL tests in
  `atomicEventRegistrationDatabase.test.js`. Both execute real migrations.
- SQL fixtures include the assignment/notification prerequisites required by
  dev's 091. An integration regression verifies schedule-change notifications,
  preservation of registrations and rejection by the final atomic writer.
- Retain the organiser settings routes/navigation together with SCRUM-22's
  attendee browse/detail routes. No feature flag is restored.

## Database and deployment order - manual only

The requested SCRUM-22 sequence is **092 persistence -> 093 eligibility ->
094 atomic registration**, after its SCRUM-494 dependency 091. These numbers
are unused on dev; dev's 096/097 do not redefine the registration writer.
Do not replay applied dev migrations or any SQL under `db/migration-history/`.

1. Apply pending dev prerequisites, including 050, 082 and 091 and their
   lifecycle/profile/browse/notification dependencies. Apply other pending dev
   migrations according to their prerequisites; this merge includes 096/097.
2. Drain/stop the old API and apply the following SCRUM-22 batch before deploying
   the matching API/UI. Reconciliation takes table locks and changes the RPC
   response contract; avoid a mixed-version rolling release.

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/092_event_registration_persistence.sql -f backend/db/migrations/093_registration_eligibility.sql -f backend/db/migrations/094_register_for_event.sql
```

Migration 092 preserves legacy rows in `registrations_legacy_archive`, makes
`registrations` a read-only compatibility view and retains one canonical
`event_registrations` row per attendee/event. Only registered rows count toward
capacity; only withdrawn rows can reactivate without duplication after migration 101.
Cancelled and waitlisted rows remain unchanged. Re-running the batch does not replay withdrawals
from the archive. Invalid data fails the batch without partial writes.

The latest writer in 101 locks the event before checking eligibility, duplicates and active
counts, then inserts in the same transaction. It reads database time after the
lock wait. Apply 101 after the base 092-094 sequence. A null closing
time intentionally leaves registration open until disabled or the event starts.
All authenticated Attendees currently qualify for additional eligibility; this
remains the team decision to confirm, with no speculative rules added.

Missing schema gives a safe 503. Other table-read failures remain logged generic
500s; the state RPC retains its separate refusal mapping. Unknown and unavailable
events share 404. SQL 40001/40P01 become safe retryable 409s. Neither failed nor
duplicate attempts consume capacity.

## Manual end-to-end checks

For the registration-status follow-up, after pending prerequisites through 094,
drain the old API and apply 101 in one transaction before deploying the matching
backend. The private browse RPC adds the caller's registration status; the public
HTTP allowlist stays unchanged, and the existing UI uses its `canRegister` flag.

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/101_registration_status_guards.sql
```

Only pending SQL should be applied. Migration 101 preserves cancelled/waitlisted
rows, returns specific 409 refusals and disables Register for those callers.
Withdrawn callers may re-register using the same record. The obsolete RS409
handler/test was removed; schedule changes continue through flag-and-notify.
Follow-up checks: backend coverage passed 7,482 tests/175 suites with two workers;
71 targeted frontend tests and targeted ESLint passed. No coverage gates changed.

- Configure a future Confirmed event through the organiser settings screen, with
  registration enabled now and capacity one.
- Register through normal attendee navigation. Verify canonical persistence,
  the organiser count, Registered state and zero places left/Full.
- Retry as the same attendee and another attendee: duplicate/full refusals with
  unchanged rows. Check signed-out/wrong-role access and safe unknown-event 404s.
- Close registration while details are open; verify one understandable refusal.
- Change the start so registration dates conflict; verify notifications, retained
  registrations and the ability to turn registration off.
- Run `db/registrationConcurrency.manual.sql` in two PostgreSQL sessions using
  disposable data to verify last-place/duplicate races and rollback.

## Evidence limits

Local CI passed: backend coverage 7,474 tests/176 suites with two workers;
frontend coverage 3,486 tests/151 suites; lint (23 existing warnings) and build.
Focused post-renumbering regressions passed 98 tests across four suites.
PGlite executes SQL
on one queued connection and cannot prove overlapping PostgreSQL transactions.
Remote migrations, live scripts, deployed PostgREST/browser checks and real
PostgreSQL concurrency checks were not executed. No environment files were edited.
