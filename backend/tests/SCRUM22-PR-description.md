Persist attendee event registration through one atomic PostgreSQL RPC. The event
row stays locked while current eligibility, duplicate status and capacity are
checked and the registration is saved. Submission, registration settings and
browse availability use the same `event_registrations` records. The attendee UI
shows authoritative success, failure and refreshed availability, with protection
against repeated submissions.

## Dependency and deployment order

**Depends on #68 (SCRUM-494): merge and apply #68 first. Feature flags remain
removed; do not deploy this API/UI before its database prerequisites.**

- Checked against dev `d0c824e` (highest migration 089) and #68 `05f418f`.
- Apply #68's pending schema migrations, including 050, 082 and hardening
  (renumbered here from 085 to 091, with unchanged SQL), with the
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

The normal review workflow must stack this branch on #68, or rebase it after #68
lands in dev. No branch merge/rebase or remote database changes were performed.
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
- Active SQL headers describe the implemented transaction. Frontend coverage
  gates use parent story `SCRUM22_FILES` with unchanged thresholds.

## Validation

- Backend: **325 tests passed, 13 focused suites**. SQL executes in PGlite using
  #68's actual migrations, without adding settings columns by hand. Coverage
  includes legacy upgrades, canonical counts, privacy, permissions, uniqueness,
  rollback and both HTTP registration contracts.
- Frontend: **210 tests passed, 5 focused suites** covering submissions, feedback,
  repeated clicks, failures and refreshed availability.
- `frontend/vite.config.js` ESLint passed; `git diff --check` passed.
- Real PostgreSQL concurrent-connection checks, remote migrations and deployed
  PostgREST/browser verification were **not executed**. PGlite queues one
  connection and does not prove overlapping transactions; a reproducible manual
  check is in `backend/tests/db/registrationConcurrency.manual.sql`.
