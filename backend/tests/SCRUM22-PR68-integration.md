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

The developer confirmed that SCRUM-22's former 092-094 have never been applied.
They are now **098 persistence -> 099 eligibility -> 100 atomic registration**,
after dev's highest migration 097, with no duplicate migration numbers added.
Do not replay applied dev migrations or any SQL under `db/migration-history/`.

1. Apply pending dev prerequisites, including 050, 082 and 091 and their
   lifecycle/profile/browse/notification dependencies. Apply other pending dev
   migrations according to their prerequisites; this merge includes 096/097.
2. Drain/stop the old API and apply the following SCRUM-22 batch before deploying
   the matching API/UI. Reconciliation takes table locks and changes the RPC
   response contract; avoid a mixed-version rolling release.

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/098_event_registration_persistence.sql -f backend/db/migrations/099_registration_eligibility.sql -f backend/db/migrations/100_register_for_event.sql
```

Migration 098 preserves legacy rows in `registrations_legacy_archive`, makes
`registrations` a read-only compatibility view and retains one canonical
`event_registrations` row per attendee/event. Only registered rows count toward
capacity; withdrawn/cancelled rows can reactivate without duplication. Waitlisted
rows are not silently promoted. Re-running the batch does not replay withdrawals
from the archive. Invalid data fails the batch without partial writes.

The final RPC locks the event before checking eligibility, duplicates and active
counts, then inserts in the same transaction. It reads database time after the
lock wait. No other current migration overwrites this writer. A null closing
time intentionally leaves registration open until disabled or the event starts.
All authenticated Attendees currently qualify for additional eligibility; this
remains the team decision to confirm, with no speculative rules added.

Missing schema gives a safe 503. Other table-read failures remain logged generic
500s; the state RPC retains its separate refusal mapping. Unknown and unavailable
events share 404. SQL 40001/40P01 become safe retryable 409s. Neither failed nor
duplicate attempts consume capacity.

## Manual end-to-end checks

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
