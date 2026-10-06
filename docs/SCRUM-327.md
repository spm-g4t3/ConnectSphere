# SCRUM-327 — Assign and Reassign an Event Coordinator

**Story:** Assign and Reassign an Event Coordinator
**Closing subtask:** SCRUM-336 (this document)
**Status as of 3 October 2026:** closed, with the gaps in section 4 recorded rather than hidden.

This document is the record of what SCRUM-327 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks that chain end to end for three criteria,
and the rest can be derived from them.

---

## Subtasks and what each delivered

| Subtask | Delivered | Where |
|---|---|---|
| SCRUM-328 | The assignment column, the history table, the first backfill | `db/migrations/014_coordinator_assignment.sql` |
| SCRUM-329 | The selection rule | `015_assignment_function.sql` — `pick_event_coordinator` |
| SCRUM-330 | Assignment on submission, then the constraint | `016_submit_event_request.sql`, `017_require_assigned_coordinator.sql`, `submitEventRequest` |
| SCRUM-331 | Reassignment | `018_reassign_event_request.sql`, `reassignEventRequest`, `POST /:id/reassign`, `ForbiddenError` |
| SCRUM-332 | Only the assigned coordinator changes an event; every coordinator reads one | `019_change_request_decision_coordinator.sql`, `requestEventClarification`, `getEventRequestForCoordinator`, `GET /:id/review` |
| SCRUM-333 | "My events" | `listEventRequestsForCoordinator`, `GET /mine`, `MyAssignedEvents.jsx` |
| SCRUM-334 | The coordinator list, the assignment history, the reassign screen | `listCoordinators`, `listAssignmentHistory`, `GET /coordinators`, `GET /:id/assignments(/review)`, `AssignmentHistory.jsx`, `ReassignEventPanel.jsx` |
| SCRUM-335 | The live-database check | `scripts/check-coordinator-assignment.js` (`npm run assignment:check`) |
| SCRUM-336 | This document | `docs/SCRUM-327.md` |

### Verification as of 3 October 2026

| Evidence | Result |
|---|---|
| Unit suite (`npm test`) | 1030 tests passing across 16 files, all against fake clients |
| `npm run assignment:check` | 41 checks passing against the live database; leaves every table count as it found it |
| `npm run request:check`, `routes:check`, `change-request:check` | All passing |
| Manual UI walkthrough | Assignment on submission; My Events for two coordinators; the coordinator section and history; a reassignment; the Organiser's note-free view; the permission refusals |

The unit suite and the check script prove different things, and the difference
matters under questioning. A unit test proves the service calls the right
function with the right arguments and turns each SQLSTATE into the right error.
It cannot prove the function itself behaves, because a fake returns whatever it
is given. The check script runs the real functions against the real database.

---

## A warning about the wording below

The acceptance criteria below are written **as the code reflects them**. The code
cites AC1, AC2, AC5, AC6, AC7, AC9, AC10 and AC11 by number with paraphrased text.
AC3 and AC4 are inferred: SCRUM-329 was briefed as "the selection rule (AC2–4)",
and 015 implements a tie-break and a resubmission step that its header says "the
story requires". **AC8 is cited nowhere in the code at all.**

Before the examination, check every row against the Jira ticket, and AC3, AC4 and
AC8 in particular. If the ticket's wording differs, the ticket wins, and this
document should be corrected rather than defended.

---

## 1. Acceptance criteria

| AC | Criterion, as the code reflects it | Status |
|---|---|---|
| AC1 | A submitted event request is assigned an Event Coordinator automatically, as part of submission | **Done** |
| AC2 | The coordinator chosen is the one with the fewest active events (the AC names five active statuses) | **Done**, with a deliberate divergence: `planning` is counted too |
| AC3 | A tie on active events goes to whoever has gone longest without a new assignment | **Done** (wording inferred) |
| AC4 | A resubmitted event returns to its previous coordinator, if they still hold the role | **Partial** (wording inferred): implemented, unreachable, untested |
| AC5 | With no coordinator available, submission is refused with a message saying so, and the request stays a draft | **Done** in code and unit tests; cannot be exercised live |
| AC6 | Only the assigned coordinator can hand the event to a colleague, and only in submitted, under review, pending clarification, approved or confirmed | **Done** |
| AC7 | After a handover, the new coordinator can carry out every coordinator action; the previous one can view the event but no longer change it | **Done** in the backend; the UI still offers refused actions (section 4) |
| AC8 | *Not reflected anywhere in the code* | **Deferred — unverified** |
| AC9 | Every handover records who made it, and the optional note | **Done** |
| AC10 | The Organiser's event screen shows the current coordinator's name and the assignment history | **Done**; the name is behind one click on the Organiser's list |
| AC11 | Each coordinator has a "My events" list: the events assigned to them, grouped by status, earliest event first | **Done** |

**Tally:** 9 done, 1 partial (AC4), 1 deferred and unverified (AC8).

### Evidence for each criterion

#### AC1 — assigned on submission

| Layer | Evidence |
|---|---|
| Migration | `016` `submit_event_request`: locks the row, checks it is a draft, calls `pick_event_coordinator`, writes the status, `submitted_at` and the coordinator in one update, and inserts the first history row (`previous_coordinator_id` null, `assigned_by` null), all in one transaction |
| Service | `submitEventRequest` — validates the stored draft, then `rpc('submit_event_request')`; makes no write of its own |
| Route | `POST /api/event-requests/:id/submit`, behind the Organiser ownership pre-check |
| Unit tests | `SCRUM330_AC1_assigns_a_coordinator_on_submission`, `…_submits_only_through_the_function`, `…_never_assigns_a_coordinator_to_an_incomplete_draft`, `…_returns_the_assigned_coordinator_in_camelCase`, `…_leaves_the_draft_check_to_the_function` (service suite) |
| Check script | Section 2: "the submission wrote exactly one history row", "it is a first assignment: no previous coordinator", "made by the system: assigned_by is null" |
| Screen | An Organiser submits; the event appears in the assigned coordinator's My Events at once |

#### AC2 — fewest active events

| Layer | Evidence |
|---|---|
| Migration | `015` `pick_event_coordinator`, steps 2–4: `order by` the count of active events, then `max(history.created_at) asc nulls first`, then `profiles.id` |
| Check script | Section 1: "fewest active events wins, ahead of who waited longest" |
| Divergence | 015 counts six statuses as active; the AC names five. `planning` is the sixth (design decision D3) |

#### AC3 — the tie-break

| Layer | Evidence |
|---|---|
| Migration | `015` step 3, `max(h.created_at) asc nulls first` |
| Check script | Section 1: "on a tie, the coordinator longest without a new assignment wins" and "a coordinator never assigned anything sorts first" |

#### AC4 — resubmission returns to the previous holder (partial)

015's step 1 implements it: the newest history row's coordinator gets the event
back if they still hold the role. **No path can reach it.** `ALLOWED_TRANSITIONS`
has no transition back to `draft`, so a request is submitted once and never again.
015's header says this in so many words. No unit test can cover it, because the
step lives inside a Postgres function, and the check script cannot reach it
either, because nothing moves an event back to draft. It is correct, but
unproven, for whichever story adds a path back.

#### AC5 — no coordinator available

| Layer | Evidence |
|---|---|
| Migration | `015` returns null rather than raising (D11); `016` raises `No coordinator is available; please try again later` as `P0001`, which rolls back, so the request stays a draft |
| Service | `translateError` maps `P0001` to `ServiceUnavailableError` (503), passing the message through |
| Unit tests | `SCRUM330_AC5_refuses_when_no_coordinator_is_available`; the `ServiceUnavailableError` rows in `tests/errors.test.js` |
| Screen | `EventRequestForm` shows `err.response.data.error`, so the Organiser sees the AC's own message |
| Not live-tested | Proving it against the database needs zero coordinators in the shared project, which means taking the role away from real users |

#### AC6 — only the assigned coordinator hands over, in five statuses

| Layer | Evidence |
|---|---|
| Migration | `018` `reassign_event_request`: `for update` on the event; refuses a null or non-matching caller (`42501`); refuses any status outside the five (`55000`) |
| Service / route | `reassignEventRequest`; `POST /:id/reassign` behind `coordinatorOnly`, with no ownership pre-check (D9) |
| Unit tests | `SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over`, `…_refuses_a_status_that_does_not_allow_a_handover`, `…_an_organiser_is_refused_with_403_and_never_queries`, `…_returns_401_without_a_token_and_never_queries` |
| Check script | Section 4: the 42501, 55000 and null-caller refusals |
| Screen | The hand-over button appears only when `user.id` matches the event's assigned coordinator |

#### AC7 — the new coordinator acts; the previous one only views

| Layer | Evidence |
|---|---|
| Migrations | `018` moves `reviewing_coordinator_id` with the event while no decision exists; `019` makes `process_change_request` refuse anyone but the assigned coordinator |
| Service | `requestEventClarification` refuses a caller who is not the assigned coordinator (`ForbiddenError`), and guards its update on `assigned_coordinator_id`; `getEventRequestForCoordinator` reads for any coordinator |
| Route | `GET /:id/review` behind `coordinatorOnly` |
| Unit tests | Every `SCRUM332_AC7_*`, and `SCRUM331_AC7_the_new_coordinator_can_act_on_the_event` |
| Check script | Section 5, plus "and the reviewer moves with it" in section 4 |
| Scope note | "Every coordinator action" means every one that exists: clarification, change-request decisions and handover. Approve and reject belong to SCRUM-19 and do not exist on this branch |

#### AC8 — deferred and unverified

No file in the repository cites AC8. The code jumps from AC7 to AC9. Either the
criterion was merged into another during planning, or it was never implemented.
One candidate is a notification to the new coordinator: `dev` has a
`notifications` route this branch lacks. That is a guess, not a finding. **Read
AC8 off the Jira ticket and record the answer here before the examination.**

#### AC9 — the handover records who and the note

| Layer | Evidence |
|---|---|
| Migration | `018` inserts a history row with `previous_coordinator_id`, `new_coordinator_id`, a non-null `assigned_by` and `handover_note`; `014` defines a null `assigned_by` as "the system did it" |
| Service | `reassignEventRequest` sends a blank note as null; `listAssignmentHistory` returns `automatic` and the names |
| Unit tests | `SCRUM331_AC9_records_who_handed_it_over`, `…_sends_an_omitted_or_blank_note_as_null`, `…_writes_nothing_outside_the_function`; the `SCRUM334_AC9_*` history and coordinator-list tests |
| Check script | Section 4: "a real person as assigned_by, not the system", "with the note" |
| Screen | `ReassignEventPanel`: picker, optional note, confirm; the history then shows "Handed from A to C … by A" with the note |

#### AC10 — the Organiser sees the coordinator and the history

| Layer | Evidence |
|---|---|
| Service | `listAssignmentHistory(id, { includeNotes: false })` — the note column is not even selected |
| Route | `GET /:id/assignments`, behind the Organiser ownership pre-check |
| Unit tests | `SCRUM334_AC10_*`, including `…_withholds_the_handover_note_from_the_organiser` (service and route) |
| Check script | Section 6: "the Organiser's view has no handoverNote key at all" |
| Screen | `MyEventRequests` — "Your coordinator and assignment history", a collapsed `<details>` on each submitted request |

#### AC11 — My events

| Layer | Evidence |
|---|---|
| Service | `listEventRequestsForCoordinator` — `assigned_coordinator_id = caller`, every status, `proposed_start asc nulls last`, then `id`, with `organiserName` read from `profiles` |
| Route | `GET /mine`, behind `coordinatorOnly`, declared before `GET /:id` |
| Unit tests | Every `SCRUM333_AC11_*` |
| Check script | Section 6: "ordered by event date, soonest first, undated last", "each row carries the organiser's name" |
| Screen | `MyAssignedEvents.jsx` on the coordinator's dashboard and at `/my-events`, grouped by status group, finished groups collapsed |

---

## 2. Traceability

Three criteria, chosen because each takes a different path through the system,
so between them they are a template for any other:

- **AC2** — the rule lives entirely in a Postgres function, so the proof is the
  check script and not the unit suite. It is also the criterion whose design
  looks most arbitrary, which is where examiners push hardest.
- **AC6** — authorisation, enforced in the database under a lock, surfaced through
  a typed error and a gated route, with a deliberate divergence on `planning`.
- **AC10** — the one criterion that crosses every layer up to the Organiser's
  screen, and the one with a privacy decision in it.

### AC2 — the coordinator with the fewest active events is chosen

**Criterion, as the code reflects it:** the coordinator chosen for a newly
submitted event is the one with the fewest active events.

**Test cases**

| Case | Where | Proves |
|---|---|---|
| Fewest active events wins, ahead of who waited longest | `scripts/check-coordinator-assignment.js`, section 1 | A (no active events, assigned most recently) beats B (one active, waited longest). Ranked by waiting time first, B would win |
| On a tie, the coordinator longest without a new assignment wins | same | B (assigned 1 Jan 2000) beats C (assigned 2 Jan 2000), both with no active events |
| A coordinator never assigned anything sorts first | same | D (no history) beats C. With nulls last, C would win |
| A non-coordinator is never chosen | same | A Venue Staff member, best on every other key, never receives an assignment |
| `SCRUM330_AC1_assigns_a_coordinator_on_submission` | `tests/services/eventRequestService.test.js` | The service takes the coordinator from the function's result and invents none of its own |

**Why the unit suite cannot prove this criterion.** The rule is an `order by`
inside `pick_event_coordinator`. A fake client returns whatever row the test
queued, so a unit test of "fewest active wins" would only check the fixture
against itself. The check script is the proof.

**How the script makes the proof honest.** Each workload is chosen so the check
can only pass for the right reason. The fixture history rows are dated in 2000,
older than any real assignment, so a real coordinator cannot be "longer without
an assignment" than the intended winner. The rule also ranks real coordinators,
so the script first checks for one with no active events and no history. If it
finds one, it skips the selection checks and fails with the reason, rather than
report a result that measures the live data instead of the rule.

**Production code, top to bottom**

1. `POST /api/event-requests/:id/submit` (`src/routes/eventRequests.js`) — the
   ownership pre-check, then `submitEventRequest`.
2. `submitEventRequest` (`src/services/eventRequestService.js`) — validates, then
   `db.rpc('submit_event_request', …)`.
3. `submit_event_request` (`016`) — calls `pick_event_coordinator`.
4. `pick_event_coordinator` (`015`) — the rule.

**Manual verification:** with two coordinators, one holding more active events,
an Organiser submits a request; it appears in the less loaded coordinator's My
Events.

**Likely follow-ups:** "Why count `planning` when the AC names five statuses?"
(D3). "Why is the rule in the database?" (D2). "What if two submissions arrive
at once?" They can pick the same coordinator: fairness is approximate by
decision, and 015's header gives the cost of preventing it (one global lock on
every submission).

### AC6 — only the assigned coordinator can hand an event over

**Criterion, as the code reflects it:** only the event's assigned coordinator can
hand it to a colleague, and only while it is submitted, under review, pending
clarification, approved or confirmed.

**Test cases**

| Case | File | Proves |
|---|---|---|
| `SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over` | service suite | 42501 from the function becomes `ForbiddenError`, 403, with the function's message |
| `SCRUM331_AC6_refuses_a_status_that_does_not_allow_a_handover` | service suite | 55000 becomes `ConflictError`, 409 |
| `SCRUM331_AC6_reports_an_event_that_does_not_exist_as_not_found` | service suite | P0002 becomes 404 |
| `SCRUM331_AC6_reports_a_handover_that_lost_a_race_as_a_conflict` | service suite | 40001 becomes 409 |
| `SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over` | `tests/routes/eventRequests.test.js` | The route answers 403 with the function's message |
| `SCRUM331_AC6_an_organiser_is_refused_with_403_and_never_queries` | route suite | The role gate refuses before the database is touched |
| `SCRUM331_AC6_returns_401_without_a_token_and_never_queries` | route suite | No token, no query |
| The previous coordinator can no longer hand it over (42501) | check script, section 4 | The real function refuses the real outgoing coordinator |
| A status outside the five AC6 allows is refused (55000) | check script, section 4 | The real function refuses a cancelled event |
| A null caller is refused as the caller (42501) | check script, section 4 | The explicit null check in 018, which `is distinct from` alone would miss |

**Production code**

1. `POST /:id/reassign` — `coordinatorOnly`, then the service with
   `req.user.id` as the caller. The body cannot name the caller.
2. `reassignEventRequest` — checks the new coordinator's id is shaped like a uuid
   (a malformed one would otherwise be a 500), then makes one rpc call, with no
   read first.
3. `reassign_event_request` (`018`):
   - locks the event row `for update`;
   - refuses a null caller, or a caller who is not the assigned coordinator, with
     42501;
   - refuses a status outside the five with 55000;
   - locks the new coordinator's profile `for share` and refuses them with 22023
     unless they hold the role;
   - refuses a handover to the current holder with 23514;
   - moves the coordinator (and the reviewer, if there is no decision) and writes
     the history row.
4. `translateError` — 42501 to `ForbiddenError`, 22023 to `ValidationError`,
   55000 and 40001 to `ConflictError`.
5. The UI: `CoordinatorRequestDetail` shows the hand-over button only when
   `user.id === assignedCoordinatorId`. That is a convenience, not the gate.

**Manual verification:** as the assigned coordinator the button appears and the
handover succeeds; as any other coordinator the button is absent; the previous
coordinator, reopening the event, sees the history without the button.

**Likely follow-ups:** "Why a 403 here, when the Organiser routes answer 404?"
(D10). "Why not check in the service first?" Because the answer could be out of
date by the time the write happens. The function checks under the same lock the
write holds. "Why can't `planning` be handed over?" (D3).

### AC10 — the Organiser sees who holds the event and how it got there

**Criterion, as the code reflects it:** the Organiser's event screen shows the
current coordinator's name and the assignment history.

**Test cases**

| Case | File | Proves |
|---|---|---|
| `SCRUM334_AC10_reads_one_events_history_oldest_first` | service suite | One event's rows, `created_at asc` then `id` |
| `SCRUM334_AC10_withholds_the_handover_note_from_the_organiser` | service suite | The `handoverNote` key is absent, and `handover_note` is not selected |
| `SCRUM334_AC10_withholds_the_handover_note_unless_asked_for` | service suite | Leaving `includeNotes` out gets the Organiser's view |
| `SCRUM334_AC9_marks_a_system_assignment_as_automatic` | service suite | The first row reads as the system's, not a blank person |
| `SCRUM334_AC9_a_person_with_no_name_is_still_a_person` | service suite | A nameless person is not mistaken for the system |
| `SCRUM334_AC10_the_organiser_sees_who_and_when` | route suite | Ownership is checked first, then the history, then the names |
| `SCRUM334_AC10_withholds_the_handover_note_from_the_organiser` | route suite | The note's text does not appear anywhere in the response |
| `SCRUM334_AC10_a_different_organiser_gets_404` | route suite | Someone else's event looks exactly like a missing one, and the history is never read |
| `SCRUM334_AC10_a_coordinator_uses_their_own_route_not_the_organisers` | route suite | Locks in the two-route design (D9) |
| The Organiser's view has no handoverNote key at all | check script, section 6 | The same against the real database |

**Production code**

1. `MyEventRequests.jsx` — a `CoordinatorDetails` `<details>` on each submitted
   request, which mounts `AssignmentHistory` only when opened.
2. `AssignmentHistory.jsx` with `view="organiser"` — calls `getAssignmentHistory`,
   shows the newest entry's coordinator as current, renders each entry, and shows
   a note only if the key is present.
3. `GET /:id/assignments` — `getEventRequestForOrganiser` (404 unless the caller
   owns the event), then `listAssignmentHistory(id, { includeNotes: false })`.
4. `listAssignmentHistory` — selects without `handover_note`; reads names in one
   `profiles` read; derives `automatic` from `assigned_by`.

**Manual verification:** as the Organiser, open "Your coordinator and assignment
history" on a request that has been handed over. It shows the current coordinator,
"Assigned to A, … by ConnectSphere, automatically on submission", then "Handed
from A to C, … by A", and no note. As a coordinator, the same event shows the
note.

**Likely follow-ups:** "Why hide the note?" (D4). "Why is the name behind a
click?" Showing it on every row means one extra request per row, on every load and
every tab focus. The right fix is a backend field on the Organiser's list (section
4). "How does the screen know the first row is the system's?" `automatic`, not a
null name (D14).

---

## 3. Design decisions

Each is stated as the argument, because that is what will be asked for.

### D1. A new `assigned_coordinator_id`, rather than reusing `reviewing_coordinator_id`

The two columns record different facts, and the database already depends on one
of them never changing. `reviewing_coordinator_id` (010, SCRUM-19) records who
reviews a request, and 010's `event_requests_decided_by_is_reviewer` requires the
person recorded as deciding to equal it. Once a decision exists, that column is
part of the permanent record of who decided.

Assignment is a different fact. It exists before anyone reviews: a request is
assigned the moment it is submitted, while the reviewer stays null until someone
starts reviewing. And it can change at any time, including long after the
decision. If one column held both, handing over an approved event would either
rewrite who decided it, or be refused by 010's constraint. The first falsifies the
record; the second makes handing over a decided event impossible.

The two move together in exactly one case: an undecided event handed over while
someone is reviewing it. Then the reviewer follows the new coordinator, so the
person responsible is the person allowed to decide (018).

### D2. The assignment logic is in Postgres functions, not the service

Submission and handover each write to two tables, and every part must happen or
none of it. An event must never be submitted without a coordinator, a coordinator
must never be recorded without a history row, and a history row must never
describe a handover that did not happen. supabase-js has no transactions: every
call is its own HTTP request. A function body is one transaction, so a refusal
anywhere rolls back everything before it.

The second reason is checking at the right moment. "Is the caller the assigned
coordinator?" is only reliably true while something holds the row lock. A service
check would read in one request and write in another, and a handover could land
in between. 004, 006, 016, 018 and 019 all make this argument; 018's header gives
it in full.

`requestEventClarification` is the exception, and it is deliberate. It writes one
row in one statement, so a guarded update (`.eq('assigned_coordinator_id', …)`) is
enough: the statement itself cannot touch an event the caller does not hold.

### D3. `planning` counts as workload but cannot be handed over

The two rules answer different questions. 015 asks how much work a coordinator
has. A request in planning is an event they are actively arranging, so leaving it
out would undercount their workload whenever anything writes that status, and new
events would keep going to the person busiest with planning. 018 asks what the
customer has agreed may be handed over, and AC6 names five statuses, without
planning. SCRUM-318 records the customer saying planning is the same as approved,
so the status may never be written in practice. If it is never written, counting
it changes nothing. If it is, counting it is correct, and refusing the handover
follows the AC exactly until someone asks the customer.

This is a known divergence between the AC text and the code, made on purpose, and
both migrations say so in their headers.

### D4. The Organiser does not see handover notes

The note is written by one coordinator for another: "on leave from Monday, the
shortlist is in my notes". If the Organiser could read it, coordinators would
write it differently or stop writing it, and the handover it exists for would get
worse. The customer confirmed the Organiser sees the coordinator's name, so who
and when are theirs; the note is not.

Two refinements, both deliberate:

- **The key is absent, not null.** Null already means "no note was written", which
  is true of every automatic assignment. An absent key means "not sent to you".
  With both null, the Organiser's screen could not tell a withheld note from a
  missing one, and would tell an Organiser "no note was left" when one exists.
- **The column is not even selected** for the Organiser's view, so a later mapping
  mistake cannot leak it. `includeNotes` defaults to false, so a caller that
  forgets to choose gets the Organiser's view, never the other way round.

### D5. 016 and 017 were split

The function and the constraint need opposite orders relative to the service
change. The new `submitEventRequest` calls `rpc('submit_event_request')`, so the
function must exist before that code runs. The constraint (nothing past draft
without a coordinator) can only exist once the old code has stopped running,
because the old code submitted with a plain update that set no coordinator, and
under the constraint every such submission fails with 23514. In one file, there
would be a window in which submissions are broken on the one shared Supabase
project the whole team develops and demos against. Split: apply 016, deploy the
service, apply 017. No window. 017 repeats the backfill first, for rows submitted
in between.

### D6. `process_change_request` kept its four-argument signature (019)

The obvious design adds a `p_assigned_coordinator_id` parameter. That was
rejected for three reasons:

- **It names the same person as `p_processed_by`** in every real call. Both come
  from `req.user.id`.
- **Two parameters can disagree, and then the record lies.** A call naming the
  assigned coordinator as one and someone else as the other would pass the check
  and record the someone else as deciding. Checking `p_processed_by` itself makes
  the person recorded the person who was entitled to decide.
- **A new parameter creates a second function.** `create or replace` with a
  different argument list does not replace 006's function; it adds a second one
  beside it. Every existing four-argument call would then match both, and
  Postgres refuses that as ambiguous. Doing it properly needs a `drop function`
  and a service change released at the same moment, on migrations applied by hand.

Keeping the signature meant decisions kept working the moment 019 was applied.

### D7. The role is checked in the database for a handover, and nowhere else

Everywhere else in this schema the API decides who may do what. 018 departs from
that once, for the new coordinator's role, because of timing. 015 chooses among
people who already hold the role, in the same statement that reads it. A handover
names one particular person, picked from a list the frontend loaded some time
earlier, and that person can lose the role in between. A check in the API would
read in one request and write in another. 018 checks under `for share` on that
person's profile, so a role revoked at the same moment either waits for the
handover or refuses it.

The outgoing coordinator's role is not checked. Losing the role is often exactly
why the event is being handed over, and refusing would leave it stuck with them.

### D8. My Events shows the organiser's name; the review queue does not

The queue's docstring calls the absence of a name "the privacy floor of the shared
queue": a coordinator learns what was asked for, not who to contact. That is right
for a list every coordinator sees, of work most of them will never touch. It is
wrong for events you are responsible for, where contacting the Organiser is the
job, and AC7 makes you the one person who can act on them. The two lists answer
the question differently because of whose work it is, and the queue's docstring
now points to this argument so the two do not read as a contradiction.

**How the name is read.** It comes from a second read of `profiles`, not a join.
PostgREST embeds one table in another only along a foreign key between them, and
there is none: `event_requests.organiser_id` and `profiles.id` both reference
`auth.users`. Adding the key would need a migration and would refuse every
organiser without a profiles row. The second read is narrowed to this list's
organisers, so it cannot be used to read anyone else's name.

### D9. The coordinator's read is a separate route, not a role branch in `GET /:id`

`GET /:id/review`, behind `coordinatorOnly`, beside the Organiser's `GET /:id`.
There are four reasons:

- **Who may call it is visible on the route's declaration,** which is the rule
  `requireAuth.js` states.
- **It fails closed.** A branch inside one handler choosing between two access
  rules, with its condition wrong, would turn the Organiser's 404 into an open
  read of every event. A separate route behind `requireRole` answers 403 before
  its handler runs.
- **`GET /:id` is untouched,** so its 404 and every test that relies on it stay
  as they were.
- **It follows the existing pattern:** `/:id/change-requests` beside
  `/:id/change-requests/review`.

The history follows the same split (`/:id/assignments` and
`/:id/assignments/review`), for the same reasons. The cost is two URLs per
resource, and the frontend picks by role, as it already does between `GET /` and
`GET /queue`.

### D10. A coordinator is refused with 403; an Organiser with 404

`errors.js` used to argue there should be no `ForbiddenError`, because a 403
confirms an id exists. That holds for an Organiser probing someone else's request,
and they still get 404. It does not hold for a coordinator, who already sees every
event in the shared queue: a 403 tells them nothing new and gives the true reason.
`ForbiddenError` is therefore limited to records the caller can already see. For
the same reason a draft, which no coordinator is meant to know exists, is a 404 to
coordinators everywhere, worded exactly like a missing id.

### D11. The selection function returns null rather than raising, and takes the event id

**Null, not an exception.** AC5 needs the caller to ask "is anyone available?" and
refuse cleanly. A function that raised would force every caller to catch it and
work out which exception meant "nobody available". 014's backfill does raise, and
should: a migration that cannot assign a row has to stop.

**The event id, not a previous-coordinator parameter.** With that parameter, every
caller would have to know resubmission exists and look up the right history row.
One that forgot would skip AC4 silently. With the event id, the whole rule stays
inside the function.

**`stable`.** Postgres then refuses any write added to the function later. The
cost is that a `stable` function sees the database as it was when the calling
statement began, which is why the backfills assign one row per statement.

**No lock.** Two simultaneous submissions can pick the same coordinator. Fairness
is approximate by decision; exact fairness would need every submission in the
system to wait on one lock.

### D12. In clarification, the wrong coordinator is a 403 and a no-match is a 409

`requestEventClarification` reads the row before writing it, and that read says
who holds the event. So the common case, a coordinator acting on someone else's
event, is refused from the read with a 403 and nothing written. The update is then
guarded on the assigned coordinator as well. If it matches no row, the read showed
the caller holding the event a moment ago, so something changed in between: a
handover or a status change. That is a race, and a race is a 409, as it is
everywhere else in this service. A 403 would be false when only the status moved.

### D13. The reviewer follows a handover only before a decision

Before a decision, the reviewer moves with the event, because 010 lets only the
reviewer decide. After a decision it stays, because it now records who decided:
moving it would make 010's constraint refuse the update, and even without the
constraint it would rewrite the record. The check script proves the first half
against the real database ("and the reviewer moves with it"). The second needs
decision fields, which are SCRUM-19's.

### D14. History entries carry an `automatic` flag

014's convention is that a null `assigned_by` means the system assigned the event.
Every client would otherwise have to know that, and it becomes ambiguous once
names are added: `assignedByName` is null both for the system and for a person
with no name on record. So the API states the one fact the screen needs, as a
boolean derived from `assigned_by` alone, and keeps `assignedById` as its source.

### D15. On the frontend: panels, not modals; the picker leaves out the signed-in user

There is no modal anywhere in this codebase, so the reassign screen is a
full-page panel like every other. The coordinator list includes the caller,
because "everyone but me" is the picker's need, not the list's meaning. The
picker filters on `user.id`, since the signed-in user has no name to match on.
Error messages come from tables keyed by status code, because the database's own
messages name uuids. One 409 message covers both of its causes (the status does
not allow a handover, or the event changed hands mid-flight), because telling them
apart would mean matching message text, and both have the same remedy.

---

## 4. Known gaps and follow-ups

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC8 untraced | No code cites it. Read it off the ticket and record it here | SCRUM-327, before the exam |
| AC4 unreachable | 015's step 1 is correct but nothing moves an event back to draft, so no test can reach it | Whichever story adds a path back to draft |
| AC5 not live-tested | Would need zero coordinators in the shared project | None; unit-tested only |
| Concurrency untested | Simultaneous handovers, a handover racing a decision, a role revoked mid-handover: all rest on row locks a single-threaded script cannot provoke. The 40001 refusal is unreachable by design | None; argued in 018's header |
| Approve and Reject buttons do nothing | `CoordinatorRequestDetail` shows them; `handleReviewDecision` returns early for anything but "return for amendment" | SCRUM-19 |
| The reviewer staying put after a decision | Untested live, because it needs SCRUM-19's decision fields | SCRUM-19 |
| UI offers refused actions | Return for amendment and the change-request decisions are shown to every coordinator, including one who has just handed the event over. The backend refuses them with a 403, which the screen displays | Follow-up: hide them with the same comparison the hand-over button uses |
| Hand-over button on disallowed statuses | Shown to the assigned coordinator on planning, completed, rejected and cancelled events, where it gets a 409. Hiding it would need a frontend copy of 018's five statuses | Follow-up, ideally with the backend exposing which actions an event allows |
| The coordinator's name on the Organiser's list | Behind one click, to avoid one request per row. Needs the backend to include the name in `GET /event-requests` | Follow-up |
| New routes untested over real HTTP | `/mine`, `/coordinators`, `/:id/assignments(/review)` are proved through the services and the fake-client route tests, not with a real token | Follow-up: extend `routes:check` |

### Technical debt this story created or exposed

| Item | Detail |
|---|---|
| Migration numbers collide across the team | 014 refuses to run unless `reviewing_coordinator_id` exists. That column comes from SCRUM-19's decisions migration, which is now on this branch, merged from SCRUM-19, and renamed `025_event_request_decisions.sql` (formerly `010_…`) because it collided with `010_event_request_clarifications.sql`. That resolves one collision. **Six remain**, each a number used by two different files from different stories: **005** (`005_event_request_details.sql`, SCRUM-10; `005_venue_retirement.sql`, SCRUM-110), **014** (`014_booking_review_notifications.sql`, SCRUM-128; `014_coordinator_assignment.sql`, SCRUM-328), **015** (`015_venue_block_amend_remove.sql`, SCRUM-127; `015_assignment_function.sql`, SCRUM-329), **016** (`016_venue_block_history.sql`, SCRUM-131; `016_submit_event_request.sql`, SCRUM-330), **017** (`017_venue_turnaround.sql`, SCRUM-186; `017_require_assigned_coordinator.sql`, SCRUM-330), **022** (`022_equipment_schema.sql`, SCRUM-66; `022_event_status_transitions.sql`, SCRUM-318). The number alone therefore no longer gives an order to apply files in, so a database rebuilt from this folder depends on someone knowing the real order. The cost is already concrete: because of the 005 collision, `retire_venue` from `005_venue_retirement.sql` is still missing from the live database. 014 and 018 still name the old `010_` filename on purpose; both are applied and append-only |
| SCRUM-19 now contradicts this story | `docs/test-cases/SCRUM-19.md` (on its own branch) is built on "no assignment model": the coordinator who claims a review owns the decision. With SCRUM-327 merged, the reviewer follows the assigned coordinator on a handover (018), and SCRUM-19's claim step needs reconciling with assignment before it merges |
| `translateError`'s 23503 branch | Calls every foreign-key violation "Unknown organiser. organiser_id must match an existing user". `event_requests` now has three more user references (`assigned_coordinator_id`, `reviewing_coordinator_id`, `decided_by`), and the history table three (`previous_coordinator_id`, `new_coordinator_id`, `assigned_by`). Unreachable today, because every write path checks the user first, but wrong the day it is reached |
| Organiser shown as a bare uuid | On rows from the queue, by design (D8); `CoordinatorRequestDetail` shows `organiserName` only when the row carries it, which only My Events rows do |
| My Events is unbounded | Every status, so it grows with every finished event. Finished groups are collapsed on screen, but the response is not paginated. The first list in the API that grows without limit |
| A callback reused under a narrow name | After a handover, `CoordinatorRequestDetail` refreshes its parent through `onChangeRequestProcessed`, whose behaviour fits but whose name does not. Rename it `onEventChanged` in ReviewQueue and MyAssignedEvents |
| Malformed ids answer 500 | A non-uuid `:id` reaches Postgres as 22P02 on `GET /:id`, the submit route, the review read and both history routes. Not new here, but now on more routes |
| Who asked for a clarification | Still not recorded; there is no column for it |
| The handover note has no length limit | Unlike the clarification note's 2000 characters. Probably fine; not decided |
| The check script's assumptions | `assignment:check` skips the selection checks if a real coordinator is idle and never assigned. Its recovery path for a real event landing on a test coordinator is written but has never run |

### Stale comments found while writing

| Where | What it still says |
|---|---|
| `routes/eventRequests.js:36` | "GET /queue is the single exception" to having no role gate. Clarification, reassign, the decision route and every new coordinator route each have one |
| `domain/eventRequestStatus.js:203` | "There is no coordinator_id on event_requests and no assignment model". False since 014 |
| `middleware/requireAuth.js:138` | Says the frontend clears its stored session on any 401. `apiClient.js` has no such handler |
| `frontend/src/services/eventRequestService.js`, `getEventRequestQueue` | "No endpoint resolves it to a name". `/mine` now does |
| Headers of 006, 014 and 018 | Superseded in places (006: authorisation is "an API concern throughout"; 014: the constraint "arrives in 015"; 018: "errors.js has deliberately had no ForbiddenError"). These files are applied and append-only, so the later migrations record the corrections instead |

### Housekeeping outside the story's code

| Item | Detail |
|---|---|
| Three stray frontend files | `frontend/ChangeRequestForm.jsx`, `frontend/ChangeRequestStatusList.jsx` and `frontend/changeRequestService.js` sit at the frontend root, outside `src/`, from commit 9c4fd3a. Nothing imports them. The service is identical to its `src` copy; the two components differ from theirs |
| Frontend lint | 17 errors. One comes from this story: `MyAssignedEvents.jsx` trips `react-hooks/set-state-in-effect` exactly as `ReviewQueue` and `MyEventRequests` already do. Fixing it properly means a different fetching pattern across all three, worth its own ticket. The other two new components avoid the rule |
| `retire_venue` missing live | Two files are numbered 005 (`005_event_request_details.sql`, `005_venue_retirement.sql`), and `retire_venue` from the second is not in the live database, so `venue-routes:check` reports 5 expected failures |
| Technical Support role key | **Found while writing; a code bug, not a document gap.** The live role is `technical_support`, which `normaliseRole` turns into `TECHNICAL_SUPPORT`. `Dashboard.jsx` and `Navigation.jsx` key on `TECHNICAL_SUPPORT_STAFF`, following 007's declaration, so a live Technical Support user gets no dashboard and no navigation. Their own comments describe the opposite fix |
| `user.name` in the nav bar | `Navigation.jsx` renders `{user.name} ({user.role})`, but login returns no name, so it renders " (event_coordinator)" |
