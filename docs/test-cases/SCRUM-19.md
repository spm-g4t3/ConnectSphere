# SCRUM-19 — Test Cases

**Story:** Approve or Reject a Submitted Event Request — Event Coordinator
**Subtask:** SCRUM-95 (this document)
**Schema:** `backend/db/migrations/025_event_request_decisions.sql` (columns and constraints; renamed from 010 on 6 October 2026) and `029_event_request_decisions_functions.sql` (the two functions)
**Rewritten:** 7 October 2026, replacing the September version written against eight criteria and a claim-on-review design

This document is the written layer between SCRUM-19's acceptance criteria and the
Vitest files that implement them. Deliverable #3 requires test cases traceable
from user stories and acceptance criteria to tests; the chain is
**user story → acceptance criteria → test case → test class → code**, and it is
walked for a randomly chosen feature in the Week 13 Q&A.

---

## How case IDs relate to test names

The September version promised that every case ID would be used verbatim as a
test name. That promise was not kept, and this version does not repeat it.

The tests were written test-first against the subtasks (SCRUM-346, SCRUM-119,
SCRUM-121, SCRUM-129, SCRUM-133), and one case is usually proved at more than one
layer: the service, the route, and the screen each have a test for the same
behaviour, under different names. A one-to-one promise between an ID and a name
cannot describe that.

So this document gives each case a short stable ID (`AC1-01`), and an
**Implemented by** column naming every test that proves it, read from the test
files, not invented. A case with no test says **not implemented**, and why. The
test names all start `SCRUM19_ACn_`, so a test can be traced back to its AC by
name alone.

Abbreviations in the **Implemented by** column:

| Short | File |
|---|---|
| svc | `backend/tests/services/eventRequestService.test.js` |
| route | `backend/tests/routes/eventRequests.test.js` |
| detail | `frontend/tests/components/CoordinatorRequestDetail.test.jsx` |
| list | `frontend/tests/components/MyEventRequests.test.jsx` |
| pglite | `backend/tests/db/eventStatusLifecycleDatabase.test.js` (real Postgres, in process) |
| mig | `backend/tests/db/eventStatusLifecycleMigration.test.js` (reads migration text) |

`%s` in a name is a parameterised test (`it.each`); one name covers several rows.

---

## The story

> **USER STORY:** As an Event Coordinator, I want to approve or reject an event
> request I am responsible for, so that only viable events consume venue and
> equipment planning effort.

### Acceptance criteria

**The wording below is reconstructed, not quoted.** The ticket's text is in Jira
and not in this repository. The numbering is the one the code and the tests cite
(029's header, the services, the test names). AC1's wording is the only one
quoted anywhere in the repository, in 025's header, and that quote predates the
change to automatic assignment. **Check every criterion against Jira before the
examination; where they differ, Jira wins and this document should be corrected.**

1. Only the Event Coordinator assigned to an event request can review and decide
   it. The assigned coordinator starts the review of a submitted request, which
   moves it to Under review; anyone else is refused.
2. A decision can be made only on a request that is under review.
3. Attempting to decide a request in any other state, including Pending
   clarification, is refused with a message, and leaves the event unchanged.
4. Before deciding, the coordinator can view the event's requirements and the
   full clarification history.
5. Rejecting requires a reason; approving allows an optional note.
6. An approval is refused when the event's proposed start date has passed.
7. Approving sets the status to Approved; rejecting sets it to Rejected.
8. Venue booking requests and equipment requests can be raised only against an
   event that is Approved or Confirmed.
9. The outcome, the reason or note, the deciding coordinator, and the date and
   time of the decision are recorded, and cannot be edited afterwards.
10. The Event Organiser can view the outcome, the reason or note, and the name of
    the coordinator who decided.
11. The Event Organiser is notified of the decision.

### Notes on scope

- **AC1** was first met by *claim on review*: whoever started reviewing owned the
  decision. SCRUM-327 replaced that with automatic assignment on submission, on
  the customer's word that coordinators are assigned by the system. The assigned
  coordinator is now the one who starts the review and decides.
- **AC4** is partial. See its section.
- **AC8** is met as far as this story can meet it. See its section.
- **AC11** is deferred to SCRUM-173. See its section.

---

## Design decisions the cases rest on

Each is stated as the argument, because that is what is asked for.

**Assignment replaced claim-on-review.** Since migration 014 every event past
draft has an `assigned_coordinator_id`, set when it is submitted (016) and moved
only by a handover (018). The September version of this document said "there is
no assignment model" and "event_requests has no coordinator_id"; both have been
false since 014. 025's header still argues for claim-on-review, because 025 is
applied and append-only; 029's header records the change.

**`start_event_review` exists because nothing else sets the reviewer.** 025's
`event_requests_decided_by_is_reviewer` requires `decided_by` to equal
`reviewing_coordinator_id`. Before 029, no function wrote that column: 018 moves
it on a handover only if it is already set, and the backfills only read it. So no
decision could be recorded at all. Starting the review is the moment the
assigned coordinator becomes the reviewer. It is its own function, not a call to
`change_event_request_status` (022), because that function cannot set the
reviewer, and giving it a parameter would change a signature SCRUM-318 owns. The
same argument 021 makes for `submit_event_request` writing its own history row.

**Asking for clarification also starts the review.** `requestEventClarification`
used to move a submitted request to under review through
`change_event_request_status`, which left the reviewer empty, so that request
could never be decided. It now starts the review through `startEventReview`
first. `decide_event_request` also fills in an empty reviewer, for any request
that reached under review before this change.

**The status and the decision are written in one statement.** 025's five
constraints are row-level: Postgres checks each against the whole row after every
statement. Writing the status first leaves an approved row with no decision,
which `decided_status_has_decision` refuses. Writing the decision first leaves an
under-review row with a decision, which `decision_has_decided_status` refuses.
Either order fails on its first statement, so `decide_event_request` writes the
status, the four decision fields and (if empty) the reviewer together.

**AC6 is measured against an injected clock.** `decide_event_request` takes
`p_decided_at` rather than calling `now()`, and `decideEventRequest` passes its
`now` option. That is 016's reason for `p_submitted_at`, and it matters more
here, because the instant decides an outcome: "has the start date passed" is
asked at that instant. With `now()`, a test of the boundary would pass or fail
depending on when it ran. A missing start date is also refused on approval,
because submission requires one, so a missing one means a row made outside the
application.

**AC9's "cannot be edited" is enforced by the status machine, not by a guard.**
`approved` and `rejected` never return to `under_review` (`ALLOWED_TRANSITIONS`
and 022's `event_request_status_allows`), and `decide_event_request` requires
`under_review`, so a decided request cannot be decided again through the
application. Nothing protects the columns from a direct database write. Two
transitions SCRUM-318 owns do touch a recorded decision, stated here rather than
hidden:

- `approved → rejected` is allowed, and goes through `change_event_request_status`,
  which does not touch the decision. It leaves `decision = 'approved'` on a
  rejected row, and the constraints accept that.
- `rejected → draft` (022) clears `decision`, `decision_note`, `decided_by` and
  `decided_at` with the status, because a draft may not carry a decision. The
  decision then survives only in the status history.

Both are open questions for the team (below).

**Codes, not messages.** 029 raises each refusal with its own SQLSTATE, and
`translateError` maps by code: P0002 → 404, 42501 → 403, 55000 → 409,
22023 → 400, 40001 → 409, 22004 → untyped 500. AC6's refusal deliberately
shares 55000 with a wrong status. The screen tells the two apart by the event's
own start date, because the remedies differ (reopen the request, or agree a new
date).

### Endpoints

| Purpose | Route | Service | Function |
|---|---|---|---|
| Start the review | `POST /api/event-requests/:id/start-review` | `startEventReview` | `start_event_review` |
| Approve or reject | `POST /api/event-requests/:id/decision` | `decideEventRequest` | `decide_event_request` |
| Read one request as a coordinator | `GET /api/event-requests/:id/review` | `getEventRequestForCoordinator` | — |
| Read the status history | `GET /api/event-requests/:id/status-history` | `getEventRequestStatusHistory` | — |

Not `POST /:id/review`: `GET /:id/review` is already the coordinator's read, and
two verbs on one path for unrelated actions would read as one resource.

Decision body: `{ "decision": "approved" | "rejected", "decisionNote": "…" }`.
The decider and the time are never taken from the body.

### Shorthand for preconditions

- **ASSIGNED** — the event's assigned coordinator (`assigned_coordinator_id`).
- **OTHER_COORD** — any other user with role `event_coordinator`.
- **ORGANISER** — the event's own Organiser.
- **OTHER_ORG** — a different Organiser.
- **Unchanged** — status, the four decision fields, `reviewing_coordinator_id`
  and the status history all as they were.

---

## AC1 — only the assigned coordinator reviews and decides

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | `submitted`, held by ASSIGNED | ASSIGNED starts the review | 200. Status `under_review`; `reviewing_coordinator_id` is ASSIGNED; one call to `start_event_review`, nothing else | svc `SCRUM19_AC1_starts_the_review_through_the_function_alone`, `SCRUM19_AC1_returns_the_request_with_its_reviewer`; route `SCRUM19_AC1_the_assigned_coordinator_starts_the_review`; detail `SCRUM19_AC1_starting_the_review_moves_the_panel_on_to_the_decision` |
| AC1-02 | `submitted`, held by ASSIGNED | OTHER_COORD starts the review | 403 with the function's message | svc and route `SCRUM19_AC1_only_the_assigned_coordinator_starts_the_review` |
| AC1-03 | Any status but `submitted` | ASSIGNED starts the review | 409 naming the status | svc `SCRUM19_AC1_only_a_submitted_request_can_be_put_under_review`; route `SCRUM19_AC1_a_request_that_is_not_submitted_cannot_be_put_under_review` |
| AC1-04 | Any | ORGANISER calls either route | 403 from `coordinatorOnly`, nothing queried | route `SCRUM19_AC1_an_organiser_cannot_start_a_review_and_nothing_is_queried`, `SCRUM19_AC1_an_organiser_cannot_decide_and_nothing_is_queried` |
| AC1-05 | Any | No token, either route | 401, nothing queried | route `SCRUM19_AC1_starting_a_review_returns_401_without_a_token`, `SCRUM19_AC1_deciding_returns_401_without_a_token` |
| AC1-06 | Any | Body names someone else as the coordinator or decider | Ignored; the caller is the token's user | route `SCRUM19_AC1_the_assigned_coordinator_starts_the_review`, `SCRUM19_AC7_the_assigned_coordinator_approves` |
| AC1-07 | Any | Missing or blank coordinator or decider id | 400 before any call | svc `SCRUM19_AC1_refuses_a_coordinator_id_that_is_%s_before_any_call`, `SCRUM19_AC1_refuses_a_decider_id_that_is_%s_before_any_call` |
| AC1-08 | `under_review`, held by ASSIGNED | OTHER_COORD decides | 403 | svc and route `SCRUM19_AC1_only_the_assigned_coordinator_decides`; detail `SCRUM19_AC1_a_403_on_a_decision_says_the_request_is_not_theirs` |
| AC1-09 | `under_review`, held by ASSIGNED, someone else recorded as reviewer | ASSIGNED decides | 403; the reviewer is never overwritten | svc `SCRUM19_AC1_only_the_reviewing_coordinator_decides` |
| AC1-10 | `submitted`, held by ASSIGNED | ASSIGNED asks for clarification | The review is started through `start_event_review` first, so the reviewer is set | svc `SCRUM19_AC1_clarification_starts_the_review_so_the_reviewer_is_set` |
| AC1-11 | `under_review` | ASSIGNED asks for clarification | Not started again; one status change only | svc `SCRUM19_AC1_a_request_already_under_review_is_not_started_again` |
| AC1-12 | `submitted`, signed in as ASSIGNED | Open the event | Start review is the only action | detail `SCRUM19_AC1_a_submitted_request_offers_the_assigned_coordinator_start_review_only` |
| AC1-13 | `submitted` or `under_review`, signed in as OTHER_COORD | Open the event | No action buttons; a line saying who can act | detail `SCRUM19_AC1_a_%s_request_offers_another_coordinator_nothing_to_press` |
| AC1-14 | Start review refused with 403 | — | The screen explains in words, not ids | detail `SCRUM19_AC1_a_refused_start_says_why_in_words_not_ids` |
| AC1-15 | Any | `start_event_review` called directly with a null caller | 42501 | **Not implemented.** The service always sends a caller; only a direct call reaches this, and no test makes one. `check-coordinator-assignment.js` proves the same guard for 018, not 029 |
| AC1-16 | No such event | Start the review | 404 | svc `SCRUM19_AC1_reports_an_event_that_does_not_exist_as_not_found` |
| AC1-17 | The guarded update matches no row | Start the review | 409 | svc `SCRUM19_AC1_reports_a_review_started_in_a_race_as_a_conflict` |
| AC1-18 | Any | Start the review | No update or insert outside the function | svc `SCRUM19_AC1_writes_nothing_outside_the_function` |
| AC1-19 | Any | POST to `/start-review` and `/decision` | Neither path is read as an id | route `SCRUM19_AC1_the_start_review_path_is_not_read_as_an_id`, `SCRUM19_AC7_the_decision_path_is_not_read_as_an_id` |

---

## AC2 — only a request under review is decided

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | `under_review`, held and reviewed by ASSIGNED | ASSIGNED decides | 200; one call to `decide_event_request` with all five arguments | svc `SCRUM19_AC7_decides_through_the_function_alone`; route `SCRUM19_AC7_the_assigned_coordinator_approves` |
| AC2-02 | `submitted` | ASSIGNED decides without starting the review | 409 naming `submitted` | svc `SCRUM19_AC2_refuses_a_decision_on_a_request_not_yet_under_review` |
| AC2-03 | No such event | Decide | 404 | svc `SCRUM19_AC2_reports_an_event_that_does_not_exist_as_not_found` |
| AC2-04 | `under_review`, signed in as ASSIGNED | Open the event | Approve, Reject and Return for amendment | detail `SCRUM19_AC7_under_review_offers_approve_reject_and_return` |
| AC2-05 | A future event; the decision is refused with 409 | — | The screen says the request has changed, not that the date has passed | detail `SCRUM19_AC2_a_409_on_a_future_event_says_the_request_changed` |

---

## AC3 — any other state is refused, including Pending clarification

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | `pending_clarification` | ASSIGNED decides | 409 naming the status | svc and route `SCRUM19_AC3_refuses_a_decision_on_a_request_awaiting_clarification` |
| AC3-02 | Already `approved` or `rejected` | ASSIGNED decides again | 409; the first decision unchanged | **Not implemented** as its own test. The same 55000 path as AC3-01, raised by 029's status check; no test feeds an already-decided status |
| AC3-03 | `pending_clarification`, signed in as ASSIGNED | Open the event | The waiting-for-amendment panel; no decision actions | detail `SCRUM19_AC3_pending_clarification_shows_the_waiting_panel_and_no_decision_actions` |
| AC3-04 | Any refused decision | Read the row afterwards | Unchanged | **Not implemented.** A refusal rolls back inside 029's function, which a fake client cannot observe; no test runs 029 against a real database |

---

## AC4 — the requirements and the full clarification history

**Partial.** The coordinator sees the requirements. The clarification history is
half there:

- **Stored:** every move into `pending_clarification` writes a status-history row
  whose `reason` is the coordinator's question, with who asked and when. It is
  readable through `GET /:id/status-history`, by the Organiser and by the event's
  assigned coordinator.
- **Not stored:** the Organiser's reply. Responding edits the request's own fields
  and writes a `pending_clarification → under_review` row with no reason. The
  reply's text is not kept anywhere, so "the full clarification history" cannot
  be shown.
- **Not shown:** nothing on the coordinator's screen reads the status history yet.

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | Any status past draft | Any coordinator reads the event | 200, every requirement field | svc `SCRUM332_AC7_any_coordinator_can_read_an_event`; route `SCRUM332_AC7_any_coordinator_can_read_an_event_in_%s` |
| AC4-02 | As above | Open the event on the coordinator's screen | Purpose, description, dates, attendance and the three requirements shown | **Not implemented.** `CoordinatorRequestDetail` renders them, but no test asserts it |
| AC4-03 | `under_review` | Ask for clarification with a question | The question is stored as the history row's reason, and as the clarification note | pglite `SCRUM325_stores_the_reason_when_one_is_given`, `SCRUM325_keeps_the_clarification_note_with_the_status` |
| AC4-04 | A request with clarification rounds | The assigned coordinator, or the Organiser, reads the status history | Every transition, oldest first, with who, when and the reason | svc `SCRUM322_AC6_returns_previous_status_new_status_name_time_and_reason`; route `SCRUM322_AC6_shows_the_assigned_coordinator_the_full_history`, `SCRUM322_AC6_shows_the_organiser_the_full_history_oldest_first` |
| AC4-05 | The Organiser has replied to a clarification | Read the history | The reply's text appears | **Not implemented.** The reply is not stored (above) |
| AC4-06 | A request with clarification rounds | Open it on the coordinator's screen | The clarification history is shown before the decision | **Not implemented.** The screen does not call `GET /:id/status-history` |

---

## AC5 — a rejection needs a reason; an approval's note is optional

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | `under_review` | Reject with a reason | 200; the reason sent as `p_decision_note` and returned as `decisionNote` | svc `SCRUM19_AC7_decides_through_the_function_alone`; route `SCRUM19_AC9_the_response_carries_the_recorded_decision`; detail `SCRUM19_AC5_a_rejection_sends_its_reason` |
| AC5-02 | `under_review` | Reject with no reason, or a blank one | 400 naming `decisionNote`, before any call | svc `SCRUM19_AC5_refuses_a_rejection_whose_reason_is_%s_before_any_call`; route `SCRUM19_AC5_a_rejection_with_no_reason_is_a_400_naming_the_field`; detail `SCRUM19_AC5_a_rejection_with_no_reason_is_refused_before_the_call` |
| AC5-03 | The function itself refuses a missing reason (22023) | — | Still 400, with the function's message | svc `SCRUM19_AC5_the_functions_refusal_of_a_missing_reason_is_still_a_400` |
| AC5-04 | `under_review` | Approve with no note, or a blank one | Sent as null | svc `SCRUM19_AC5_sends_an_omitted_or_blank_note_on_an_approval_as_null` |
| AC5-05 | `under_review` | Approve with a note | The note sent and shown | route `SCRUM19_AC7_the_assigned_coordinator_approves`; detail `SCRUM19_AC7_approving_sends_the_decision_and_shows_it_read_only` |

---

## AC6 — no approval once the start date has passed

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | `under_review`, start date passed | Approve | 409 with 029's message: agree a new date or reject | svc and route `SCRUM19_AC6_refuses_an_approval_when_the_start_date_has_passed` |
| AC6-02 | As above, on the screen | Approve | The screen says the start date has passed and what to do | detail `SCRUM19_AC6_a_409_on_an_approval_whose_start_date_has_passed_says_to_agree_a_new_date` |
| AC6-03 | Any | Decide | `p_decided_at` is the service's injected clock | svc `SCRUM19_AC7_decides_through_the_function_alone` |
| AC6-04 | `under_review`, start date passed | Reject | Allowed | **Not implemented.** The date rule is inside 029; no test runs it |
| AC6-05 | `under_review`, no start date | Approve | 409 | **Not implemented**, for the same reason |
| AC6-06 | Start date exactly equal to the decision time | Approve | 409: a start at the decision time counts as passed | **Not implemented**, for the same reason |

---

## AC7 — the status becomes Approved or Rejected

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | `under_review` | Approve | 200, status `approved` | route `SCRUM19_AC7_the_assigned_coordinator_approves` |
| AC7-02 | `under_review` | Reject with a reason | 200, status `rejected` | route `SCRUM19_AC9_the_response_carries_the_recorded_decision` |
| AC7-03 | Any | Decision of `Approved`, `REJECTED`, an unknown word, empty, missing, null or a number | 400 naming `decision`, before any call | svc `SCRUM19_AC7_refuses_a_decision_that_is_%s_before_any_call` |
| AC7-04 | The guarded update matches no row | Decide | 409 | svc `SCRUM19_AC7_reports_a_decision_made_in_a_race_as_a_conflict` |
| AC7-05 | The function receives a null time | — | Untyped, a 500 | svc `SCRUM19_AC7_a_null_decision_time_is_a_server_fault` |
| AC7-06 | Any | Decide | No update or insert outside the function: one statement inside it | svc `SCRUM19_AC9_writes_nothing_outside_the_function` |

The status written is proved only through what the fake returns. That 029 writes
`approved` or `rejected` in the same statement as the decision is proved by the
function's own text and the live verification (see *What cannot be tested*).

---

## AC8 — venue bookings and equipment only against Approved or Confirmed

**Met as far as this story can meet it; no cases here.** The rule constrains what
may be *raised* against an event, so it belongs where the thing is raised: at the
venue booking request's write (SCRUM-243) and the equipment request's write
(SCRUM-21). SCRUM-21's AC1 already states it. SCRUM-124, which was to have put a
guard in this story, was closed for this reason. Neither feature exists on this
branch yet, so there is nothing to test here, and a guard written now would have
no caller.

---

## AC9 — the decision is recorded and cannot be edited

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC9-01 | Any decision | — | The response carries `decision`, `decisionNote`, `decidedBy`, `decidedAt`, in camelCase | svc `SCRUM19_AC9_returns_the_recorded_decision_in_camelCase`; route `SCRUM19_AC9_the_response_carries_the_recorded_decision` |
| AC9-02 | Decided and undecided requests | Read either through an ordinary read | Every read selects all five columns; an undecided request reads them as null | svc `SCRUM19_AC9_every_read_carries_the_decision` |
| AC9-03 | Decided | ASSIGNED or OTHER_COORD opens it | The decision read-only, with the decider's name; no actions | detail `SCRUM19_AC9_a_decided_request_shows_its_decision_read_only_to_%s` |
| AC9-04 | Approved, then confirmed | Open it | The decision still shown | detail `SCRUM19_AC9_a_decision_stays_on_show_after_the_status_moves_on` |
| AC9-05 | Decided | Decide again | Refused, the first decision intact | **Not implemented**; the same gap as AC3-02 |
| AC9-06 | Any decision | Read the status history | One row, `under_review → approved/rejected`, by the decider, with the note as its reason | **Not implemented**; written inside 029, which no test runs |
| AC9-07 | Rejected, with a decision recorded | Reopen as a draft | The four decision fields cleared with the status | pglite `SCRUM318_clears_the_decision_with_the_status_and_runs_022_again_without_error`, against hand-made copies of two of 025's constraints, not 025 itself |

AC9-07 is the second of the two transitions named in *Design decisions*. It is
proved because it is what 022 does; whether it should happen is an open question.

---

## AC10 — the Organiser sees the outcome, the note and who decided

The decider's name is looked up in the assignment history by matching
`decidedBy`, because the decider must have held the event when they decided.
Using the newest entry would give the *current* coordinator instead, who may be
different after a handover.

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC10-01 | Rejected | ORGANISER opens their list | Outcome, reason, decider's name and time, on the row | list `SCRUM19_AC10_the_organiser_sees_the_outcome_the_reason_and_who_decided` |
| AC10-02 | Approved with a note | ORGANISER opens their list | Outcome, note and name | list `SCRUM19_AC10_an_approval_shows_its_note_and_who_decided` |
| AC10-03 | Undecided | ORGANISER opens their list | No outcome, and no history read | list `SCRUM19_AC10_an_undecided_request_shows_no_outcome_and_reads_no_history` |
| AC10-04 | Decided; the history does not name the decider | Open the list | An honest "no name on record", never an id | list `SCRUM19_AC10_a_decider_missing_from_the_history_is_named_honestly` |
| AC10-05 | Decided, belonging to someone else | OTHER_ORG reads it | 404, as for a missing request | route `SCRUM14_AC1_returns_404_for_another_organisers_request`; svc `SCRUM14_AC1_hides_another_organisers_request_behind_a_not_found`. The decision travels with the request, so the request's own 404 covers it |

---

## AC11 — the Organiser is notified

**Deferred to SCRUM-173, which is unassigned.** It cannot be built on today's
schema. The notifications table (014) has a `notifications_type_known` check that
allows only `'booking_flagged'`, and it references bookings and blocks, with no
`event_request_id` column. A decision notification needs a migration first: a new
type, the constraint widened, an event reference, and a writer, ideally inside
`decide_event_request`'s transaction so a decision and its notification cannot
part. Nobody owns E8 (notifications for events), the epic this belongs to.

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC11-01 | Any | ASSIGNED decides | The Organiser receives a notification naming the outcome | **Not implemented**; deferred (above) |

---

## Database constraints — the second line of defence

025 adds five constraints. Every case above is refused by the service or by 029
before a write, so none of them exercises a constraint directly.

| Constraint | Rule | Proved by |
|---|---|---|
| `event_requests_decided_status_has_decision` | approved, rejected, confirmed and completed require a decision | mig `requires a decision for the decided statuses, without planning` checks 020's rewrite of its status list as text. pglite's `SCRUM318_clears_the_decision_…` runs a hand-made copy. **Nothing runs 025's own definition** |
| `event_requests_decision_has_decided_status` | a decision only on a decided status, or cancelled | The same two, the same caveat |
| `event_requests_rejection_has_reason` | a rejection has a non-blank note | **Nothing** |
| `event_requests_decided_by_is_reviewer` | `decided_by` is null or equals `reviewing_coordinator_id` | **Nothing** |
| `event_requests_decision_fields_together` | decision, decided_by and decided_at all set or all null | **Nothing** |

**The fix is within reach.** The PGlite suite applies the real migrations to an
in-process Postgres, in CI, with no credentials. It skipped SCRUM-19's migration
because, its header says, that migration "is not on this branch". It is now (025),
and so is 029. Adding both to the PGlite suite would prove all five constraints
and both functions, AC3-04, AC6-04 to AC6-06, AC9-05 and AC9-06 included, in CI.
That is the single most valuable follow-up to this document.

---

## Open questions for the team

1. **Should `approved → rejected` record the rejection as a decision?** Today it
   leaves `decision = 'approved'` on a rejected row, and a rejection needs no
   reason on that path. AC5 and AC9 both suggest it should go through
   `decide_event_request`, or a sibling of it, not the plain status function.
2. **Should `rejected → draft` keep the decision?** 022 clears it, because a draft
   may not carry one, so the decision then lives only in the status history. AC9
   says the decision cannot be edited; clearing it is arguably an edit.
3. **Should the Organiser's clarification reply be stored?** AC4's "full
   clarification history" needs it. It needs a column or a table, and a change to
   `respondToEventClarification`.
4. **Should the status history be readable by every coordinator?** It is readable
   only by the Organiser and the assigned coordinator, while every coordinator
   can read the event itself (SCRUM-332). A coordinator covering for someone
   cannot see the clarification history.

---

## What cannot be tested as written

- **AC8** — its subject (raising a booking or an equipment request) does not exist
  on this branch.
- **AC11** — needs a schema change first.
- **Concurrency** — two coordinators deciding at once, or a decision racing a
  handover, rest on 029's row lock. A single-threaded test cannot provoke it, and
  PGlite runs one query at a time. The 40001 refusals (AC1-17, AC7-04) are proved
  only through a fake.
- **Everything inside 029** (AC1-15, AC3-02, AC3-04, AC6-04 to AC6-06, AC9-05,
  AC9-06), until 029 is added to the PGlite suite. 029 was verified against the
  live database when it was applied, but that verification is not a script or a
  test in this repository, so it cannot be re-run or cited here.

---

## Case ownership

| Cases | Subtask |
|---|---|
| The two functions, and every case marked "not implemented" for that reason | SCRUM-109, SCRUM-122 (`029_event_request_decisions_functions.sql`) |
| AC1 start-review cases, AC1-10 and AC1-11 | SCRUM-346 |
| AC1 decide cases, AC2, AC3, AC5, AC6, AC7, AC9-01 and AC9-02 | SCRUM-119, SCRUM-121 |
| detail cases (AC1-12 to AC1-14, AC2-04, AC2-05, AC3-03, AC6-02, AC9-03, AC9-04) | SCRUM-129 |
| list cases (AC10-01 to AC10-04) | SCRUM-133 |
| AC11 | SCRUM-173 (deferred, unassigned) |
| This document | SCRUM-95 |

**Tally:** 64 cases. 52 map to at least one existing test; 12 are not implemented.
AC8 has no cases, by design.
