# SCRUM-363 integration with dev

Review date: 19 October 2026. Fetched origin/dev is 0fef506, already included
by branch commit da37843. No new merge was needed or performed in this review.
Dev includes SCRUM-494 registration settings (#68), SCRUM-22 (#70), and
SCRUM-395 significant changes (#74). There are no active migration-number
clashes: dev ends at 097; this branch adds 098, 099 and 100.

## Current review changes

- Added one SQL lifecycle regression to the existing equipment/readiness suite.
  It executes significant change -> flagged venue/equipment -> manual resolution
  through existing SQL functions -> fresh safety review -> re-confirmation.
  A dedicated venue isolates the real occupancy check from other test events.
- Loaded the actual hold, booking-decision, resolution and flag-reason prerequisites.
- Removed an obsolete AC8 TODO because its lifecycle now has executable coverage.
- Updated the acceptance review. No production implementation, migration,
  dependency, coverage threshold or environment configuration was changed.

## Local verification

- Backend coverage: 7,622 tests passed across 178 suites; two AC9 TODOs remain.
  All configured coverage thresholds passed.
- Frontend coverage: 3,573 tests passed across 153 suites; all configured
  coverage thresholds passed.
- Focused frontend regression: 220 tests passed across seven suites.
  Updated SQL equipment/lifecycle regression: all eight tests passed.
- Lint: zero errors, 24 existing warnings. Production build passed with its
  existing bundle-size warning. Git whitespace checks passed.

The full coverage commands use two workers without changing any repository gate:

```powershell
# backend
npm.cmd run test:coverage -- --maxWorkers=2 --reporter=dot
# frontend
npm.cmd run test:coverage -- --maxWorkers=2 --reporter=dot
npm.cmd run lint
npm.cmd run build
```

## Acceptance and deployment

See [SCRUM363-review.md](SCRUM363-review.md) for the AC1-9 checklist, exact test
IDs, manual SQL/deployment steps and unexecuted integration checks.

**Not ready for acceptance approval:** AC9 confirmation notifications are absent;
SCRUM-175 is still To Do. Existing significant-change/equipment notices are not
confirmation notices. SCRUM-402 is also To Do for organiser change-request
processing; its complete behaviour is not claimed by the coordinator cycle tests.

Apply only pending prerequisites and 098 -> 099 -> 100 manually before deploying
the matching API/UI. Do not execute archived migrations. Real two-connection
PostgreSQL races, deployed PostgREST and browser end-to-end checks remain unrun.
No remote migrations, live scripts, commits, pushes, merges or Jira changes occurred.

## Proposed PR description

Adds an assigned-coordinator Confirm Event workflow from exact Safety approved,
using the shared venue/equipment/date checklist and one locked PostgreSQL
transaction. Explicit no-equipment acknowledgement is tied to the reviewed event
revision and recorded with coordinator/time in status history. Organisers can
read current confirmed arrangements; significant changes retain field protection
and require fresh safety review before re-confirming. Registration remains independent.

Requires the merged dev registration/safety/arrangement/significant-change
prerequisites. Apply pending migrations 098, 099 and 100 in order before API/UI
rollout. Local SQL/UI coverage does not substitute for staging concurrency and
PostgREST checks. AC9 remains blocked on SCRUM-175; do not present this PR as
fulfilling all SCRUM-363 acceptance criteria yet.
