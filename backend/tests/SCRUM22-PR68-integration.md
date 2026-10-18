# SCRUM-22 / PR #68 integration

Dependency snapshot: PR #68 (commit `05f418f`), checked against dev `d0c824e`
on 18 October 2026. PR #68's schema migrations are 050, 082 and 085; its 085 is
renumbered here to 091 with unchanged SQL. **Merge and apply #68 first.** This is
the chosen release strategy; feature flags remain removed.

The active SCRUM-22 sequence is **092 persistence -> 093 eligibility -> 094 atomic
registration**, after dev's highest migration 089 and PR #68's schema. Previous
079-081 and the earlier registration 088 are retained unchanged under
`backend/db/migration-history/`, outside the deployable migration directory.
Do not replay those snapshots or change their applied SQL.

## One authoritative registration store

- `event_registrations` is the only writable registration table. Setup capacity,
  the atomic registration RPC and browse state count only `status = 'registered'`.
- 092 retains every legacy row in `registrations_legacy_archive`, readable but
  not writable by the backend role. `registrations` becomes a read-only,
  invoker-security compatibility view over the canonical table.
- Where both stores have the same attendee/event, an existing active registration
  is retained, never counted twice. A legacy active registration takes precedence
  over an inactive canonical row. All original legacy rows remain in the archive.
  Re-running 092 does not replay that archive over later withdrawals.
- PR #68's unique attendee/event relationship remains. Withdrawn/cancelled rows
  are reactivated rather than duplicated; waitlisted attendees are not silently
  promoted. The known-status constraint preserves PR #68's states and the legacy
  cancellation state.
- Both attendee HTTP routes use the same service/RPC and error mapping:
  `/api/open-events/:id/registrations` and `/api/registration/events/:id/register`.
  The RPC retains PR #68's structured outcomes and camelCase success contract.
- The event is locked before current eligibility, duplicate/capacity checks and
  insertion. Eligibility reads the database clock after waiting for the lock.

## Review fixes

- Non-confirmed, disabled, missing, not-yet-open, closed and started events produce
  the same attendee-facing 404, without private status or eligibility codes.
- Serialization failures (40001) and deadlocks (40P01) produce safe retryable 409s
  through either endpoint. Failed SQL writes roll back.
- A submission refusal suppresses the redundant generic “not open” banner.
  `EVENT_FULL` uses the race-specific message, including actual typed API failures.
- Real schema migrations replace test-only registration columns. Missing tables,
  columns or PostgREST functions produce a safe 503; feature flags remain removed.
- PR #68's existing backend settings/listing services, route, registration-schedule
  conflict mapping and status vocabulary are reused. Its registration method
  delegates to the shared SCRUM-22 service.

## Deployment — manual only

First stack/retarget PR #70 on PR #68 (or rebase after #68 reaches dev) during the
normal review workflow. No commits, rebase, merge or push were performed by this
fix. The dependency files are present locally so this branch can also
exercise and deploy its actual schema, rather than assuming another PR supplied it.

Review the target database's applied-migration history. The required order is:

1. Merge and apply PR #68, including any pending 050, 082 and hardening migration
   (091 here, originally 085), on top of the
   existing lifecycle/profile/browse prerequisites (including 068).
2. Apply 092, then 093, then 094 inside one transaction before releasing #70's API/UI.
3. Never execute `backend/db/migration-history/`; existing 079-081 or the old
   registration 088 may remain in the database ledger. 092-094 safely upgrade
   those states and also work on a fresh PR #68 schema.

Once #68 is deployed, from repository root with a configured connection:

```powershell
psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/092_event_registration_persistence.sql -f backend/db/migrations/093_registration_eligibility.sql -f backend/db/migrations/094_register_for_event.sql
```

Apply only pending migrations. The final migration requests a PostgREST schema
reload. Reconciliation takes table locks; drain/stop the old API for the SQL/API
rollout. Legacy exception-based failures become PR #68's structured outcomes,
so this is not a mixed-version rolling release.

Invalid existing settings or conflicting primary keys cause the batch to fail
without partial writes; inspect and resolve the data rather than dropping it.
If the former stores accepted registrations independently, review capacity
against the reconciled count. Overfull events refuse new registrations; no
attendees are cancelled to fit a lower capacity.

PR #68 deliberately allows a null closing time: an enabled registration with
an opening time stays open until the organiser disables it or the event starts.
`SCRUM22_AC2_open_ended_registration_closes_at_event_start_and_matches_browse`
executes that boundary in SQL and checks the browse rule agrees.

Additional eligibility: all authenticated Attendees are treated as eligible.
This is the team's current **decision to confirm**, not a confirmed customer
requirement; no additional eligibility rules are invented.

After deploying the matching backend/frontend and restarting/rebuilding:

- Configure a future Confirmed event as its organiser. Enable registration with
  a current opening time and capacity one; confirm the initial count is zero.
- Register as an Attendee through normal navigation. Check canonical persistence,
  the organiser's count, Registered badge, zero places left and Full state.
- Repeat as the same attendee and then another attendee: duplicate and full 409s;
  no extra row or consumed capacity. Check unavailable and unknown IDs share 404.
- Close registration while details are open: submit and verify a single refusal.
- Verify signed-out/incorrect-role access is refused on both submission routes.
- Run `db/registrationConcurrency.manual.sql` in two real PostgreSQL sessions on
  disposable data. Verify a last-place race, a duplicate race and rollback.

## Local evidence and limits

Focused results: **325 backend tests passed** across 13 suites; **210 frontend
tests passed** across five suites. Targeted frontend ESLint: zero errors, one
pre-existing effect-state warning in `BrowseEventDetails.jsx`.

`registrationSchemaIntegrationDatabase.test.js` executes the combined historical
migrations and 092-094 on PGlite with pre-existing rows in both tables. It covers
reconciliation, settings/write/browse count agreement, inactive/waitlisted states,
re-runs, foreign keys, uniqueness, RLS and backend-only access.
It also upgrades a database that already applied the earlier registration 088,
without replaying historical SQL or restoring a later withdrawal.

`eventRegistrationDatabase.test.js` exercises the current real schema, atomic
writer, rollback, retryable SQL errors and HTTP/browse refresh. Route tests cover
both API contracts, event privacy and safe deployment errors. Frontend tests use
actual response codes for closed/full feedback and refreshed availability.

PGlite queues requests on one connection; it cannot prove real overlapping
connections. No remote migrations, live scripts, live PostgREST/browser checks,
environment edits or real PostgreSQL races were executed.
