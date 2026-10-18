# ConnectSphere

Event planning and venue booking system for **ConnectSphere Event Services**, a regional organisation providing professional event planning and venue services across Southeast Asia.

ConnectSphere coordinates events across its own venues and equipment inventory. This system replaces the current mix of email, spreadsheets and shared calendars with a single platform, so that an event request can be tracked from initial submission through review, venue booking, equipment reservation and attendee registration — without the same venue being double-booked or a last-minute change failing to reach the people it affects.

**Repository:** https://github.com/spm-g4t3/ConnectSphere

> **Status:** early development. The application scaffold is not yet in place; see [Getting started](#getting-started).

## User roles

| Role | Internal / External | Responsibility |
|---|---|---|
| Event Organiser | External | Client representative who submits an event and its requirements |
| Event Coordinator | Internal | Owns planning for an assigned event; main internal point of contact |
| Venue Staff | Internal | Venue information, availability, and booking decisions |
| Technical Support Staff | Internal | Equipment, reservations, and technical support |
| Attendee | External | Registers for and attends an event |

Access to information and functionality depends on a user's role *and* their relationship to a given event.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite, JavaScript) |
| Backend | Node.js + Express (JavaScript) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |

## Architecture

Requests flow in one direction:

```
React  ──►  Express  ──►  Supabase
```

The frontend never queries the database directly. All data access goes through the Express API, which is the only tier that holds the Supabase service-role key and the only place authorisation rules are enforced.

**Authentication boundary.** Supabase Auth is the exception to the flow above: the frontend uses `supabase-js` *solely* to sign in and obtain a JWT. That token is then sent as a `Bearer` header on every request to Express, which verifies it and derives the caller's role and event relationships from it. The frontend holds only the anon key and a session token; it never holds credentials that could bypass the API.

## Repository layout

```
ConnectSphere/
├── frontend/    # React (Vite, JS) — client application
├── backend/     # Node.js + Express (JS) — API server
└── package.json # dev scripts that run both together
```

## Getting started

**Prerequisites:** Node.js 22+ and npm 10+.

```bash
git clone https://github.com/spm-g4t3/ConnectSphere.git
cd ConnectSphere
npm run install:all      # installs root, backend and frontend
```

Copy `backend/.env.example` to `backend/.env` and fill in the real values. Real `.env` files are gitignored and must never be committed. The frontend needs no `.env`: it defaults to `http://localhost:5000/api`, and `VITE_API_BASE_URL` overrides that if you need it to.

Browse Open Events (SCRUM-495) is available to authenticated Attendees through the navigation, dashboard and `/open-events` routes. Settings, registration writes and browse counts all use `event_registrations`. Events must be Confirmed with registration enabled and within their registration window to appear.

Merge and apply PR #68 (SCRUM-494) first, including its schema migrations 050, 082 and 091. Then apply this story's 092, 093 and 094 before deploying its backend/frontend; these numbers follow dev's current highest migration, 089. Migration 092 preserves legacy registrations and replaces `registrations` with a read-only compatibility view. Feature flags remain removed, so this dependency and database-first release order are mandatory. Historical 079–081 and the earlier registration 088 are archived outside the active migrations directory and must not be replayed. See [registration integration and deployment](backend/tests/SCRUM22-PR68-integration.md).

Then, from the repository root:

```bash
npm run dev
```

That starts both servers at once — the API on **http://localhost:5000** and the client on **http://localhost:5173** — with each line of output labelled `backend` or `frontend`. Ctrl+C stops both, and if either exits with a failure the other is stopped too, so you never end up talking to half a system.

| Command | Runs |
|---|---|
| `npm run dev` | Both servers together. The usual one. |
| `npm run dev:backend` | The API alone, on port 5000. |
| `npm run dev:frontend` | The client alone, on port 5173. |
| `npm run install:all` | Installs dependencies in all three packages. |
| `npm test` | The backend unit suite, same as CI runs. |

Each package can still be driven on its own from inside its own directory; the root scripts are a convenience, not a new layer.

## Event status lifecycle

An event request is always in exactly one of eleven statuses, and moves between them only along the transitions below. The statuses and transitions are defined once, in `backend/src/domain/eventRequestStatus.js` (`STATUS`, `ALLOWED_TRANSITIONS`, `canTransition`). Every story uses these names.

### Statuses and what the Organiser sees

The stored value is internal. The Event Organiser never sees it: they see the label in the last column, which comes from one map, `ORGANISER_STATUS_LABEL`, in the same file. The API sends it to the frontend as `statusDisplay`, so the frontend keeps no copy of the words.

| Status | Stored value | Organiser sees |
|---|---|---|
| Draft | `draft` | Draft |
| Submitted | `submitted` | Requested |
| Under review | `under_review` | Under review |
| Pending clarification | `pending_clarification` | Awaiting your response |
| Approved | `approved` | Planning |
| Safety review | `safety_review` | Safety check (provisional, SCRUM-549) |
| Safety approved | `safety_approved` | Safety approved (provisional, SCRUM-549) |
| Confirmed | `confirmed` | Confirmed |
| Completed | `completed` | Completed |
| Rejected | `rejected` | Rejected |
| Cancelled | `cancelled` | Cancelled |

### Allowed transitions

Only these transitions are allowed. This story defines which moves are valid; who may perform each one is checked in the story named in the last column.

| From | To | Who, and in which story |
|---|---|---|
| Draft | Submitted | The organiser submits (SCRUM-10). A coordinator is assigned automatically (N04) |
| Submitted | Under review | The assigned coordinator starts reviewing (SCRUM-19) |
| Under review | Pending clarification | The assigned coordinator asks for clarification (SCRUM-162) |
| Pending clarification | Under review | The organiser replies, or the assigned coordinator closes the request (SCRUM-162) |
| Under review | Approved or Rejected | The assigned coordinator decides (SCRUM-19) |
| Approved | Rejected | The assigned coordinator rejects an event whose essential arrangements can't be met (SCRUM-19) |
| Rejected | Draft | The organiser reopens a rejected request to revise and resubmit it (SCRUM-19) |
| Approved | Safety review | The assigned coordinator submits the event for the safety check (SCRUM-489) |
| Safety review | Safety approved | The Safety Officer approves (SCRUM-490) |
| Safety review | Approved | The Safety Officer sends the event back, with reasons (SCRUM-490) |
| Safety approved | Confirmed | The assigned coordinator confirms (SCRUM-363). Replaces Approved to Confirmed, which no longer exists |
| Safety review, Safety approved | Approved | A significant change is accepted, so the event needs re-planning (SCRUM-395) |
| Confirmed | Approved | A significant change is accepted, so the event needs re-planning (N05, N06) |
| Confirmed | Completed | The assigned coordinator marks the event completed after it ends (N23) |
| Submitted, Under review, Pending clarification, Approved, Safety review, Safety approved, Confirmed | Cancelled | The assigned coordinator cancels, including when the organiser asks to withdraw (N08) |

```
Draft -> Submitted -> Under review <-> Pending clarification
                          |
                          +-> Approved -> Safety review -> Safety approved -> Confirmed -> Completed
                          |      ^              |                |
                          |      +--------------+----------------+
                          |      |
                          +------+-> Rejected -> Draft (reopened)

Cancelled: from Submitted, Under review, Pending clarification, Approved, Safety review, Safety approved or Confirmed.
A safety status cannot be rejected: that is SCRUM-347's open decision (docs/SCRUM-488-decisions.md, D4).
```

- **Final statuses.** Completed and Cancelled are final: nothing leads out of them. A cancelled event cannot be reinstated; the organiser submits a new request instead. Rejected is not final, because a rejected request can be reopened as a draft.
- **A refused transition.** Any other transition is refused by the backend with a 409 whose message states the event's current status, and the event is left unchanged. No history row is written.
- **What is built.** The transition rules above are all enforced. Endpoints exist today for Draft → Submitted, asking for clarification, and the organiser's reply. The other transitions are valid in the table but have no endpoint until the story that owns them lands.

### How a status changes

- **One rule, held twice.** `canTransition` is how the service reads the transition table, before it calls the database. The Postgres function `event_request_status_allows` (migration `022`, restated in `063` for the safety statuses) holds the same table, so the database refuses an illegal move whoever calls it, and a test compares the two pair by pair.
- **One mechanism.** `changeEventRequestStatus` (`backend/src/services/eventRequestService.js`) asks `canTransition`, then calls the Postgres function `change_event_request_status` (migration `021`) through RPC. In one transaction that function locks the row, refuses if the status is no longer the one the caller last saw, writes the new status and inserts the history row. Every story that changes a status calls this; none writes the status column itself.
- **Draft → Submitted is the one exception, and it is its own path.** Submitting also assigns a coordinator and sets `submitted_at`, so it goes through `submitEventRequest` and the Postgres function `submit_event_request` (SCRUM-327, replaced in `021`). In one transaction it checks the request is a draft, picks the coordinator with `pick_event_coordinator`, sets the status, `submitted_at` and `assigned_coordinator_id`, writes the assignment history row and writes the status history row. `change_event_request_status` refuses `submitted` as a target, so there is exactly one way to submit, and `event_requests_assigned_when_submitted` (migration `017`) refuses a submitted request with no coordinator.
- **Creating a draft** is not a transition: the row is inserted as `draft` and there is no previous status to record.
- **Clarification conversation.** Only the assigned coordinator can ask a non-blank question while the event is `under_review`; the optional reply-by date must be in the future. The coordinator may select which event fields the organiser can amend in their reply. The owning Organiser can send a non-blank reply and update only those selected fields, atomically; the assigned Coordinator can instead close the open question with a required note. Both return the request to `under_review` and append immutable history. Questions, replies and closures notify the relevant recipient. While a question is open, approval/rejection is unavailable but cancellation remains allowed. Expired reply-by dates are shown as overdue, surfaced in the Coordinator's Needs attention list, and do not automatically change status. Migration `030_event_clarification_reply_by.sql` installs the base history and notifications; `026_clarification_amendment_fields.sql` adds scoped amendments.

### Status history

Each transition records the previous status, the new status, the user who caused it, the date and time, and the reason where one was given. The table is `event_request_status_history` (migration `021`) and its rows are only ever inserted. A status change and its history row succeed or fail together, and a refused or failed transition writes none.

`GET /api/event-requests/:id/status-history` returns an event's full history, oldest first, as `previousStatus`, `newStatus`, the Organiser-facing label for each, `changedByName`, `changedAt` and `reason`. Only the event's Organiser and its currently assigned coordinator can read it; anyone else, and a request that does not exist, gets the same 404. An event with no recorded change returns an empty list. History starts when migration `021` is applied: requests that were already past draft have none.

Two histories exist and they are not merged:

| Table | Records | Written by |
|---|---|---|
| `event_request_status_history` | What stage the event reached: previous status, new status, who, when, why | `change_event_request_status`, and `submit_event_request` for Draft → Submitted |
| `event_request_assignment_history` | Who is responsible for the event: previous coordinator, new coordinator, who assigned, handover note | `submit_event_request` (first assignment), `reassign_event_request` (handover) |

A submission writes one row to each. A handover writes only to the assignment history, because the stage does not change.

### Coordinator columns

- `assigned_coordinator_id` is who holds the event now. It is set on submission and can change hands by handover. Only this person may act on the event, and only this person and the Organiser can read its status history.
- `decided_by` (from SCRUM-19's decision columns) is who decided to approve or reject. It is permanent and must equal `reviewing_coordinator_id`. It does not move when the event is handed over.

They are different facts and the code never uses one for the other.

### Design decisions

- **No separate Planning status.** The customer said Planning is "the same as under review/planning" and that "approval = sufficient info for planning". Internally that stage is Approved; the Organiser sees it labelled "Planning", the customer's own word. The `planning` value is gone from the model, and a database constraint refuses it.
- **Pending clarification is its own status.** The customer allowed a separate status "if the team finds that it makes it more clear". It makes clear to the Organiser that the next move is theirs.
- **Rejected requests can be revised and resubmitted.** The customer said rejection "is not necessarily final". An approved event whose essential arrangements can't be met also becomes Rejected, because the customer said it "gets rejected rather than sitting pending indefinitely".
- **A confirmed event can go back to Approved.** The customer said a confirmed event "can revert if major change occurs and reviewed by the co-ordinator".
- **Cancelled is final.** The customer said "when an event is cancelled, it is cancelled".
- **There is no Withdrawn status.** The customer said the organiser "may request withdrawal via Coordinator", so a withdrawal is a cancellation by the coordinator, with the reason recorded.
- **Drafts are deleted, not cancelled.** A draft has no coordinator yet, so there is nobody to cancel it, and Draft → Cancelled is not a transition.

### Where the implementation differs from the story

- A clarification can be requested only from Under review. The request cannot be approved or rejected while clarification is open; it may be cancelled.
- Clarification history is separate from status history: it records every question, organiser reply and coordinator closure, oldest first, and entries cannot be edited or deleted.
- `planning` is no longer a status in the code, but it is still a value of the database enum, which Postgres cannot shrink. Migration `020` moves any such row to Approved and a constraint refuses the value.
- Migration `062` adds `safety_review` and `safety_approved` to the enum and to the three constraints that list the statuses (`event_requests_status_in_lifecycle`, the two decided-status constraints from `025`, and the status history's). It is one file because it compares `status::text`: Postgres will not accept a new enum value as an enum literal in the transaction that adds it. It moves no event into a new status, and the legal transitions into and out of them are not in it.
- No endpoint deletes a draft yet.
- Moving a request to Approved, Rejected or Confirmed needs the decision columns from SCRUM-19. `change_event_request_status` does not write them, so those transitions will need that story to extend it.
## Development workflow

### Branches

| Branch | Purpose |
|---|---|
| `main` | The shippable increment. Updated only at a sprint boundary, by merging `dev`. Tagged per release (`v0.1.0-sprint1`). |
| `dev` | Default branch and integration target. All feature work merges here during the sprint. |
| `feature/SCRUM-<id>-<slug>` | One branch per user story, cut from `dev`. |

Also in use: `bugfix/SCRUM-<id>-<slug>`, and `hotfix/<slug>` cut from `main` for a broken release.

**One branch per user story, not per person.** Each branch maps to exactly one backlog item, so any requirement can be traced to its commits, its pull request, and its tests.

```bash
git checkout dev
git pull
git checkout -b feature/SCRUM-14-track-event-request-status
```

### Commits

Conventional Commits, prefixed with the Jira ticket:

```
feat(SCRUM-14): add event status badge component
fix(SCRUM-14): handle unknown status values
test(SCRUM-14): cover status transition edge cases
```

### Pull requests

- Feature branch → `dev`. One teammate approval required. **Squash merge**, so each story becomes a single commit on `dev`.
- `dev` → `main` at the end of each sprint. **Merge commit**, so sprint boundaries stay visible in history.
- Describe what changed and link the Jira ticket. Note how you verified it.

### Definition of Done

A story is done when its acceptance criteria are met, it has tests, it has been reviewed and merged to `dev`, and the Jira ticket has been moved to Done.

## Testing

| Command | What it proves | Needs credentials |
|---|---|---|
| `npm test` | The unit suite. Run on every pull request by CI. | No |
| `npm run db:check` | The migrations were applied and the seed data landed. | Yes |
| `npm run venue:check` | The venue service end to end: the transactional RPCs, the schema constraints, the audit trigger and retirement, against a real database. | Yes |
| `npm run routes:check` | The event request routes end to end: a real Supabase token through the auth middleware, ownership scoping against row level security, and a status change reaching the client. | Yes |
| `npm run venue-routes:check` | The venue catalogue routes end to end, one block per SCRUM-15 acceptance criterion: creation, an authorised change reaching the search, retirement leaving the search while its bookings survive, and the audit trail naming the editing user. | Yes |
| `npm run venue-blocks:check` | Venue blocks end to end, against a real database: half-open periods, an override flagging the booking and notifying every Event Coordinator, amend and remove recording the acting user, the audit trail, and a blocked venue leaving search. | Yes |
| `npm run venue-calendar:check` | The venue calendar route end to end, one block per SCRUM-178 acceptance criterion: real tokens for Venue Staff and Event Coordinators on an active and a retired venue, approved and flagged bookings and blocks soonest first, a pending request, cancelled booking, removed block and edge-touching block left out, and Organisers and Attendees refused. | Yes |
| `npm run booking-requests:check` | Venue booking requests (SCRUM-243) against the live database, needing migrations 027 to 031 and 051: the pending default, the coordinator's list scoped to the assigned coordinator, and real concurrent races (one event at several venues, all created; one event twice at one venue, one created; two at one venue and one at another, one per venue (SCRUM-525); a request against a venue block, two withdrawals, a withdrawal against a status change and against a handover). What it proves and cannot is in `docs/SCRUM-243-test-map.md`. | Yes |

Run them all from `backend/`.

Test files live in `backend/tests/`, mirroring `backend/src/`. Each `describe` block is named after the acceptance criterion it proves, so a requirement traces to the test that covers it without a separate document to keep in step.

Tests that would otherwise reach Supabase replace the client with a mock, which is what lets the suite run in CI with no `.env`. The one exception is deliberate: `backend/tests/config/supabaseClient.test.js` re-imports the real module to prove it refuses a half-configured environment.

### Why the migrations have no unit tests

`backend/db/migrations/` is DDL that only Postgres can execute. Testing it means running it, which needs a live database and a secret key — and that key bypasses row level security entirely, so it does not belong in CI. The two check scripts above are the proof instead, run by hand before opening a pull request. `backend/tests/domain/eventRequestStatus.test.js` covers the one part that can be checked statically: it reads the status enum out of `001_event_requests.sql` and the later `alter type ... add value` migrations and asserts the JavaScript vocabulary still matches it. The one exception is the event status lifecycle: `backend/tests/db/eventStatusLifecycleDatabase.test.js` applies the real migrations to an in-process Postgres (PGlite), which needs no server and no key, so CI can prove the lifecycle functions, the history and the status constraints, including that a failed change rolls back. It cannot open a second connection, so true parallel transitions are proved by `npm run request:check`.
