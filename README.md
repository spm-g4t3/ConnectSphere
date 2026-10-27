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

**Database.** The shared Supabase project already has the full schema; do not re-run anything against it. For a fresh Supabase project, run `backend/db/baseline/01_foundation.sql` to `09_event_workflows.sql` in order in the SQL editor, then each file in `backend/db/migrations/` (numbered from 010) in order. How to write a schema change, apply it to live and check live afterwards is in [backend/db/migrations/AGENTS.md](backend/db/migrations/AGENTS.md).

PR #68 (SCRUM-494) is merged into dev and included here with its organiser settings API/UI. `registrations` is a read-only compatibility view over `event_registrations`. Feature flags remain removed, so database-first deployment is required.

Registered attendees (SCRUM-24) reach **Registered events** from navigation or the dashboard. `GET /api/attendee-events` lists the caller's active registrations; `GET /api/attendee-events/:id` returns one registered event's name, confirmed date and times, and venues (`venues.name`, `venues.location`). Approved bookings are listed, and so are flagged ones, with `underReview: true` and no flag reason, because a flag leaves the venue in place until it is resolved. Only the verified Attendee's own `registered` row grants access, whatever the registration window, capacity or start time. A non-confirmed event returns only `{ eventRequestId, registrationId, state: "unavailable", eventName }`, so a significant change hides the old arrangements until the event is confirmed again. SCRUM-24 adds no migrations. PGlite runs the SQL equivalent of the nested PostgREST read, so verify the embedded relationships on the deployed API.

Registered attendees withdraw (SCRUM-27) from that event page. `POST /api/attendee-events/registrations/:registrationId/withdrawal` takes the attendee from the token and calls `withdraw_registration` (migrations 017 and 018), which locks the event and then the registration, as `register_for_event` does, and sets a `registered` row to `withdrawn`. The row is kept, and the attendee can register again later. Only the attendee's own `registered` row can be withdrawn, only while the event is in one of `ACTIVE_EVENT_STATUSES` and has not started, and only strictly before its withdrawal deadline. Cancelling, rejecting or completing an event leaves its registrations as they were, so the event's status is what refuses them (`EVENT_NOT_ACTIVE`, without naming the status); a start moved before the deadline wins (`EVENT_STARTED`). An event with no deadline refuses every withdrawal (`WITHDRAWAL_DEADLINE_NOT_SET`) until that rule is decided. Someone else's registration answers the same 404 as a missing one. The registered total is derived from `registered` rows, so the status change releases the place; the reply reports `placesLeft` and `isFull`. Concurrent withdrawals and a withdrawal racing a registration are checked by hand with `backend/tests/db/registrationWithdrawalConcurrency.manual.sql`, because PGlite has one connection.

Waiting lists (SCRUM-460, migration 037) are switched on by the Organiser with the other registration settings (`waitlistEnabled`). While a full event's list is on, an Attendee joins it from the event page (`POST /api/open-events/:id/waitlist`, `join_event_waitlist`); joining is never a fallback of registering, but a join that finds a free place registers. My Registrations lists the caller's places and positions (`GET /api/attendee-events/waitlist`), and `POST /api/attendee-events/registrations/:registrationId/leave-waitlist` gives one up (the row becomes `withdrawn`, so the attendee can rejoin at the back). Positions are derived from `waitlisted_at`, never stored. `promote_waitlisted_registrations` hands free places to the longest-waiting attendees and sends each a `registration_promoted` notification. It runs inside `withdraw_registration` and `setup_event_registration` (a higher or removed capacity, or reopened registration), under the event row lock every registration writer takes, so one released place gives exactly one promotion. It promotes nobody while registration is closed. Registration can also reopen with no write, when its opening time passes, so a once-a-minute job in the API process (`backend/src/jobs/waitlistPromotionScheduler.js`, `process_waitlist_promotions`) hands out places freed while it was closed; `WAITLIST_PROMOTION_JOB=off` turns it off. A Register or Join that promotes its own caller answers `registered`, not "already registered". Switching the list off stops new joins but keeps the queue. The Organiser and the assigned Coordinator read the totals from `GET /api/registration/events/:id/counts` (`event_registration_counts`); attendees see only their own position. The two-session races are in `backend/tests/db/eventWaitingListConcurrency.manual.sql`.

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

- **One rule, held twice.** `canTransition` is how the service reads the transition table, before it calls the database. The Postgres function `event_request_status_allows` (`backend/db/baseline/02_event_requests.sql`) holds the same table, so the database refuses an illegal move whoever calls it, and a test compares the two pair by pair.
- **One mechanism.** `changeEventRequestStatus` (`backend/src/services/eventRequestService.js`) asks `canTransition`, then calls the Postgres function `change_event_request_status` (`02_event_requests.sql`) through RPC. In one transaction that function locks the row, refuses if the status is no longer the one the caller last saw, writes the new status and inserts the history row. Every story that changes a status calls this; none writes the status column itself.
- **Draft → Submitted is the one exception, and it is its own path.** Submitting also sets `submitted_at` and clears any earlier coordinator, so it goes through `submitEventRequest` and the Postgres function `submit_event_request` (`02_event_requests.sql`). In one transaction it checks the request is a draft, sets the status and `submitted_at`, clears `assigned_coordinator_id` and `reviewing_coordinator_id`, writes the status history row and notifies every Event Coordinator Lead. No coordinator is picked: the request waits in the Lead's unassigned queue until `assign_event_request` assigns one. `change_event_request_status` refuses `submitted` as a target, so there is exactly one way to submit, and `event_requests_assigned_when_submitted` refuses a request past Submitted (other than Cancelled) with no coordinator.
- **Creating a draft** is not a transition: the row is inserted as `draft` and there is no previous status to record.
- **Clarification conversation.** Only the assigned coordinator can ask a non-blank question while the event is `under_review`; the optional reply-by date must be in the future. The coordinator may select which event fields the organiser can amend in their reply. The owning Organiser can send a non-blank reply and update only those selected fields, atomically; the assigned Coordinator can instead close the open question with a required note. Both return the request to `under_review` and append immutable history. Questions, replies and closures notify the relevant recipient. While a question is open, approval/rejection is unavailable but cancellation remains allowed. Expired reply-by dates are shown as overdue, surfaced in the Coordinator's Needs attention list, and do not automatically change status. The history table `event_request_clarification_history` and its functions are in `02_event_requests.sql`.

### Status history

Each transition records the previous status, the new status, the user who caused it, the date and time, and the reason where one was given. The table is `event_request_status_history` (`02_event_requests.sql`) and its rows are only ever inserted. A status change and its history row succeed or fail together, and a refused or failed transition writes none.

`GET /api/event-requests/:id/status-history` returns an event's full history, oldest first, as `previousStatus`, `newStatus`, the Organiser-facing label for each, `changedByName`, `changedAt` and `reason`. Only the event's Organiser and its currently assigned coordinator can read it; anyone else, and a request that does not exist, gets the same 404. An event with no recorded change returns an empty list. History starts when migration `021` is applied: requests that were already past draft have none.

Two histories exist and they are not merged:

| Table | Records | Written by |
|---|---|---|
| `event_request_status_history` | What stage the event reached: previous status, new status, who, when, why | `change_event_request_status`, and `submit_event_request` for Draft → Submitted |
| `event_request_assignment_history` | Who is responsible for the event: previous coordinator, new coordinator, who assigned, handover note | `assign_event_request` (the Lead's first assignment), `reassign_event_request` (handover) |

A submission writes a status history row; the Lead's assignment and any handover write only to the assignment history, because the stage does not change.

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
- `planning` is no longer a status in the code, but it is still a value of the database enum, which Postgres cannot shrink, so the constraint `event_requests_status_in_lifecycle` refuses the value.
- `safety_review` and `safety_approved` are in the enum and in the three constraints that list the statuses (`event_requests_status_in_lifecycle`, the two decided-status constraints, and the status history's). Those constraints compare `status::text`, because Postgres will not accept a new enum value as an enum literal in the transaction that adds it.
- No endpoint deletes a draft yet.
- Moving a request to Approved, Rejected or Confirmed needs the decision columns from SCRUM-19. `change_event_request_status` does not write them, so those transitions will need that story to extend it.

## Event registration

Event Organisers configure registration for their own events from **My Events** while the event is Approved, Safety review, Safety approved or Confirmed (`backend/src/domain/registrationStatuses.js`). Registration is off by default; settings include the opening and closing times, an optional positive capacity, and an optional withdrawal deadline. Registration needs an opening time while it is on; the closing time is optional, and without one registration stays open until the Organiser switches it off. Switching registration off is always allowed, even when the saved dates no longer fit the event start.

The settings columns are on `event_requests`; the settings audit history and the transactional functions are in `backend/db/baseline/08_registration.sql`; the attendee registrations table (`status` registered, withdrawn or waitlisted) is read here only to stop the capacity dropping below the registered count. Settings changes are limited to the event's Organiser, checked in SQL as well as by the route; the assigned Coordinator cannot change them. Each changed settings snapshot records the acting user and timestamp. Returning a Confirmed event to Approved preserves its settings. A change to the event start that clashes with the registration dates still goes through; the Organiser and the assigned Coordinator get a `registration_schedule_conflict` notification naming the dates to adjust.

Run `npm --prefix backend test -- tests/db/eventRegistrationDatabase.test.js` to exercise the registration functions against PGlite.

### Waiting-list data model (SCRUM-472, migration 037)

For SCRUM-473 (join and leave) and SCRUM-474 (promotion) to build on.

- **Status.** `event_registrations.status` is one of `registered`, `withdrawn`, `waitlisted` or `cancelled` (`backend/src/domain/registrationStatus.js`, mirrored in `frontend/src/services/registrationStatus.js`; a domain test checks both against the SQL constraint). Only `registered` holds a place. Every capacity count filters `status = 'registered'`. `withdrawn` may register or join again on the same row. `cancelled` is final.
- **One entry per attendee and event.** The unique constraint `event_registrations_attendee_once (event_request_id, attendee_id)` keeps a single row, whatever its status, so a waiting-list entry and a registration can never both exist. Joining, leaving, promotion and withdrawal change that row's status. They never insert a second row.
- **Queue order.** FIFO by `waitlisted_at`, then `id`. The trigger `event_registrations_stamp_waitlisted_at` stamps `waitlisted_at` with `clock_timestamp()` whenever a row becomes `waitlisted` (an insert without a time, or a status change), so rejoining goes to the back. Writers take the event row lock before reading the clock, so times rise in join order. `id` only breaks an exact tie, and never changes. The constraint `event_registrations_waitlisted_has_time` refuses a waitlisted row without a time. Leaving keeps the old time as history.
- **Position.** Calculated, never stored: `waitlist_position(registration)` is the 1-based count of waitlisted rows for the same event at or before this one in queue order, or null when not waitlisted. It is correct after any departure or promotion without updates. Read it through `open_event_registration_state(...).waitlist_position` (browse) or `list_attendee_waitlist(attendee)` (My Registrations).
- **Indexes.** `idx_event_registrations_waitlist (event_request_id, waitlisted_at, id) where status = 'waitlisted'` serves queue order, positions and promotion. `idx_event_registrations_attendee_waitlist (attendee_id, waitlisted_at desc) where status = 'waitlisted'` serves an attendee's own list.
- **Setting.** `event_requests.registration_waitlist_enabled`, default `false`: an event has no waiting list until its Organiser turns one on. It is changed only through `setup_event_registration`'s last argument, `p_waitlist_enabled` (null keeps the saved value), with the same Organiser-only checks and audit history as the other settings. The API field is `waitlistEnabled` on `PUT /api/registration/events/:id/settings`. Switching it off stops joins only.
- **Contracts.**
  - `join_event_waitlist(event, attendee)` returns `{ outcome: 'waitlisted', created, registration: { id, eventRequestId, attendeeId, status, waitlistedAt, waitlistPosition, createdAt, updatedAt } }` (`created` is false for a repeat join, whose entry is returned unchanged), or `register_for_event`'s `{ outcome: 'registered', ... }` when a place is free. Otherwise `outcome` is `not_found`, `forbidden`, `already_registered`, `registration_cancelled` or `waitlist_disabled`.
  - `leave_event_waitlist(registration, attendee)` returns `{ outcome: 'left_waitlist', registration }`. It raises P0002 for a missing or someone else's row, 55000/`ALREADY_REGISTERED` once promoted and 55000/`NOT_WAITLISTED` once left.
  - `promote_waitlisted_registrations(event)` returns the number promoted. It promotes nobody while `registration_closed_reason` is non-null. Call it after any change that frees places, inside the same transaction and after taking the event row lock. See "Promotion and locking" below.
  - `event_registration_counts(event, user)` returns `{ eventRequestId, capacity, waitlistEnabled, registeredCount, waitlistCount }`, for the Organiser or assigned Coordinator only.

### Checking the waiting list by hand (SCRUM-475)

Use a local or disposable database, never the shared Supabase project, with migration 037 applied. You need one Organiser, the event's assigned Coordinator, a second Coordinator and three Attendees (A, B, C), and one Confirmed event that the Organiser owns.

1. **Switch the list on.** As the Organiser, open My Events → Registration for the event and choose Configure registration. Turn registration on, set the opening time in the past and capacity 1, tick "Waiting list is on", and save. The summary shows Waiting list: On and Waitlisted: 0.
2. **Fill the event.** As A, open Browse Open Events, then the event, and choose Register. It shows "Already registered".
3. **Join.** As B, open the event. It shows Full and "Join waiting list". Choose it. The button reads "Joining..." and is disabled, then the page says "You are on the waiting list for … at position 1", the button changes to a disabled "On the waiting list", and Availability shows "Waitlisted: position 1". Join as C the same way; C sees position 2.
4. **See the position.** As C, open Registered events. Under Waiting lists, the event shows "Waitlisted: position 2". In Browse Open Events, the event's row shows the same badge.
5. **Leave.** As B, open Registered events and choose Leave waiting list, then Confirm leaving. It shows "Leaving...", then "You have left the waiting list for …", and the entry disappears. Switch to C's tab (or refocus it): C now shows position 1.
6. **Promotion.** Have B join again (B is now behind C). As A, open the event under Registered events and withdraw. Then return to C's tab: the event has moved from Waiting lists to the registered list, C's notifications show "You have a place at …", and its link opens the event page. B now shows position 1.
7. **Free place.** As the Organiser, raise the capacity to 3 and save. B is promoted (Waitlisted: 0 in the summary). A new attendee who opens the event now sees Register, not Join.
8. **Staff counts.** As the assigned Coordinator, open the event's review page: the Registrations panel shows Registered and Waitlisted. As the second Coordinator, `GET /api/registration/events/:id/counts` answers 403, and the panel does not appear.
9. **List off.** As the Organiser, untick the waiting list and fill the event. A new attendee sees "This event is full." and no Join button. Anyone already waiting stays queued.

### Promotion and locking (SCRUM-474)

- **One operation.** `promote_waitlisted_registrations(event)` is the only code that turns `waitlisted` into `registered`. A test checks the function sources so a second one cannot appear unnoticed. It is called by:
  - `withdraw_registration`, after the place is released;
  - `setup_event_registration`, after a capacity increase or removal, or registration reopened;
  - the `event_requests_promote_waitlist_on_confirmation` trigger, when an event returns to Confirmed;
  - `register_for_event` and `join_event_waitlist`, before they count capacity. A place freed while promotion was blocked (registration closed, or the event briefly not Confirmed) therefore goes to the queue before any newcomer.
- **What it does.** It recounts free places from the `registered` rows, gives them to the earliest `waitlisted` entries in queue order, and inserts one `registration_promoted` notification per promoted attendee. Each notification goes to the attendee (`recipient_id`) and names the event (`event_request_id`). The payload is `{ eventRequestId, eventName, registrationId, waitlistedAt }`. It does nothing while registration is closed.
- **Transaction boundary.** One RPC is one transaction. The status change that frees the place, the promotion and the notification commit together or not at all: a rollback leaves no promotion and no notification.
- **Lock order.** Every writer takes the same locks in the same order: the `event_requests` row (`FOR UPDATE`), then the `event_registrations` rows, then the `notifications` insert. Concurrent withdrawals, joins, departures, registrations, capacity saves and confirmations of one event therefore run one after another, each seeing the last one's committed result, and cannot deadlock on each other. A test checks that every function writing registrations takes the event lock before touching a registration row.
- **Idempotent.** Free places are recomputed on every call, so processing the same release again promotes nobody. The unique index `notifications_one_per_registration_promotion` on `(payload->>'registrationId', payload->>'waitlistedAt')` refuses a second notice for the same queue entry. `waitlistedAt` is written as UTC text, so the key doesn't depend on the session's time zone. Rejoining later is a new entry and is notified again.
- **Delivery.** Through SCRUM-177's in-app notifications: `GET /api/notifications` (any signed-in user, scoped to the caller) and the attendee dashboard's inbox, with the wording "You have a place at …", linking to the registered event page. No email channel exists; the requirements accept in-app.
- **Evidence.** `backend/tests/db/scrum474PromotionDatabase.test.js` (PGlite) covers queue order, counts, gating, the bypass paths, an injected failure after promotion, replays, and the lock-order source checks. PGlite has one connection, so the races also run on a real server (SCRUM-476): `backend/tests/db/waitingListConcurrency.realdb.test.js` opens independent connections, waits until PostgreSQL reports the second one blocked on the first's lock, and then commits or rolls back the first. It is skipped unless `CONCURRENCY_DATABASE_URL` names a disposable server, so CI is unaffected. To run it (inside `backend/`):

  ```bash
  docker run -d --rm --name connectsphere-race-pg -e POSTGRES_PASSWORD=race -p 127.0.0.1:55432:5432 postgres:17-alpine
  CONCURRENCY_DATABASE_URL=postgres://postgres:race@127.0.0.1:55432/postgres npm run test:concurrency
  docker stop connectsphere-race-pg
  ```

  It builds the schema in its own database (`connectsphere_concurrency`, dropped and recreated each run) and refuses Supabase hosts. `eventWaitingListConcurrency.manual.sql` keeps the same races as psql steps.

### Waiting-list API for the UI (SCRUM-473)

All three need `Authorization: Bearer <token>` for an Attendee, take no body, and answer `Cache-Control: no-store`. The attendee is always the token's user, never a parameter. Errors are `{ error, code?, details? }`, as elsewhere in the API.

**`POST /api/open-events/:eventId/waitlist`**: join.

| Status | Body | When |
|---|---|---|
| 201 | `{ id, eventRequestId, attendeeId, status: "waitlisted", waitlistPosition, waitlistedAt, createdAt, updatedAt }` | Queued. `waitlistPosition` is 1-based and current. |
| 201 | `{ id, eventRequestId, attendeeId, status: "registered", waitlistPosition: null, registeredAt, createdAt, updatedAt }` | A place was free, so the attendee was registered as `POST .../registrations` would. Show the status, not the button the attendee pressed. |
| 200 | as the waitlisted 201 | A repeat join: the same entry, with its queue time and position unchanged. |
| 400 | `details[].field` is `eventId` | Malformed event id. |
| 401 / 403 | | No valid token / not an Attendee. |
| 404 | `error: "This event is not open for registration"` | Missing, not Confirmed, registration off, not yet open, closed or started: the same checks and answer as registering. |
| 409 | `code: "WAITLIST_DISABLED"`, `error: "Event is full and has no waiting list"` | Full, and the Organiser has not turned the list on. |
| 409 | `code: "ALREADY_REGISTERED"` or `"REGISTRATION_CANCELLED"` | Already holds a place, or the registration is cancelled for good. |
| 409 | `code: "REGISTRATION_CHANGED"` | A concurrent change; safe to retry. |
| 503 | | Registration is temporarily unavailable. |

**`POST /api/attendee-events/registrations/:registrationId/leave-waitlist`**: leave. This is not a withdrawal: no withdrawal deadline, registration window or event start applies. The entry becomes `withdrawn`, everyone behind moves up one place, and the registered count does not change.

| Status | Body | When |
|---|---|---|
| 200 | `{ id, eventRequestId, attendeeId, status: "withdrawn", createdAt, updatedAt }` | Left. |
| 400 | `error: "Invalid waiting-list request"` | Malformed id. |
| 401 / 403 | | No valid token / not an Attendee. |
| 404 | `error: "Waiting-list entry not found"` | Missing, or someone else's (the two are indistinguishable). |
| 409 | `code: "ALREADY_REGISTERED"` | Promoted before the request arrived. The place is kept; withdrawing is the way out. |
| 409 | `code: "NOT_WAITLISTED"` | Already left, or not a waiting-list entry. |
| 409 | `code: "REGISTRATION_CHANGED"` | A concurrent change; safe to retry. |
| 503 | `error: "Waiting lists are temporarily unavailable. Please try again later."` | |

**`GET /api/attendee-events/waitlist`**: the caller's entries, newest first: `[{ registrationId, eventRequestId, eventName, waitlistPosition, waitlistedAt }]`.

Withdrawing (`.../withdrawal`) still refuses a waitlisted entry (`REGISTRATION_NOT_CONFIRMED`), and leaving refuses a registered one, so neither endpoint acts on the other's entries. Joins, departures, registrations and promotions are serialised by the event row lock in the database, never by the client or the API process. `backend/tests/db/eventWaitingListConcurrency.manual.sql` covers the two-session races.


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
| `npm run db:check` | The schema was applied and the seed data landed. | Yes |
| `npm run venue:check` | The venue service end to end: the transactional RPCs, the schema constraints, the audit trigger and retirement, against a real database. | Yes |
| `npm run routes:check` | The event request routes end to end: a real Supabase token through the auth middleware, ownership scoping against row level security, and a status change reaching the client. | Yes |
| `npm run venue-routes:check` | The venue catalogue routes end to end, one block per SCRUM-15 acceptance criterion: creation, an authorised change reaching the search, retirement leaving the search while its bookings survive, and the audit trail naming the editing user. | Yes |
| `npm run venue-blocks:check` | Venue blocks end to end, against a real database: half-open periods, an override flagging the booking and notifying every Event Coordinator, amend and remove recording the acting user, the audit trail, and a blocked venue leaving search. | Yes |
| `npm run venue-calendar:check` | The venue calendar route end to end, one block per SCRUM-178 acceptance criterion: real tokens for Venue Staff and Event Coordinators on an active and a retired venue, approved and flagged bookings and blocks soonest first, a pending request, cancelled booking, removed block and edge-touching block left out, and Organisers and Attendees refused. | Yes |
| `npm run booking-requests:check` | Venue booking requests (SCRUM-243) against the live database: the pending default, the coordinator's list scoped to the assigned coordinator, and real concurrent races (one event at several venues, all created; one event twice at one venue, one created; two at one venue and one at another, one per venue (SCRUM-525); a request against a venue block, two withdrawals, a withdrawal against a status change and against a handover). What it proves and cannot is in `docs/SCRUM-243-test-map.md`. | Yes |

Run them all from `backend/`.

Test files live in `backend/tests/`, mirroring `backend/src/`. Each `describe` block is named after the acceptance criterion it proves, so a requirement traces to the test that covers it without a separate document to keep in step.

Tests that would otherwise reach Supabase replace the client with a mock, which is what lets the suite run in CI with no `.env`. The one exception is deliberate: `backend/tests/config/supabaseClient.test.js` re-imports the real module to prove it refuses a half-configured environment.

### Database tests

`backend/tests/db/` runs the SQL functions, triggers and constraints in an in-process Postgres (PGlite), which needs no server and no key, so CI proves them, including that a failed change rolls back. Each suite builds the schema with `createSchemaDb()`: the baseline files, then every migration from 010 on. `backend/tests/domain/` reads the enum labels and CHECK lists from that built schema and asserts the JavaScript vocabularies still match. PGlite has a single connection, so true parallel races are proved by the live check scripts above (such as `npm run request:check`) and the `*.manual.sql` scripts in `backend/tests/db/`.
