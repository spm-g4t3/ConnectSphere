# SCRUM-19 — Approve or Reject a Submitted Event Request

**Story:** Approve or Reject a Submitted Event Request — Event Coordinator
**Closing subtask:** SCRUM-135 (this document)
**Status as of 7 October 2026:** closed, with the gaps in section 4 recorded rather than hidden.

This document is the record of what SCRUM-19 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks that chain end to end for three criteria.

The case-by-case mapping lives in `docs/test-cases/SCRUM-19.md` (64 cases, each
naming the tests that prove it). This document cites it rather than repeating it.
Where the two overlap, the test-case document is the finer-grained record.

---

## Subtasks and what each delivered

| Subtask | Delivered | Where |
|---|---|---|
| SCRUM-163 | The decision columns, the decision enum and five row-level constraints | `db/migrations/025_event_request_decisions.sql` (applied live as `010_…`, renamed 6 October 2026) |
| SCRUM-109, SCRUM-122 | The two functions | `029_event_request_decisions_functions.sql` — `start_event_review`, `decide_event_request` |
| SCRUM-346 | Starting a review; clarification now starts it too | `startEventReview`, `POST /:id/start-review`, the change to `requestEventClarification` |
| SCRUM-119, SCRUM-121 | Approving and rejecting | `decideEventRequest`, `POST /:id/decision`; the four decision fields in `COLUMNS` and `toEventRequest` |
| SCRUM-129 | The coordinator's decision screen | `CoordinatorRequestDetail.jsx` (decision section), `DecisionOutcome.jsx` |
| SCRUM-133 | The Organiser's view of the outcome | `MyEventRequests.jsx`, `DecisionOutcome.jsx` with `view="organiser"` |
| SCRUM-134 | 025 and 029 run against a real Postgres, in CI | `backend/tests/db/eventStatusLifecycleDatabase.test.js` |
| SCRUM-95 | The test cases | `docs/test-cases/SCRUM-19.md` |
| SCRUM-124 | *Closed without code* — the AC8 guard belongs to the stories that raise bookings and equipment | — |
| SCRUM-173 | *Deferred, unassigned* — the AC11 notification | — |
| SCRUM-135 | This document | `docs/SCRUM-19.md` |

### Verification as of 7 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm test` in `backend`) | 2829 tests passing across 45 files |
| Frontend suite (`npm test` in `frontend`) | 879 tests passing across 38 files |
| SCRUM-19's own tests | 119 named `SCRUM19_…`: 39 service, 15 route, 45 PGlite, 16 coordinator screen, 4 Organiser list |
| PGlite suite | Applies 001 to 029 (the ones it needs) to an in-process Postgres and calls the real functions; runs in CI with no credentials |
| Live database | 025 (as `010_…`) and 029 applied by hand in the Supabase SQL editor. **No check script exercises 029** against the live database; there is no `decision:check` beside `assignment:check` |
| Manual UI walkthrough | **Not recorded.** See *Before the examination* at the end |

The layers prove different things, and the difference matters under questioning.
A service or route test proves the right function is called with the right
arguments, and that each SQLSTATE becomes the right HTTP status. It cannot prove
the function behaves, because a fake client returns whatever it is given. Until
SCRUM-134 that was the only evidence for 029. The PGlite suite now runs 029 and
025's constraints for real, so what the function writes, and that a refusal
writes nothing, are proved in CI. What PGlite cannot prove is concurrency: it
runs one query at a time.

---

## A warning about the wording below

**The acceptance criteria are reconstructed, not quoted.** The ticket's text is in
Jira, not in this repository. The numbering is the one the code and the tests
cite (029's header, the services, the test names); the wording is the test-case
document's reconstruction, and only AC1 is quoted anywhere in the repository (in
025's header, from before automatic assignment existed).

**Before the examination, check every criterion against Jira. Where they differ,
Jira wins, and this document and the test-case document should be corrected
rather than defended.**

---

## 1. Acceptance criteria

| AC | Criterion, as reconstructed | Status |
|---|---|---|
| AC1 | Only the assigned coordinator reviews and decides; they start the review of a submitted request | **Done** |
| AC2 | A decision only on a request under review | **Done** |
| AC3 | Any other state is refused with a message and leaves the event unchanged, Pending clarification included | **Done** |
| AC4 | Before deciding, the coordinator sees the requirements and the full clarification history | **Partial**: requirements yes; the history is stored but not shown, and the Organiser's replies are not stored at all |
| AC5 | A rejection needs a reason; an approval's note is optional | **Done** |
| AC6 | An approval is refused once the proposed start date has passed | **Done**; the screen's choice of message is a heuristic (D7) |
| AC7 | Approving sets Approved; rejecting sets Rejected | **Done** |
| AC8 | Venue bookings and equipment requests only against Approved or Confirmed events | **Enforced elsewhere**: SCRUM-243 and SCRUM-21, at their own writes |
| AC9 | Outcome, note, decider and time are recorded, and cannot be edited | **Done**, with two transitions SCRUM-318 owns that touch a recorded decision (open questions 1 and 2) |
| AC10 | The Organiser sees the outcome, the note and the decider's name | **Done** |
| AC11 | The Organiser is notified | **Deferred** to SCRUM-173 |

**Tally:** 8 done, 1 partial (AC4), 1 enforced elsewhere (AC8), 1 deferred (AC11).

### Evidence for each criterion

Test names are in `docs/test-cases/SCRUM-19.md`, by case. The table below says
which layers carry the proof.

| AC | Migration | Service / route | Screen | Real database (PGlite) | Cases |
|---|---|---|---|---|---|
| AC1 | 029 `start_event_review`; `decide_event_request`'s caller and reviewer checks | `startEventReview`, `decideEventRequest`, `requestEventClarification`; both routes behind `coordinatorOnly` | Start review only for the assigned coordinator; nothing to press for anyone else | Yes | AC1-01 to AC1-19 |
| AC2 | 029, `status <> 'under_review'` refused | `decideEventRequest` | Approve, Reject, Return only when under review | Yes | AC2-01 to AC2-05 |
| AC3 | 029, the same check, naming the status | translateError: 55000 → 409 | Waiting panel on pending clarification | Yes, including "writes nothing" for every refusal | AC3-01 to AC3-04 |
| AC4 | — (021's history stores the question) | `getEventRequestForCoordinator`, `getEventRequestStatusHistory` | Requirements shown; history **not** shown | The question stored as the history reason | AC4-01, 03, 04 done; 02, 05, 06 not |
| AC5 | 029 22023; 025 `rejection_has_reason` | `decideEventRequest` refuses before the call, naming `decisionNote` | Refused before the call | Yes, and the constraint by direct write | AC5-01 to AC5-05 |
| AC6 | 029, `proposed_start is null or <= p_decided_at` | `now` injected; 55000 → 409 | Its own message, chosen by the event's date (D7) | Yes: passed, missing, exactly equal; rejection allowed | AC6-01 to AC6-06 |
| AC7 | 029, status and decision in one update | `decideEventRequest`; `DECISIONS` | The decision shown read-only after | Yes, and that the status function alone is refused | AC7-01 to AC7-06 |
| AC8 | — | — | — | — | None, by design |
| AC9 | 025's columns and constraints; 029 writes the history row | `COLUMNS`, `toEventRequest` | `DecisionOutcome`, whatever the status now is | Yes, all five constraints by direct write | AC9-01 to AC9-07 |
| AC10 | — | The decision travels with the Organiser's own request | `DecisionOutcome` on the row in `MyEventRequests` | — | AC10-01 to AC10-05 |
| AC11 | — | — | — | — | AC11-01, not implemented |

#### AC4 — partial

The coordinator sees every requirement field. The clarification history is half
there. Every move into `pending_clarification` writes a status-history row whose
reason is the coordinator's question, readable through `GET /:id/status-history`.
But the Organiser's reply is not stored: responding edits the request's fields
and writes a `pending_clarification → under_review` row with no reason. And the
coordinator's screen does not read the status history at all. So "the full
clarification history" can be neither stored nor shown as things stand.

#### AC8 — enforced elsewhere

The rule constrains what may be *raised* against an event, so it belongs where
the thing is raised: the venue booking request's write (SCRUM-243) and the
equipment request's write (SCRUM-21, whose own AC1 states it). SCRUM-124, which
would have put a guard in this story, was closed for that reason. The tables
exist (`bookings`, 009; `equipment_requests`, `022_equipment_schema.sql`), but no
service on this branch writes either, so a guard written here would have no
caller.

#### AC11 — deferred

The notifications table cannot take it yet: 014's `notifications_type_known`
allows only `'booking_flagged'`, and there is no event reference. SCRUM-173 needs
a migration first. Ideally the writer goes inside `decide_event_request`'s
transaction, so a decision and its notification cannot part.

---

## 2. Traceability

Three criteria, chosen because each takes a different path:

- **AC1** — the criterion with a step whose reason is not obvious. "Start review"
  looks like ceremony; it is the only thing that lets a decision be recorded.
- **AC6** — crosses every layer, with an injected clock in the backend and a
  heuristic in the frontend.
- **AC10** — the Organiser's half, with a lookup that would be wrong if done the
  obvious way.

### AC1 — only the assigned coordinator reviews and decides

**Criterion, as reconstructed:** only the Event Coordinator assigned to an event
request can review and decide it. The assigned coordinator starts the review of a
submitted request, which moves it to Under review; anyone else is refused.

**Why there is a start-review step at all.** 025's `decided_by_is_reviewer`
requires the person recorded as deciding to equal `reviewing_coordinator_id`.
Before 029, nothing in the schema wrote that column: 018 moves it on a handover
only if it is already set, and the backfills only read it. So no decision could
ever have been recorded. `start_event_review` is the moment the assigned
coordinator becomes the reviewer (D1).

**Test cases** (full list: test-case document, AC1-01 to AC1-19)

| Case | Where | Proves |
|---|---|---|
| `SCRUM19_AC1_starts_the_review_writing_the_status_the_reviewer_and_one_history_row` | PGlite | The real function writes `under_review`, the reviewer, and exactly one `submitted → under_review` history row |
| `SCRUM19_AC1_start_review_refuses_%s_and_writes_nothing` | PGlite | 42501 for a null caller, another coordinator and a draft; 55000 naming the status for each of the seven other statuses; the row and history unchanged every time |
| `SCRUM19_AC1_never_overwrites_a_reviewer_who_is_someone_else` | PGlite | A recorded reviewer who is not the decider is refused, and stays recorded |
| `SCRUM19_AC1_fills_in_an_empty_reviewer_with_the_decider` | PGlite | A request reaching `under_review` through the status function, with no reviewer, can still be decided |
| `SCRUM19_AC1_starts_the_review_through_the_function_alone` | service suite | One rpc, the caller as `p_coordinator_id`, nothing else written |
| `SCRUM19_AC1_only_the_assigned_coordinator_starts_the_review` | service and route suites | 42501 becomes 403 with the function's message |
| `SCRUM19_AC1_clarification_starts_the_review_so_the_reviewer_is_set` | service suite | Asking for clarification on a submitted request calls `start_event_review` first, then the status change |
| `SCRUM19_AC1_an_organiser_cannot_start_a_review_and_nothing_is_queried` | route suite | The role gate refuses before the database is touched |
| `SCRUM19_AC1_a_submitted_request_offers_the_assigned_coordinator_start_review_only` | screen | Start review is the only action |
| `SCRUM19_AC1_a_%s_request_offers_another_coordinator_nothing_to_press` | screen | Anyone else sees who can act, and no buttons |

**Production code, top to bottom**

1. `CoordinatorRequestDetail` — on a submitted request, shows Start review when
   `user.id === assignedCoordinatorId`. A convenience, not the gate.
2. `startEventReview` (frontend service) — `POST /event-requests/:id/start-review`,
   no body.
3. `POST /:id/start-review` — `coordinatorOnly`, then the service with
   `req.user.id`. Nothing is read from the body.
4. `startEventReview` (backend service) — refuses a blank caller, then one rpc,
   no read first.
5. `start_event_review` (029) — locks the row; refuses a null caller or anyone but
   the assigned coordinator (42501); refuses any status but submitted (55000);
   asks 022's transition table; updates the status and the reviewer in one
   guarded statement; writes the history row.
6. `translateError` — 42501 → 403, 55000 → 409, P0002 → 404, 40001 → 409.

The screen then shows Approve, Reject and Return for amendment in place. The
decision route repeats the caller check, then checks the status, then checks the
reviewer (D9).

**Likely follow-ups:** "Why not just let `change_event_request_status` do it?" (D1).
"Why is a draft a 403 and not a 409?" The caller is checked before the status; a
draft has no coordinator, so nobody is its coordinator (D12). "What if two
coordinators start at once?" Only the assigned one can, and the row lock orders
them; untested, because PGlite runs one query at a time.

### AC6 — no approval once the start date has passed

**Criterion, as reconstructed:** an approval is refused when the event's proposed
start date has passed.

**Test cases**

| Case | Where | Proves |
|---|---|---|
| `SCRUM19_AC6_refuses_an_approval_whose_start_%s_and_writes_nothing` | PGlite | A start before, missing, and exactly at a fixed `p_decided_at` (1 June 2026, 09:00 UTC) are all refused with 55000 and 029's message; nothing written |
| `SCRUM19_AC6_allows_a_rejection_whatever_the_start_date` | PGlite | The rule is about approving only |
| `SCRUM19_AC7_decides_through_the_function_alone` | service suite | `p_decided_at` is the service's injected `now`, as an ISO string |
| `SCRUM19_AC6_refuses_an_approval_when_the_start_date_has_passed` | service and route suites | 55000 becomes a 409 carrying the message |
| `SCRUM19_AC6_a_409_on_an_approval_whose_start_date_has_passed_says_to_agree_a_new_date` | screen | A 409 on an approval of a past event shows AC6's own message |
| `SCRUM19_AC2_a_409_on_a_future_event_says_the_request_changed` | screen | The other 409, on a future event, says the request changed, and does not mention the date |

**Production code**

1. `CoordinatorRequestDetail.handleDecision("approved")` —
   `decideEventRequest(id, { decision, decisionNote })`. No date check before the
   call: the server decides (D7).
2. `POST /:id/decision` — `coordinatorOnly`; only `decision` and `decisionNote`
   are read from the body. The time is never the client's.
3. `decideEventRequest` — validates the decision and a rejection's reason, then
   `rpc('decide_event_request', { …, p_decided_at: now.toISOString() })`, with
   `now` defaulting to `new Date()` (D3).
4. `decide_event_request` (029) — after the caller, status, transition, reviewer
   and reason checks: `if p_decision = 'approved' and (proposed_start is null or
   proposed_start <= p_decided_at)`, raise 55000.
5. `translateError` — 55000 → `ConflictError`, 409, the message passed through.
6. Back on the screen — a 409 on an approval, for an event whose start has passed
   *by the browser's clock*, shows the date message; any other 409 shows "this
   request has changed" (D7).

**Likely follow-ups:** "Why a parameter and not `now()`?" (D3). "Why share 55000
with a wrong status?" (D10). "How does the screen know which 409 it got?" It
guesses from the date it already has, and the guess has two known limits (D7).
"Why refuse a missing date?" Submission requires one, so a missing date means a
row made outside the application, and approving it would approve an event
nobody could date.

### AC10 — the Organiser sees the outcome, the note and who decided

**Criterion, as reconstructed:** the Event Organiser can view the outcome, the
reason or note, and the name of the coordinator who decided.

**Test cases**

| Case | Where | Proves |
|---|---|---|
| `SCRUM19_AC10_the_organiser_sees_the_outcome_the_reason_and_who_decided` | Organiser list | Outcome, "Reason", the text, the name and the time, on the row; the history read with the event's id |
| `SCRUM19_AC10_an_approval_shows_its_note_and_who_decided` | Organiser list | "Note" rather than "Reason" for an approval |
| `SCRUM19_AC10_an_undecided_request_shows_no_outcome_and_reads_no_history` | Organiser list | No block, and no request made |
| `SCRUM19_AC10_a_decider_missing_from_the_history_is_named_honestly` | Organiser list | "A coordinator with no name on record", never the id |
| `SCRUM19_AC9_every_read_carries_the_decision` | service suite | Every read selects the four decision columns, null when undecided |
| `SCRUM14_AC1_returns_404_for_another_organisers_request` | route suite | Someone else's request, decision included, is a 404 |

**Production code**

1. `MyEventRequests` — for each row with a `decision`, renders
   `<DecisionOutcome request={req} view="organiser" />` on the row itself.
2. `DecisionOutcome` — shows the outcome, "Reason" or "Note", and the time; reads
   `getAssignmentHistory(id)` and takes the name of the entry whose
   `newCoordinatorId` equals `decidedBy` (D8).
3. `GET /api/event-requests` and `GET /:id/assignments` — the Organiser's own
   request (with the decision fields, via `COLUMNS`) and its assignment history,
   both behind the ownership check.

**Likely follow-ups:** "Why not the newest history entry?" Because that is the
current coordinator, who after a handover is not the decider (D8). "Why not the
status history, which names who made each change?" Its read is narrower: it
refuses a coordinator who no longer holds the event (open question 4). "Isn't
that a request per row?" Yes, one per decided row per page visit (section 4).

---

## 3. Design decisions

Each is stated as the argument, because that is what will be asked for.

### D1. `start_event_review` is its own function, not a call to `change_event_request_status`

The status function cannot set `reviewing_coordinator_id`, and that column is the
whole point of starting a review. Giving it a reviewer parameter was rejected for
the reasons 019's header gives for `process_change_request`: the signature is
SCRUM-318's, two services already call it, and `create or replace` with a
different argument list adds a second function beside the first rather than
replacing it, after which every existing call is ambiguous. 021 made the same
argument for `submit_event_request`: a transition that must write more than the
status writes the status, its other columns and the history row itself, in the
shape the status function uses. Four functions now write status history; each
writes exactly one row per transition.

### D2. The status and the decision are written in one statement

Not style; the constraints leave no choice. 025's five constraints are row-level,
checked against the whole row after every statement. Status first leaves an
approved row with no decision, which `decided_status_has_decision` refuses.
Decision first leaves an under-review row carrying a decision, which
`decision_has_decided_status` refuses. Either order fails on its first statement.
So `decide_event_request` writes the status, the decision, the note, the decider,
the time and (if empty) the reviewer together. PGlite's
`SCRUM19_AC7_the_status_function_cannot_move_a_request_to_%s` shows the failure
directly: the status function alone is refused by `decided_status_has_decision`.

### D3. `p_decided_at` is injected, not `now()`

The service owns the clock, as 016 does for `p_submitted_at`, so a test can state
the instant. It matters more here, because the instant decides an outcome: AC6
asks "has the start passed?" at that instant. With `now()`, a boundary test would
pass or fail depending on when it ran. PGlite's AC6 cases fix the decision time
and the start dates either side of it, and give the same result on any day. The
history row's `created_at` keeps its database default: it records when the row
was written, which is the database's fact; `decided_at` is the decision's.

### D4. The decision is validated in the service as well as the database

The service refuses, before any call, a decision that is not exactly `approved`
or `rejected`, and a rejection with no reason. 029 refuses the second too (22023),
and 025's `rejection_has_reason` behind that. Three checks for one rule, each for
a different reader:

- **The service's** names the field (`details: [{ field: 'decisionNote' }]`), so
  the form can show it beside the box, as every other form fault in this API is
  reported. A bad decision value would otherwise reach PostgREST as an unreadable
  enum cast and come back as a 500.
- **029's** is a readable sentence for any caller that does not come through the
  service. 22023, not 23514, because translateError prefixes 23514 with "A value
  was rejected by the database:", which is for Postgres's own messages.
- **025's** constraint is the backstop for a direct write.

No case-folding: `Approved` is refused. Those are the enum's spellings, the
frontend sends one from a button, and accepting a second spelling is a promise the
API would have to keep forever.

### D5. `/start-review` and `/decision`; the caller and the time never come from the body

`POST /:id/start-review`, not `POST /:id/review`: `GET /:id/review` is already the
coordinator's read of one event (SCRUM-332). Two verbs on one path for unrelated
actions would read as one resource and mislead whoever adds the next route.
`/:id/decision` cannot collide with `/change-requests/:changeRequestId/decision`:
two segments against three.

Both are behind `coordinatorOnly` with no ownership pre-check, for SCRUM-327's D2
reason: whether the caller is this event's coordinator is answered under the row
lock, by the function. The decision route reads only `decision` and
`decisionNote` from the body. The decider is `req.user.id` and the time is the
server's clock, so a body naming someone else, or a forged timestamp, changes
nothing.

### D6. The screen switches on whether a decision exists, not on a list of statuses

`CoordinatorRequestDetail` checks, in order: is a decision recorded; is the
request pending clarification; submitted; under review. The first is
`current.decision`, not "status is approved, rejected, confirmed or completed".
An approved event later confirmed or cancelled still carries its decision, and AC9
says it stays visible. A status list would be a second copy of 025's
`decided_status_has_decision`, kept in the frontend, and would silently stop
showing the decision the day a status is added. The decision is the fact the
section displays, so it is the fact the section tests. `MyEventRequests` does the
same. `SCRUM19_AC9_a_decision_stays_on_show_after_the_status_moves_on` proves it
on a confirmed event.

### D7. Two 409s, told apart by the event's own date

029 deliberately shares 55000 between "not under review" and AC6 (D10), so both
arrive as 409. The remedies differ: a request that changed needs reopening; a past
event needs a new date agreed, or a rejection. Showing the first message for the
second sends the coordinator to reopen a request that will be refused again.

So, for a refused **approval**, the screen looks at the event's `proposedStart`,
already on screen: passed or missing means AC6's message; otherwise "this request
has changed". A **rejection** is never refused for its date, so its 409 is always
the status case. Not by matching the server's message text, which is free to
change; the date is data.

Two limits, both known:

- **Clock skew.** The screen asks "has it passed?" by the browser's clock; the
  server by its own. Within moments of the start time they can disagree, and the
  other message shows. The component's own comment states this. Both messages
  still say what to do next.
- **Order of checks.** 029 checks the status *before* the date. A request that was
  decided by someone else (or sent for clarification) *and* whose start has passed
  is refused for its status, but the screen shows the date message. Rare, since
  both must be true at once, and the remedy it suggests (reject, or agree a date)
  still leads the coordinator to reopen the request.

The proper fix is a distinct signal from the server: a code in the response body,
or a separate status. That needs a new `translateError` branch and was not worth it
for a message choice.

### D8. The decider's name is looked up in the assignment history, by `decidedBy`

`decidedBy` is a bare id, and neither the event nor the Organiser's list carries a
name for it. The assignment history does: every coordinator who ever held the
event appears as a `newCoordinatorId` with a `newCoordinatorName`. The decider must
have held the event when they decided, because 029 refuses anyone else, so their
entry is there. `DecisionOutcome` finds it by matching `decidedBy`.

**Not the newest entry.** An approved event can be handed over afterwards (018
allows approved and confirmed), so "the coordinator who decided" and "the
coordinator now responsible" can be different people. AC10 asks for the first; the
newest entry gives the second.

**Not the status history**, which also names who made each change: its read
refuses any coordinator the event is not currently assigned to, and the
coordinator screen uses `DecisionOutcome` too. The assignment history is readable
by the Organiser (their own event) and by every coordinator.

If the history does not name the decider, the line says "A coordinator with no
name on record", never the id. If the signed-in coordinator is the decider, it
says "You" and makes no request.

### D9. The reviewer is filled in, never overwritten, and checked after the status

`decide_event_request` sets `reviewing_coordinator_id = coalesce(reviewing_coordinator_id, p_decided_by)`.

- **Empty:** a request could reach `under_review` without a reviewer, through the
  status function, before `requestEventClarification` was changed. Trusting
  start-review to have run would make every such request undecidable. The person
  deciding is, at that moment, the person reviewing; recording it is true.
- **Someone else:** refused with 42501, never rewritten. 018 makes this
  unreachable through the application; the check makes the refusal a readable 403
  rather than a constraint error.
- **After the status check, not before.** A decided event keeps the reviewer who
  decided it, even after a handover. Checked first, the reviewer test would refuse
  the new coordinator on an approved event for the wrong reason. The status is the
  true reason a decided event cannot be decided again.

### D10. AC6 shares 55000 with a wrong status

It is the same kind of refusal: the event is not in a state that allows approval,
nothing the coordinator typed is wrong, and the remedy is to change the event, not
the form. It maps to the same 409 and its message says what to do. A code of its
own would need a new `translateError` branch for no difference in the API's
behaviour. The cost is D7's heuristic.

### D11. Asking for clarification starts the review first

`requestEventClarification` used to move a submitted request to `under_review`
through `changeEventRequestStatus`, leaving the reviewer empty. 025 then refused
every decision on that request: the coordinator who asked the question could
never approve or reject it. It now calls `startEventReview` first, then moves the
request to pending clarification, so whoever asks is the one who can later decide.
A request already under review is not started again.

### D12. The caller is checked before the status, so a draft is a 403

Both functions check "is this the assigned coordinator?" before "is the status
right?", as 018 does. A draft has no coordinator, so the caller check refuses it
first. Whether a request is in a reviewable state is a question only its
coordinator has reason to ask; anyone else is told it is not theirs. A null caller
is refused explicitly, because `is distinct from` alone would compare a null caller
with a null coordinator, find them not distinct, and let it through.

### D13. AC9's "cannot be edited" is the status machine, not a guard

Approved and rejected never return to `under_review` (022's 16 transitions), and
`decide_event_request` requires `under_review`, so a decided request cannot be
decided again through the application. PGlite proves it on both decided statuses.
Nothing protects the columns from a direct database write, and two transitions
SCRUM-318 owns touch a recorded decision; both are open questions rather than
hidden. A trigger comparing old and new rows would close the direct-write gap; it
was not built because nothing in the application writes those columns except 029
and 022's reopen, and a trigger would have to allow the second.

### D14. The note is trimmed in 029, and a blank one becomes null

The note is also the history row's reason, and 021's `reason_not_blank` refuses a
blank reason. Without the trim, an approval with a note of spaces would fail on the
history insert with an unreadable 23514. The service already turns a blank note
into null; 029 does it again for callers that do not come through the service.
PGlite's `SCRUM19_AC5_stores_a_blank_approval_note_as_null_and_still_records_the_approval`
proves it.

---

## 4. Known gaps and follow-ups

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC4: the Organiser's reply is not stored | Responding edits the request's fields; the reply's text is kept nowhere, so "the full clarification history" cannot exist | Needs a column or table, and a change to `respondToEventClarification` (open question 3) |
| AC4: the history is not shown | The coordinator's screen does not call `GET /:id/status-history`, although the questions are stored and readable | Follow-up |
| Four cases not implemented | AC4-02 (requirements shown: rendered, but no test asserts it), AC4-05 (blocked by the reply), AC4-06 (blocked by the screen), AC11-01 (deferred) | See the test-case document |
| AC11 | No notification; the table cannot take one | SCRUM-173 |
| Concurrency untested | Two coordinators at once, a decision racing a handover: both rest on 029's row lock, which PGlite cannot provoke. The 40001 refusals (AC1-17, AC7-04) are proved only through a fake | None; argued in 029 and 018 |
| No live check script for 029 | `assignment:check` covers 018; nothing runs `start_event_review` or `decide_event_request` against Supabase. PGlite now covers the function's behaviour; the live script would prove the deployed copy matches the file | Follow-up: `decision:check` |
| Return for amendment shows raw server errors | `handleReturnForAmendment` displays `error.response.data.error`, and the service's messages name the event's uuid (e.g. "Only the coordinator assigned to event request 2f…"). Start review and the decision use tables keyed by status; this handler predates them | Follow-up: give it a table like `DECISION_ERROR_MESSAGES` |
| The decision grid at phone width | `.decision-outcome` is a fixed two-column grid (`minmax(110px, 160px)` for the labels) with no override in either `@media (max-width: 720px)` block, unlike `.my-event-requests__details dl` beside it, which collapses to one column | Follow-up: one CSS rule. Not checked on a device |
| One history read per decided row | `MyEventRequests` mounts a `DecisionOutcome` per decided row, and each reads the assignment history once per page visit to find a name | Follow-up: the backend returns `decidedByName` with the request, as `/mine` does `organiserName` |
| A rejection's 409 on a past event | D7 says it always shows the "changed" message; no screen test feeds that combination | Follow-up: one test |
| The screen's 409 on a request both decided and past | Shows the date message although the server refused for the status (D7) | Accepted; a distinct server signal would fix it |

### Technical debt, including things this story did not cause

| Item | Detail |
|---|---|
| Migration-number collisions | **Six** numbers are used by two files each: **005** (`005_event_request_details.sql`, `005_venue_retirement.sql`), **014** (`014_booking_review_notifications.sql`, `014_coordinator_assignment.sql`), **015** (`015_assignment_function.sql`, `015_venue_block_amend_remove.sql`), **016** (`016_submit_event_request.sql`, `016_venue_block_history.sql`), **017** (`017_require_assigned_coordinator.sql`, `017_venue_turnaround.sql`), **022** (`022_equipment_schema.sql`, `022_event_status_transitions.sql`). The number no longer gives an order to apply files in. 029's header says "seven"; counted on 7 October there are six, the seventh (010) having been resolved by the rename to 025 |
| 025's header argues for claim-on-review | It says the codebase has no assignment model and that a reviewer *claims* a request by starting it. Both have been false since 014. 025 is applied and append-only, so it is correctly left unedited; 029's header records the change |
| 025's header on immutability | Says SCRUM-121 would guard "on the row still being undecided". What was built guards on `status = 'under_review'` (D13). Equivalent in effect, different in mechanism; also left unedited |
| 022's header on the decision columns | Says they "are not created by any migration in this folder", and so updates them through a dynamic statement. 025 is in the folder now. The dynamic statement still works; only the comment is stale. Applied, append-only |
| 029's own header, (b) | Says `requestEventClarification` moves a submitted request through `change_event_request_status`, and lists changing that as a follow-up. That follow-up is done (D11). Applied, append-only |
| No guard against a direct write to the decision columns | D13 |
| `translateError`'s 23503 branch | Still calls every foreign-key failure "Unknown organiser", and `decided_by` is one more user reference it would misname. Unreachable today. Carried from SCRUM-327 |
| `onChangeRequestProcessed` used for every refresh | Starting a review and deciding now refresh the parent through it too. The rename to `onEventChanged` recorded in SCRUM-327 is more overdue |

### Process notes

Stated plainly, because it will be asked.

- **The backend services and routes were built test-first.** Commit `247f003`
  added the failing service and route tests, for start-review and the decision
  alike; `6892aa8` made them pass.
- **029 itself was written before any test of it.** It came in `db4566f`, ahead of
  the failing tests, and those tests use a fake client, so nothing ran the
  function until SCRUM-134. It was applied live by hand in between.
- **The frontend tests were written alongside their implementation**, in the same
  commit (`a98f02b`), not before it. The brief for SCRUM-129 and SCRUM-133 ordered
  the screen and its tests together.
- **The PGlite tests (SCRUM-134) were written after both migrations and the
  services**, because the brief ordered it that way. They found no bug in 029.
  Applying 025 for real did change four existing tests in that file and remove
  two, each with its reason in a comment: fixtures at decided statuses now need
  a decision, and the status function can no longer move a request to approved
  or rejected.
- **The test-case document was rewritten after the code** (SCRUM-95), against the
  eleven criteria, replacing a September version written against eight criteria
  and a claim-on-review design. It no longer promises that case IDs are test
  names; it names the tests that prove each case.

The honest summary: the backend logic that a fake client can see was test-first;
everything a fake client cannot see (the functions, the constraints, the screen)
was tested after it was written.

---

## 5. Open questions for the team

Carried from the test-case document, which has the detail.

1. **Should `approved → rejected` record the rejection as a decision?** It goes
   through the status function, leaving `decision = 'approved'` on a rejected row,
   with no reason required. AC5 and AC9 both suggest it should go through
   `decide_event_request` or a sibling.
2. **Should `rejected → draft` keep the decision?** 022 clears the four decision
   fields, because a draft may not carry one, so the decision then survives only
   in the status history. AC9 says it cannot be edited; clearing it arguably is.
3. **Should the Organiser's clarification reply be stored?** AC4's "full
   clarification history" needs it.
4. **Should the status history be readable by every coordinator?** Today only by
   the Organiser and the assigned coordinator, while every coordinator can read
   the event itself. A coordinator covering for someone cannot see the
   clarification history.
5. **Should `rejected → draft` also clear `reviewing_coordinator_id`?** It is left
   in place, so a reopened draft still names its last reviewer, and 016 may assign
   a different coordinator on resubmission. Every path the application has today
   repairs it (start-review overwrites it; a handover moves it). It would bite only
   if a resubmitted request reached `under_review` through the status function
   directly, which 022 allows and no route does: the new coordinator's decision
   would be refused as "under review by another coordinator". Found by reading,
   not by a failing test.

---

## Before the examination

- **Check every criterion against Jira** (the warning above). AC4 and AC6 are the
  likeliest to differ in wording: AC4 for "full", AC6 for whether a missing date
  counts.
- **Walk the feature by hand once and record it here:** an Organiser submits; the
  assigned coordinator starts the review, approves one request and rejects another
  with a reason; another coordinator opens both and sees the decisions and nothing
  to press; the Organiser sees both outcomes with the decider's name; an approval
  of an event dated in the past is refused with AC6's message.
- **Be ready for "why a separate step to start a review?"** D1, and the paragraph
  under AC1's trace. It is the least obvious decision in the story and the one
  most worth being able to explain in two sentences.
