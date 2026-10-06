# SCRUM-19 — Test Cases

**Story:** Approve or Reject a Submitted Event Request — Event Coordinator
**Subtask:** SCRUM-95 (design) → implemented by SCRUM-134
**Schema:** `backend/db/migrations/025_event_request_decisions.sql` (applied; renamed from 010 on 6 October 2026)

This document is the written layer between SCRUM-19's acceptance criteria and the
Vitest files that implement them. Deliverable #3 requires test cases traceable
from user stories and acceptance criteria to tests; the chain is
**user story → acceptance criteria → test case → test class → code**, and it is
walked for a randomly chosen feature in the Week 13 Q&A.

Every case ID below is used verbatim as a test name in SCRUM-134.

---

## The story

> **USER STORY:** As an Event Coordinator, I want to approve or reject an event
> request I am reviewing, so that only viable events consume venue and equipment
> planning effort.

### Acceptance criteria

1. Only the Event Coordinator who is reviewing an event request can approve or
   reject it. A coordinator begins reviewing a submitted request, which claims it
   for them. The action is not offered to any other user, and any attempt to
   decide by a coordinator who is not the reviewer is refused with an explanatory
   message and leaves the event unchanged.
2. A decision can be made only on a request that has been submitted and is not
   currently awaiting clarification from the Event Organiser. Attempting to decide
   on a request in any other state is refused with a message stating the request's
   current state, and leaves the event unchanged.
3. Before deciding, the coordinator can view the event requirements as submitted.
4. Rejecting the request requires the coordinator to give a reason; approving
   allows an optional note.
5. Approving the request sets the event's status to "Approved"; rejecting it sets
   the event's status to "Rejected".
6. Venue booking requests and equipment requests can be raised against an event
   with the status "Approved", and cannot be raised against an event with the
   status "Rejected".
7. The outcome, the deciding coordinator, the reason or note, and the date and
   time of the decision are recorded against the event and cannot be edited
   afterwards.
8. The Event Organiser can view the outcome of their request and the reason
   recorded for it.

### Notes on scope

- **AC1** — "assigned" is implemented as **claim on review**. `event_requests` has
  no assignment model; the team built a shared coordinator queue, and Coordinator
  Assignment is core feature #5, a separate story. The coordinator who starts
  reviewing a submitted request claims it and owns the decision.
- **AC3** — the clarification history originally in this criterion is split to its
  own story. The exchange needs a message model that does not exist yet and
  belongs to core feature #7. This story assumes no clarification has occurred;
  AC2 still excludes requests awaiting clarification.

---

## Design decisions the cases rest on

- **No assignment model.** `event_requests` has no `coordinator_id`. This is a
  documented design decision, not an oversight — see the comment in
  `eventRequestStatus.js` and the note inside `SCRUM45_AC2_never_admits_a_draft`
  in `eventRequestStatus.test.js`, both of which state that excluding `draft` from
  the shared queue *is* the access control, precisely because every coordinator
  sees every row the queue admits. `reviewing_coordinator_id` (migration 010)
  records a claim, not an assignment.
- **Claiming and deciding are two calls.** Claiming moves `submitted →
  under_review` and stamps `reviewing_coordinator_id`. Deciding moves
  `under_review → approved | rejected`. The claim work sits in SCRUM-109.
- **`approved` and `rejected` are reachable only from `under_review`** — see
  `ALLOWED_TRANSITIONS` in `src/domain/eventRequestStatus.js`. A decision on a
  request still in `submitted` is refused; the coordinator must claim it first.
- **A second claim is refused by the status machine alone.**
  `ALLOWED_TRANSITIONS[under_review]` does not contain `under_review`, so
  re-claiming needs no extra rule.
- **`pending_clarification` is ineligible for a decision**, and is covered below
  even though nothing can currently reach that status. The guard is correct in
  advance.
- **Releasing or reassigning a claim is out of scope** and logged as a customer
  question. No cases are written for it.

### Dependency on SCRUM-121

`COLUMNS` and `toEventRequest` in `eventRequestService.js` currently select and
map fifteen fields, none of them the five that `010` added. Until they are
extended, no service read returns `decision`, `decisionNote`, `decidedBy`,
`decidedAt` or `reviewingCoordinatorId` — so **every AC8 case, and every case
asserting "row unchanged" through the service layer, is unwritable.** Extending
them belongs to SCRUM-121, not to this document, but it blocks a third of these
cases and must land first.

### Endpoints

Paths are SCRUM-119's to fix; these follow the verb convention set by the existing
`POST /:id/submit`.

| Purpose | Path |
|---|---|
| Claim a request for review | `POST /api/event-requests/:id/review` |
| Record a decision | `POST /api/event-requests/:id/decide` |
| Read one request as coordinator | `GET /api/event-requests/:id` (see AC3) |

Decision payload: `{ "decision": "approved" | "rejected", "decisionNote": "…" }`

`decisionNote`, not `note` — every field in the service's column map is the
camelCase form of its column, and the column is `decision_note`.

### Shorthand for preconditions

- **REVIEWER** — a user with role `event_coordinator` who has claimed the request;
  the row's `reviewing_coordinator_id` is their id.
- **OTHER_COORD** — a different `event_coordinator`, authenticated.
- **ORGANISER** — the `event_organiser` who submitted the request.
- **OTHER_ORG** — a different `event_organiser`.
- **Unchanged** — `status`, `decision`, `decision_note`, `decided_by`,
  `decided_at` and `reviewing_coordinator_id` all hold the values they had before
  the action.

### Fixture note

Nothing in the codebase writes a status beyond `submitted`. Fixtures for
`under_review`, `pending_clarification`, `approved`, `rejected`, `planning`,
`confirmed`, `completed` and `cancelled` must therefore be constructed — trivially
at unit level via `storedRow({ status })` with the fake client, and by a direct
database write at integration level.

---

## AC1 — only the reviewing coordinator can decide

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC1_a_coordinator_claims_an_unclaimed_submitted_request` | `submitted`; `reviewing_coordinator_id` null | OTHER_COORD claims it | 200. Status `under_review`; `reviewing_coordinator_id` is that coordinator's id; no decision fields written |
| `SCRUM19_AC1_the_reviewing_coordinator_can_decide` | `under_review`, claimed by REVIEWER | REVIEWER approves | 200. Status `approved`; decision recorded against REVIEWER |
| `SCRUM19_AC1_a_different_coordinator_cannot_decide` | `under_review`, claimed by REVIEWER | OTHER_COORD approves | 403. Message states the caller is not reviewing this request. Row unchanged |
| `SCRUM19_AC1_an_event_organiser_cannot_decide` | `under_review`, claimed by REVIEWER | ORGANISER approves | 403 from `requireRole`, message `This action is restricted to Event Coordinators`. Row unchanged |
| `SCRUM19_AC1_venue_staff_cannot_decide` | As above | `venue_staff` approves | 403 from `requireRole`. Row unchanged |
| `SCRUM19_AC1_an_unauthenticated_caller_cannot_decide` | As above | No `Authorization` header | 401 `Authentication required`. Row unchanged |
| `SCRUM19_AC1_a_caller_with_no_profile_row_cannot_decide` | As above; caller authenticates but has no `profiles` row | Approve | 403 `Your account has no role assigned` — distinct from the wrong-role 403, and not a 401, since signing in again would not help |
| `SCRUM19_AC1_claiming_a_request_another_coordinator_holds_is_refused` | `under_review`, claimed by REVIEWER | OTHER_COORD claims it | 409. Message states the request is already under review. `reviewing_coordinator_id` unchanged |
| `SCRUM19_AC1_a_concurrent_second_claim_is_refused` | `submitted`, unclaimed; the guarded write matches no row because another coordinator claimed it first | OTHER_COORD claims it | 409 `ConflictError`. The claim is a guarded write on `status = 'submitted'`, the same pattern `submitEventRequest` uses on `draft` |
| `SCRUM19_AC1_a_refused_decision_leaves_the_reviewer_unchanged` | `under_review`, claimed by REVIEWER | OTHER_COORD approves, then read the row | `reviewing_coordinator_id` still REVIEWER; all decision fields null |

---

## AC2 — only from an eligible state

The happy path is `under_review`. Every other status is a refusal whose message
names the request's current status. All refusals are enforced through
`canTransition`, not a local status comparison.

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC2_decides_a_request_under_review` | `under_review`, claimed by REVIEWER | REVIEWER approves | 200. Status `approved` |
| `SCRUM19_AC2_refuses_a_decision_on_a_draft` | `draft` | Coordinator approves | 409. Message names `draft`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_a_submitted_request` | `submitted`, unclaimed | Coordinator approves without claiming | 409. Message names `submitted`. Row unchanged. *(`approved` is unreachable from `submitted`; the request must be claimed first.)* |
| `SCRUM19_AC2_refuses_a_decision_on_a_request_awaiting_clarification` | `pending_clarification` | REVIEWER approves | 409. Message names `pending_clarification`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_an_already_approved_request` | `approved`, decision recorded | REVIEWER rejects | 409. Message names `approved`. Original decision intact |
| `SCRUM19_AC2_refuses_a_decision_on_an_already_rejected_request` | `rejected`, decision recorded | REVIEWER approves | 409. Message names `rejected`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_a_request_in_planning` | `planning`, decision `approved` recorded | REVIEWER rejects | 409. Message names `planning`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_a_confirmed_request` | `confirmed`, decision recorded | REVIEWER rejects | 409. Message names `confirmed`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_a_completed_request` | `completed`, decision recorded | REVIEWER rejects | 409. Message names `completed`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_an_undecided_cancelled_request` | `cancelled`, all decision fields null (cancelled from `draft` or `submitted`) | REVIEWER approves | 409. Message names `cancelled`. Row unchanged |
| `SCRUM19_AC2_refuses_a_decision_on_a_cancelled_request_that_was_approved` | `cancelled`, decision `approved` still recorded (cancelled after approval — legal under `010`) | REVIEWER rejects | 409. Message names `cancelled`. Original decision intact |
| `SCRUM19_AC2_refuses_a_decision_on_a_request_that_does_not_exist` | No row with that id | REVIEWER approves | 404 `NotFoundError` |

---

## AC3 — the coordinator can see the requirements before deciding

**Known gap.** `GET /api/event-requests/:id` currently calls
`getEventRequestForOrganiser`, which throws `NotFoundError` when the caller is not
the organiser — so a coordinator reading someone else's request gets 404 today.
The coordinator UI works around this by passing the queue row through router
state, which is adequate for a read-only panel but not for a decision: the row may
be stale, and a page refresh has nothing to render.

**A coordinator-scoped single read is required.** It follows the pattern
`listEventRequestsForReview` already established — no `assertOrganiser`; the role
gate on the route is the proof. Owner: SCRUM-109.

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC3_the_reviewing_coordinator_can_read_the_request_in_full` | `under_review`, claimed by REVIEWER | REVIEWER reads the request | 200. Every requirement field as submitted — purpose, description, proposed start and end, expected attendance, venue / accessibility / equipment requirements |
| `SCRUM19_AC3_a_coordinator_can_read_a_submitted_request_before_claiming_it` | `submitted`, unclaimed | Coordinator reads it | 200. Full request returned, so the queue can be triaged before claiming |
| `SCRUM19_AC3_an_unrelated_organiser_still_cannot_read_it` | Any status | OTHER_ORG reads it | 404, indistinguishable from a request that does not exist, so ids cannot be enumerated |

---

## AC4 — a rejection needs a reason, an approval does not

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC4_rejects_with_a_reason` | `under_review`, claimed by REVIEWER | Reject with `decisionNote: "Venue capacity cannot meet the expected attendance."` | 200. Status `rejected`; `decision_note` holds the reason |
| `SCRUM19_AC4_refuses_a_rejection_with_no_reason` | As above | Reject with no `decisionNote` | 400 `ValidationError`, `details` names `decisionNote`. Row unchanged |
| `SCRUM19_AC4_refuses_a_rejection_with_a_blank_reason` | As above | Reject with `decisionNote: "   "` | 400 `ValidationError` naming `decisionNote`. Row unchanged |
| `SCRUM19_AC4_approves_with_a_note` | As above | Approve with a note | 200. Status `approved`; `decision_note` holds the note |
| `SCRUM19_AC4_approves_without_a_note` | As above | Approve with no `decisionNote` | 200. Status `approved`; `decision_note` is null |
| `SCRUM19_AC4_normalises_a_blank_note_on_approval_to_null` | As above | Approve with `decisionNote: "   "` | 200. `decision_note` is null, not an empty string — an unanswered note is absent, matching `005`'s reasoning for the requirement columns |
| `SCRUM19_AC4_trims_a_padded_reason` | As above | Reject with `decisionNote: "  Too short notice.  "` | 200. Stored note is trimmed |
| `SCRUM19_AC4_refuses_an_unrecognised_decision_value` | As above | `decision: "maybe"` | 400 `ValidationError` naming `decision`. Row unchanged |
| `SCRUM19_AC4_refuses_a_missing_decision_value` | As above | No `decision` key | 400 `ValidationError` naming `decision`. Row unchanged |
| `SCRUM19_AC4_refuses_a_decision_that_is_not_a_string` | As above | `decision: 123`, then `decision: null`, then `decision: ["approved"]` | 400 in each case, naming `decision`. Strict about type, matching `checkCapacity`, which refuses `"40"` rather than coercing it |
| `SCRUM19_AC4_refuses_a_decision_note_that_is_not_a_string` | As above | `decisionNote: 42` | 400 `ValidationError` naming `decisionNote` |
| `SCRUM19_AC4_refuses_input_that_is_not_an_object` | As above | Body is `null`, an array, or a string | 400 `ValidationError`, `details` empty — there is no form to enumerate faults against, matching `validateCreateVenue` |

---

## AC5 — the status transition

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC5_approving_sets_the_status_to_approved` | `under_review`, claimed by REVIEWER | Approve | Stored `status` is `approved` |
| `SCRUM19_AC5_rejecting_sets_the_status_to_rejected` | As above | Reject with a reason | Stored `status` is `rejected` |
| `SCRUM19_AC5_the_transition_is_checked_against_the_status_machine` | As above | Approve | The service consults `canTransition` rather than testing `status === 'under_review'` locally, so the rule has one definition |
| `SCRUM19_AC5_updated_at_advances_but_created_at_does_not` | As above | Approve, then re-read | `updated_at` has moved (trigger from `001`); `created_at` and `submitted_at` unchanged |

---

## AC6 — downstream planning eligibility

A reusable guard — proposed: `assertPlanningEligible(status)`, exported from
`src/domain/eventRequestStatus.js` beside `canTransition`, since it is a pure
rule about a status and imports nothing. Throws `ConflictError` naming the status
when the event is not eligible.

**It has no callers yet** — Venue Booking Request and Equipment Request Management
are not built. The guard is written and unit-tested now, and wired when those
features land, as SCRUM-124's own description anticipates.

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC6_permits_planning_work_against_an_approved_event` | Status `approved` | Call the guard | Passes; no error |
| `SCRUM19_AC6_refuses_planning_work_against_a_rejected_event` | Status `rejected` | Call the guard | `ConflictError` naming `rejected` |
| `SCRUM19_AC6_refuses_planning_work_against_each_undecided_status` | Status is each of `draft`, `submitted`, `under_review`, `pending_clarification` | Call the guard | Refused in every case, each message naming its status |
| `SCRUM19_AC6_refuses_planning_work_against_a_cancelled_event` | Status `cancelled` | Call the guard | Refused |
| `SCRUM19_AC6_permits_planning_work_against_statuses_beyond_approved` | Status is each of `planning`, `confirmed` | Call the guard | Passes — an event already in planning has been approved |
| `SCRUM19_AC6_refuses_planning_work_against_a_completed_event` | Status `completed` | Call the guard | Refused. Narrow reading — see open question 3; the event has happened, so a new booking request is not merely ineligible but meaningless |
| `SCRUM19_AC6_refuses_an_unrecognised_status` | Status `"not_a_status"` | Call the guard | Refused rather than throwing, matching `canTransition`'s `Object.hasOwn` guard |

---

## AC7 — the decision record is complete and immutable

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC7_records_all_four_decision_fields_together` | `under_review`, claimed by REVIEWER | Approve with a note | `decision`, `decision_note`, `decided_by` and `decided_at` populated in the same write; `decided_by` equals `reviewing_coordinator_id` |
| `SCRUM19_AC7_records_the_decision_time_from_the_injected_clock` | As above | Approve with a fixed `now` | `decided_at` equals the injected instant, not the database clock — the service sets it, not a trigger |
| `SCRUM19_AC7_a_refused_attempt_writes_no_partial_record` | As above | Reject with no reason (refused at validation) | All four decision fields remain null. Validation runs before any network call, so nothing is written and rolled back |
| `SCRUM19_AC7_refuses_a_second_decision_on_a_decided_request` | `approved`, decision recorded | REVIEWER approves again with a different note | 409. Original `decision`, `decision_note`, `decided_by` and `decided_at` all unchanged |
| `SCRUM19_AC7_refuses_an_edit_to_a_recorded_decision` | `approved`, decision recorded | Send decision fields through the ordinary update path | Refused. The column allow-list drops them, so the body matches nothing — the fields are not merely absent from the UI |
| `SCRUM19_AC7_a_concurrent_second_decision_is_refused` | `under_review`, claimed by REVIEWER; the guarded write matches no row because a decision already landed | REVIEWER approves | 409 `ConflictError` stating the request is no longer under review. Same guarded-write pattern as `submitEventRequest` |
| `SCRUM19_AC7_immutability_is_enforced_by_the_service_not_the_database` | `approved`, decision recorded | Update `decision_note` by direct database write, bypassing the service | **Succeeds.** Documents the boundary honestly: a `CHECK` sees only the row being written, never the row it replaces, so immutability cannot be a constraint. The service is the only thing enforcing AC7 |

---

## AC8 — the organiser sees the outcome

**Blocked on SCRUM-121.** No service read currently returns the decision fields —
see the dependency note above. These cases are written now and become executable
once `COLUMNS` and `toEventRequest` are extended.

| Case ID | Preconditions | Action | Expected result |
|---|---|---|---|
| `SCRUM19_AC8_the_organiser_sees_an_approval_and_its_note` | `approved`, note recorded | ORGANISER reads their request | 200. Response carries `decision`, `decisionNote` and `decidedAt` |
| `SCRUM19_AC8_the_organiser_sees_a_rejection_and_its_reason` | `rejected`, reason recorded | ORGANISER reads their request | 200. Response carries the reason |
| `SCRUM19_AC8_an_undecided_request_carries_no_decision` | `submitted` | ORGANISER reads their request | 200. Decision fields null; nothing implies a decision has been made |
| `SCRUM19_AC8_another_organiser_cannot_see_the_outcome` | `rejected` | OTHER_ORG reads it | 404, indistinguishable from a missing request |
| `SCRUM19_AC8_the_organiser_does_not_see_who_handled_the_request` | `rejected` | ORGANISER reads their request | Neither `decidedBy` nor `reviewingCoordinatorId` is exposed. Narrow reading — see open question 4; AC8 names the outcome and the reason, not the coordinator's identity |

---

## Database constraints — a second line of defence

Migration `010` enforces **five** rules at the database level. Every case above is
refused by an application guard *before* any write reaches the database, so none
of them exercises a constraint. These cases exist to prove the constraints
themselves, by writing directly to the table and bypassing the service — the same
approach `check-event-request-service.js` already takes to prove `005`'s
constraint, which it demonstrates by catching error `23514` and asserting that the
message names the constraint.

Each case below writes directly with the Supabase client and expects `23514`
(check-constraint violation) with the named constraint in the message.

| Case ID | Constraint | Direct write attempted |
|---|---|---|
| `SCRUM19_DB1_a_decided_status_cannot_lack_a_decision` | `event_requests_decided_status_has_decision` | Set `status = 'approved'` leaving all decision fields null |
| `SCRUM19_DB2_a_decision_cannot_precede_a_decided_status` | `event_requests_decision_has_decided_status` | Set `decision`, `decided_by` and `decided_at` on a row still `submitted` |
| `SCRUM19_DB3_a_rejection_cannot_lack_a_reason` | `event_requests_rejection_has_reason` | Set `status = 'rejected'`, `decision = 'rejected'`, `decided_by`, `decided_at`, `decision_note = null` |
| `SCRUM19_DB4_a_rejection_reason_cannot_be_blank` | `event_requests_rejection_has_reason` | As above with `decision_note = '   '` |
| `SCRUM19_DB5_only_the_reviewer_can_be_recorded_as_deciding` | `event_requests_decided_by_is_reviewer` | Set `decided_by` to a user who is not `reviewing_coordinator_id` |
| `SCRUM19_DB6_a_decision_cannot_exist_with_no_reviewer` | `event_requests_decided_by_is_reviewer` | Set `decided_by` while `reviewing_coordinator_id` is null. Catches the null-comparison hole the constraint uses `is not distinct from` to close |
| `SCRUM19_DB7_a_decision_record_cannot_be_partial` | `event_requests_decision_fields_together` | Set `decision` without `decided_by` or `decided_at` |

**The `cancelled` asymmetry is deliberate and should be tested, not assumed.**
`decided_status_has_decision` excludes `cancelled`; `decision_has_decided_status`
includes it. `cancelled` is the only status reachable both with a decision and
without one — a draft can be cancelled having never been decided, and an approved
event can be cancelled while keeping its approval on record. Two positive cases
pin it:

| Case ID | Direct write attempted | Expected |
|---|---|---|
| `SCRUM19_DB8_a_cancelled_request_may_carry_no_decision` | `status = 'cancelled'`, all decision fields null | Accepted |
| `SCRUM19_DB9_a_cancelled_request_may_keep_an_earlier_approval` | `status = 'cancelled'` with `decision = 'approved'` and its fields | Accepted |

Worth stating in the Q&A: the application layer returns a useful message; the
database makes the bad state unstorable regardless of which code path wrote it.
These nine cases are what turn that from an assertion into a demonstration.

---

## Open questions for the customer

1. **Can a claim be released?** A coordinator who starts a review and becomes
   unavailable currently blocks that request indefinitely. Whether a claim should
   expire, be handed over, or be broken by another coordinator is a process
   question. Out of scope for this story; nothing is guessed.
2. **Should a claimed request leave the shared queue?** `COORDINATOR_QUEUE_STATUSES`
   includes `under_review`, so a request stays visible to every coordinator after
   someone claims it. That may be correct (visibility) or wrong (duplicated
   effort).
3. **Does the planning guard permit work against `completed`?** AC6 names only
   `approved` and `rejected`. `planning` and `confirmed` clearly follow an
   approval; `completed` is taken here as ineligible, since the event has already
   happened.
4. **Does the organiser see who handled their request?** AC8 names the outcome and
   the reason. The narrow reading, taken here, is that both `decidedBy` and
   `reviewingCoordinatorId` are internal.

---

## Criteria that cannot be fully tested as written

- **AC3** — as originally written, this criterion also required the clarification
  history exchanged with the Event Organiser. That half is split to its own story;
  no message model exists, so no case can be written for it. The narrowed criterion
  above is fully testable.
- **AC6** — the guard is testable in isolation, but the criterion's real subject
  ("venue booking requests and equipment requests can be raised…") cannot be tested
  end to end, because neither feature exists. The wiring is explicitly deferred in
  SCRUM-124's description. This is a known partial, not an omission.
- **AC7's immutability** — cannot be enforced by a check constraint, which sees
  only the row being written and not the row it replaces. It is enforced in the
  service layer (SCRUM-121) by guarding the write on the row still being
  undecided, in the same way `submitEventRequest` guards on the row still being a
  draft. `SCRUM19_AC7_immutability_is_enforced_by_the_service_not_the_database`
  documents that boundary rather than hiding it.

---

## Case ownership

Cases in this document are implemented across three subtasks:

| Cases | Subtask |
|---|---|
| Claim cases in AC1; all AC3 cases | SCRUM-109 |
| AC1 decision cases, AC2, AC4, AC5, AC7, and DB1–DB9 | SCRUM-121 and SCRUM-134 |
| AC6 guard cases | SCRUM-124 |
| AC8 cases | SCRUM-133, once SCRUM-121 has extended the service read |