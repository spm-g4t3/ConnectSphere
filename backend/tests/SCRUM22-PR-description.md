> Integration update: PR #68 is now included through origin/dev. Its organiser-only settings route/service are retained, and attendee submission uses only `/api/open-events/:id/registrations`. The dependency/conflict snapshot below is historical. See [the current SCRUM-363 merge notes](SCRUM363-dev-merge.md).

Persist attendee event registration through one atomic PostgreSQL RPC. The event
row stays locked while current eligibility, duplicate status and capacity are
checked and the registration is saved. Submission, registration settings and
browse availability use the same `event_registrations` records. The attendee UI
shows authoritative success, failure and refreshed availability, with protection
against repeated submissions.

## Dependency and deployment order

**BLOCKED on #68 (SCRUM-494). Merge #68 into dev first, then merge that updated
dev into #70, resolve against #68's versions and re-review the combined result.
Do not merge #70 first.** Feature flags remain removed; apply #68's database
prerequisites before deploying this API/UI.

- Checked against dev `eb739a3` (highest migration 090) and #68 `fb11b2d`.
- Apply #68's pending schema migrations, including 050, 082 and 091, with the
  existing lifecycle/profile/browse prerequisites (including 068).
- Then apply **092_event_registration_persistence.sql ->
  093_registration_eligibility.sql -> 094_register_for_event.sql**, in one
  transaction, before releasing the matching backend/frontend.
- Historical 079-081 and the earlier registration 088 are preserved unchanged
  outside the active migration directory. Never replay that archive. The new
  sequence supports fresh #68 databases and databases that applied those older
  registration migrations, preserving existing registrations and withdrawals.
- Drain/stop the old API for the SQL/API rollout: the final RPC uses #68's
  structured response contract. The migration requests a PostgREST schema reload.

After #68 is deployed, apply only pending SQL from repository root:

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/092_event_registration_persistence.sql -f backend/db/migrations/093_registration_eligibility.sql -f backend/db/migrations/094_register_for_event.sql
```

The dependency migrations and registration route match #68, but this branch
does not deliver #68's organiser settings screen. A Git merge simulation confirms
seven conflicts in shared services, routing/dashboard and tests. Preserve the
organiser workflow and SCRUM-22's shared writer/browse contracts during resolution;
the merge and combined-result re-review remain outstanding until #68 lands.
No branch merge/rebase or remote database changes were performed.
See `backend/tests/SCRUM22-PR68-integration.md` for rollout and end-to-end checks.

## Eligibility and review fixes

- A null closing time is intentional under #68: registration remains open until
  it is disabled or the event starts. An opening time is still required. Covered
  by `SCRUM22_AC2_open_ended_registration_closes_at_event_start_and_matches_browse`.
- All authenticated Attendees currently satisfy additional eligibility. This is
  the **team decision to confirm** in SCRUM-22 notes; no speculative eligibility
  rules are implemented.
- Unavailable and unknown events return the same attendee-facing 404, avoiding
  disclosure of private event status. Missing schema produces a safe 503.
- Serialization/deadlock failures map to retryable 409 responses. Failed writes
  roll back. Closed registration shows one refusal; full-event races show their
  specific message.
- Direct event-table reads translate only missing-schema codes to 503. Other
  database errors remain unchanged and return a logged, generic 500, without
  leaking driver messages or misreporting attendee eligibility. Registration-state
  RPC role/identity refusals retain their existing mapping.
- Active SQL headers describe the implemented transaction. Frontend coverage
  gates use parent story `SCRUM22_FILES` with unchanged thresholds.

## Validation

- Latest review fix: **227 backend tests passed, 5 focused suites**. Direct table
  errors stay unchanged and produce generic logged 500s; all five missing-schema
  codes produce safe 503s on both browse reads. State RPC refusal tests still pass.
  `openEventService.js` coverage is **100% in all categories**, with unchanged gates.
- Previous full backend coverage baseline: 7,216 tests passed across 165 suites
  with two workers. Full CI and the integrated #68 result must be checked again
  after conflict resolution. SQL suites use actual migrations in PGlite, covering
  upgrades, canonical counts, privacy, permissions, uniqueness and rollback.
- Earlier frontend evidence: **210 tests passed, 5 focused suites** covering submissions, feedback,
  repeated clicks, failures and refreshed availability.
- `frontend/vite.config.js` ESLint passed; `git diff --check` passed.
- Real PostgreSQL concurrent-connection checks, remote migrations and deployed
  PostgREST/browser verification were **not executed**. PGlite queues one
  connection and does not prove overlapping transactions; a reproducible manual
  check is in `backend/tests/db/registrationConcurrency.manual.sql`.
