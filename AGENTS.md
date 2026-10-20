<!-- Kept short on purpose: every line loads into every agent session. Add a line
only when an agent repeats a mistake; delete lines that stop mattering. -->

# AGENTS.md

ConnectSphere: React (Vite) → Express → Supabase (Postgres). The frontend never
queries the database; authorisation lives in Express routes and the SQL functions.
Setup, architecture, branches and the live check scripts are in `README.md`; read
it only when the task needs it.

## Domain rules the code won't tell you
Final for Release 1. The Week 7 customer changes override older rules. The full
requirements, one section per epic with sources, are in `docs/requirements.md`.
Read only the section for the area you are working on, not the whole file.
- Changes flag and notify. They never auto-cancel, delete or un-book anything; the Coordinator decides.
- Only a confirmed booking blocks a venue. Clashing pending requests are allowed (first come, first served).
- Venue occupancy includes setup time before and turnaround time after. An expired hold never counts as a booking.
- One event can have several venue bookings; each is checked and cancelled on its own.
- Submissions wait in the Lead's unassigned queue (no auto-assignment). At most one coordinator per event.
- After an event is confirmed its fields lock; edits go through change requests. Cancelled is final; rejected can be resubmitted.
- Venue suitability is advisory only. A user may hold several roles. No admin role, no self-registration.

## Where the truth lives
- SQL functions: the highest-numbered migration that defines one wins, else `backend/db/baseline/` (the schema as of 102).
  `git grep -n "function <name>" backend/db`, then read the latest file. Migration rules: `backend/db/migrations/AGENTS.md`.
- Status and role vocabularies: `backend/src/domain/*.js`. They must match the SQL enums (tests in `backend/tests/domain/` check this).
- Role gates exist twice, and both must agree: `requireRole` in `backend/src/routes/*.js` and the caller checks inside the SQL functions.
- Per-story coverage thresholds: `frontend/vite.config.js`, `backend/vitest.config.js`.

## Commands, cheapest first (run inside `backend/` or `frontend/`)
- While iterating: `npx vitest run tests/<path>`, or add `-t "<test name>"` for one test.
- Before pushing only (this is what CI runs): `npm run test:coverage`; in `frontend/` also `npm run lint` and `npm run build`.
- `npm run *:check` and `*:seed` scripts hit the shared live Supabase project. Do not run them unless asked.

## Token habits
- Find code with `git grep -n`, then read only that line range. Many files are 1,000-4,500 lines.
- Find a test by name: `grep -rn "SCRUM<id>_AC<n>" backend/tests frontend/tests`.
- Skip `docs/` (except `docs/requirements.md`), `coverage/`, `dist/`, `node_modules/` and lockfiles unless the task is about them.
- Keep one sub-task per session. Show only the summary and the failures from test output.

## Shared surfaces (several stories touch these)
- `notifications_type_known`: a new type means restating the whole list from the latest migration that sets it (`git grep -l notifications_type_known backend/db/migrations | tail -1`), else `backend/db/baseline/05_notifications.sql`, never an older one.
- New event statuses (the Week 7 safety statuses) also need `ACTIVE_EVENT_STATUSES` (`backend/src/services/eventRequestService.js`) and the status list in `reassign_event_request`.
- Migration numbers: start at 103. `git fetch origin dev`, then take a number above the highest there. Renumber yours if dev moves first.

## Writing code
- Comments say why, in 1-3 lines. Story history and ticket narrative go in the PR, not in file headers.
- New tests are named `SCRUM<id>_AC<n>_<behaviour>`; the name is the link to the acceptance criterion.
- Every committed line must be explainable by its author. Don't commit code you can't defend.
- Match the idioms of the surrounding file.

## Ask a human before
- Editing a migration that may already be applied (add a new one instead).
- Running live scripts, deleting data, or touching `.env` files.
