# SCRUM-489 — Test Cases

**Story:** Submit an Event for the Operational Safety Check — Event Coordinator
**Subtask:** SCRUM-554 (this document)
**Schema:** `064_safety_review_submission.sql` (SCRUM-555, SCRUM-556), after SCRUM-488's 062 and 063.
**Written:** 14 October 2026, **before the code.** Every case describes what will be built. None is implemented yet; each **Implemented by** says so, and the subtask that writes its tests fills it in.
**Marked:** 14 October 2026, SCRUM-555 and SCRUM-556: every case their tests prove names them. The cases themselves are unchanged.

This document is the written layer between SCRUM-489's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**, walked for a randomly chosen feature in the
Week 13 Q&A. It is also where this story's decisions are argued, with the
alternatives rejected: the code's comments say why in a line or two and point
here (AGENTS.md).

---

## How case IDs relate to test names

Each case has a short stable ID (`AC3-02`) and an **Implemented by** column naming
every test that proves it. New tests are named `SCRUM489_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum489SafetyReviewSubmissionDatabase.test.js` | What the database does: the readiness lines, the refusals and their SQLSTATEs, what is written and what is not |
| svc | `backend/tests/services/scrum489…` (fake client) | What the service refuses before the database, and how each SQLSTATE becomes an error |
| route | `backend/tests/routes/scrum489…` (fake client) | Gates, status codes, the caller from the token, query and body parameters |
| screen | `frontend/tests/components/` | What the coordinator sees (SCRUM-557) |

Which subtask writes each: SCRUM-555 (AC2, AC3's read, AC4's line), SCRUM-556 (AC1,
AC3's refusal, AC4, AC5, AC6, AC8's notice), SCRUM-557 (every screen case),
SCRUM-558 (AC7, AC8's label), SCRUM-559 (anything still open).

---

## The story

> **USER STORY:** As the assigned Event Coordinator, I want to send an event whose
> venue and equipment are arranged to the Safety Officer, so that its safety is
> checked before it is confirmed.

### Acceptance criteria

Quoted from the ticket.

1. Only the assigned coordinator can submit an event for the safety check, and
   only while it is Approved. Anyone else is refused, and so is any other status,
   with a message stating the status.
2. Submission requires all of these, using the same readiness check as SCRUM-363:
   - Venue: every venue booking the event relies on is approved, covers the
     event's current start to end, and is not flagged for review.
   - Equipment: if the event has an equipment request that is not Cancelled, its
     status is "Arranged".
   - Date: the event's start is in the future.
3. If any condition is not met, submission is refused and every outstanding item
   is listed, not just the first. Before submitting, the coordinator sees the
   checklist with each condition as met or outstanding.
4. The equipment acknowledgement in SCRUM-363 AC5 applies here too: if the
   organiser's original equipment requirements are not empty but there is no
   active equipment request, the coordinator must confirm that no equipment is
   needed.
5. The coordinator can add a note for the Safety Officer, optional, up to 2,000
   characters.
6. On submission the status becomes Safety review, and the coordinator, the date
   and time and the note are recorded in the status history (SCRUM-318).
7. While the event is in Safety review its equipment lines cannot be changed
   (SCRUM-21 AC10, reworded). A change to the event's date, time or attendance is
   a significant change and returns the event to Approved (SCRUM-395).
8. Every Safety Officer is notified when an event is submitted. The organiser sees
   the event as "Safety check" (SCRUM-173).

### Design decisions, from the ticket

- The readiness conditions are shared with Confirm. Whichever of this story and
  SCRUM-363 is built first creates the shared function. (D1.)
- A submission cannot be withdrawn. A coordinator who needs to change something
  uses a significant change, which returns the event to Approved. Team decision,
  to confirm. (D9.)

---

## Design decisions

Each is argued, with the alternative it rejects.

### D1. The readiness check is one SQL function, shared with SCRUM-363

`event_readiness(p_event_request_id, p_no_equipment_confirmed default false)`
returns the whole checklist as JSON. The checklist read (AC3) and the submit
function call the same function, so the screen and the refusal cannot disagree,
and SCRUM-363's confirm reuses it under the row locks its technical notes require
(the event, then its bookings, then its equipment request). It takes no locks of
its own; the caller locks.

*Rejected: a JavaScript check in the service.* It cannot run under the locks
SCRUM-363 requires, so a flag arriving between the check and the status change
would go unseen, and SCRUM-363 would have to repeat it.

### D2. "Every venue booking the event relies on" is every live booking

Live means pending, approved or flagged for review, the set 051 calls live. Each
is its own line, named by its venue. A pending request is outstanding ("Awaiting
approval"): a coordinator who does not need it withdraws it. No live booking at
all is one outstanding line, "No venue booking". Rejected, withdrawn and
cancelled bookings are not relied on, and an active venue hold is not a booking
(SCRUM-363's Week 7 note).

*Rejected: counting only approved bookings.* An event could then reach the Safety
Officer with a venue request still undecided, and the approval would cover a
venue nobody had agreed to.

### D3. "Covers" is per booking

A booking covers the event when `starts_at <= proposed_start` and
`ends_at >= proposed_end`. An event with no start or end cannot be covered, and
fails the date line. *Rejected: covering by the union of bookings*: AC2 says
"every venue booking", so each is checked on its own, as AGENTS.md says each
booking is checked on its own.

### D4. Equipment: every request that is not Cancelled must be Arranged

Each is its own line, with `equipment_request_status_words()` (038) as the detail,
so the words match the equipment screens ("Cannot be fully arranged"). No active
request and no organiser requirements is one met line, "No equipment requested".
*Rejected: reading only the latest request*, as `lock_equipment_request` does:
the readiness check must list every outstanding item (AC3), and a second active
request, if one ever exists, is outstanding too.

### D5. The no-equipment acknowledgement is a checklist line

Present only when `btrim(equipment_requirements)` is not empty and no active
equipment request exists; met only when the coordinator confirms. Recorded on the
submission (D7). *Rejected: a separate pre-check outside the checklist*: the
coordinator would then see "ready" and be refused anyway.

### D6. Not ready is a 409 with every outstanding line

`PT409` with hint `EVENT_NOT_READY`, and DETAIL the outstanding lines as JSON, the
convention 051's `create_booking_request` uses. The API returns `{ error, code:
'EVENT_NOT_READY', conflicts: [...] }`; the frontend keys on the status and the
code, never the message. A DETAIL that cannot be parsed becomes `conflicts: []`,
never a 500. *Rejected: one message string*: AC3 says every item, and a client
cannot list the parts of a sentence.

### D7. Each submission is recorded in an immutable `safety_review_submissions` row

The event, the coordinator, the note, whether no equipment was confirmed, and the
time; as well as in the status history, where the note is the reason (AC6). A
trigger refuses update and delete, as 030's clarification history does.
*Rejected: the history row alone*: it has no place for the acknowledgement
(SCRUM-363 AC5 says it is recorded), and it would leave SCRUM-490 parsing history
rows for the note and the submitter. SCRUM-490's `safety_review_detail` can read
`coordinatorNote` from this table.

### D8. The status moves through `change_event_request_status`

It already writes the history row, and refuses a stale status (55000) or a
coordinator who no longer holds the event (40001). SCRUM-490's 058 replaces that
function with the same signature, so it is called by argument name and works
against both. *Rejected: restating it here*: two stories would fight over one
function, and whichever ran last would silently drop the other's change.

### D9. A submission cannot be withdrawn

The ticket's design decision, team to confirm. There is no route back from Safety
review in this story: only the Safety Officer's response (SCRUM-490) or a
significant change (SCRUM-395). *Rejected: a withdraw action*: it is not in the
story, and SCRUM-488's transition table has no withdrawal row.

### D10. AC7's second half belongs to SCRUM-395

Today `process_change_request` (006, 019) applies an approved change to the date,
time or attendance whatever the event's status, so an event in Safety review keeps
its status after one. Returning it to Approved is SCRUM-395's. Until it is built,
**AC7 is partial**, and this story does not change `process_change_request`.

### D11. Every Safety Officer is notified

`event_submitted_for_safety_review`, an insert from a select over `profiles.role =
'safety_officer'`, as 052 notifies every Lead. With no Safety Officer the
submission still succeeds and the event waits in the queue. The payload is
`{ eventRequestId, eventName, coordinatorId, coordinatorName, startsAt,
submittedAt }`, without the note: the Safety Officer reads it on the review
screen. *Rejected: notifying only one Safety Officer*: AC8 says every one, and
there is no assignment of Safety Officers to events.

### D12. Equipment is locked during Safety review

`docs/requirements.md` §9 says lines can be added or removed any time before
confirmation [C4]. AC7 rewords SCRUM-21 AC10 on purpose: equipment is a
significant-change field [C4], the Safety Officer reviews the arranged equipment
(W7 #6, "equipment placement"), and a line changed under review would make the
approval cover equipment nobody checked. The way to change it is a significant
change, which returns the event to Approved (SCRUM-395). Already enforced by
`assert_equipment_editable` (052); proved in SCRUM-558.

### D13. The note is optional

As AC5 says, although W7 #6 lists equipment placement and crowd movement, and
SCRUM-490 AC3 says the note is where they are described. Open question 2.

### D14. An event in Safety review cannot be cancelled yet

`cancel_event_request` (048) and the `CANCELLABLE_STATUSES` lists in
`CoordinatorRequestDetail.jsx` and `EventCancellationPanel.jsx` leave out both
safety statuses, though SCRUM-488 made the moves legal. Once this story can put an
event in Safety review, its coordinator loses Cancel there. Cancellation is
SCRUM-370's; nothing is changed here. Open question 3.

### D15. Built on SCRUM-488's working assumptions

Two statuses, the gate before Confirmed, the send-back to Approved, the labels,
no rejection from a safety status (`docs/SCRUM-488-decisions.md`). This story adds
no enum value. If the team moves the gate after Confirmed, only the from-status in
`submit_event_for_safety_review` and the readiness call change.

---

## Case tables

### AC1 — only the assigned coordinator, only while Approved

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | Approved, held by A, ready | A submits | Allowed (AC6's cases say what is written) | Proved (pglite): `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once` |
| AC1-02 **(trap)** | Approved, held by A, ready | B, another coordinator, submits | 42501 "Only the event's assigned coordinator can submit it for the safety check"; nothing written | Proved (pglite): `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written` (another coordinator) |
| AC1-03 **(trap)** | The same | A Lead, an Organiser, a Safety Officer submit | 403 from the route's `coordinatorOnly`, nothing queried; and 42501 from the function for anyone not the holder | Proved (route): `SCRUM489_AC1_%s_is_refused_the_submission_with_403_and_queries_nothing`; (pglite) `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written` (a Lead, the organiser, a Safety Officer) |
| AC1-04 **(trap)** | Held by A, in each status but Approved: draft, submitted, under review, pending clarification, safety review, safety approved, confirmed, completed, rejected, cancelled | A submits | 55000, the message naming the status in words ("… It is Safety review."); a second submit is refused this way | Proved (pglite): `SCRUM489_AC1_an_event_that_is_%s_is_refused_naming_its_status`, `SCRUM489_AC1_a_second_submission_is_refused_as_safety_review`; (svc) `SCRUM489_AC1_the_functions_%s_arrives_as_its_status` |
| AC1-05 | — | A null caller; a null event id | 42501 for the caller (refused as not the holder); 22004 for the event | Proved (pglite): `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written`, `SCRUM489_AC1_a_null_event_is_refused_with_22004` |
| AC1-06 **(trap)** | After every refusal in AC1-02 to AC1-05 and AC3-01 | Read the event, its history, the submissions and the notifications | Unchanged: no status change, no history row, no submission row, no notification | Proved (pglite): `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written`, `SCRUM489_AC1_an_event_that_is_%s_is_refused_naming_its_status`, `SCRUM489_AC5_a_note_over_2000_characters_is_refused_with_22023`, `SCRUM489_AC3_the_readiness_read_changes_nothing_and_lists_what_the_refusal_lists` |
| AC1-07 | No token | `POST /:id/safety-review` | 401, nothing queried | Proved (route): `SCRUM489_AC1_the_submission_answers_401_without_a_token` |
| AC1-08 **(trap)** | A coordinator | `POST /:id/safety-review` with `coordinatorId` in the body | The caller is the token's user; the body's id is ignored | Proved (route): `SCRUM489_AC1_the_caller_is_the_tokens_user_not_the_bodys` |
| AC1-09 | A coordinator | `POST /:id/safety-review` with an id that is not a uuid | 400, no rpc | Proved (route): `SCRUM489_AC1_an_id_that_is_not_a_uuid_is_400_and_queries_nothing`; (svc) `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc` |

### AC2 — the readiness conditions

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | One approved booking covering the event | `event_readiness` | One venue line, met, "Approved", with its booking id and venue name | Proved (pglite): `SCRUM489_AC2_an_approved_covering_booking_no_equipment_and_a_future_start_is_ready` |
| AC2-02 **(trap)** | One pending booking | `event_readiness` | Outstanding, "Awaiting approval" | Proved (pglite): `SCRUM489_AC2_a_%s_booking_is_outstanding` (pending) |
| AC2-03 **(trap)** | One flagged booking | `event_readiness` | Outstanding, "Flagged for review" | Proved (pglite): `SCRUM489_AC2_a_%s_booking_is_outstanding` (flagged_for_review) |
| AC2-04 **(trap)** | One approved booking whose time no longer covers the event's start to end | `event_readiness` | Outstanding, "Does not cover the event's start to end" | Proved (pglite): `SCRUM489_AC2_an_approved_booking_that_no_longer_covers_the_event_is_outstanding` |
| AC2-05 **(trap)** | Two venues: one approved and covering, one pending | `event_readiness` | Two venue lines, one met and one outstanding, each with its venue | Proved (pglite): `SCRUM489_AC2_two_venues_each_a_line_one_met_one_outstanding` |
| AC2-06 | No live booking | `event_readiness` | One outstanding line, "No venue booking" | Proved (pglite): `SCRUM489_AC2_no_live_booking_is_one_outstanding_line_and_dead_bookings_are_not_relied_on` |
| AC2-07 | Rejected, withdrawn and cancelled bookings beside one approved covering one | `event_readiness` | Only the approved one is a line | Proved (pglite): `SCRUM489_AC2_no_live_booking_is_one_outstanding_line_and_dead_bookings_are_not_relied_on` |
| AC2-08 **(trap)** | An equipment request Arranged; another event's request "Cannot be fully arranged" | `event_readiness` for each | Met, "Arranged"; outstanding, "Cannot be fully arranged" | Proved (pglite): `SCRUM489_AC2_an_equipment_request_%s_is_met_only_when_arranged` |
| AC2-09 **(trap)** | A cancelled equipment request, and no requirements | `event_readiness` | The cancelled request is not a line; one met line, "No equipment requested" | Proved (pglite): `SCRUM489_AC2_a_cancelled_equipment_request_is_ignored`, `SCRUM489_AC2_an_approved_covering_booking_no_equipment_and_a_future_start_is_ready` |
| AC2-10 | The start has passed; no start; no end | `event_readiness` | The date line outstanding: "The event's start has passed", "The event has no start date", "The event has no end date" | Proved (pglite): `SCRUM489_AC2_the_date_is_outstanding_when_%s`, `SCRUM489_AC2_the_date_is_outstanding_with_no_end` |
| AC2-11 | Everything met | `event_readiness` | `ready` true; the lines in a fixed order: venue (by start, then id), equipment, acknowledgement, date | Proved (pglite): `SCRUM489_AC2_an_approved_covering_booking_no_equipment_and_a_future_start_is_ready`, `SCRUM489_AC2_two_venues_each_a_line_one_met_one_outstanding` |
| AC2-12 | — | `event_readiness` for an unknown id | P0002 | Proved (pglite): `SCRUM489_AC2_an_unknown_event_is_not_found`; (svc) `SCRUM489_AC2_an_unknown_event_is_a_404` |
| AC2-13 | An active venue hold, and no booking | `event_readiness` | The hold is not a booking: "No venue booking" | Proved (pglite): `SCRUM489_AC2_no_live_booking_is_one_outstanding_line_and_dead_bookings_are_not_relied_on`, with an active hold on a stand-in `venue_holds` |

### AC3 — every outstanding item listed; the checklist before submitting

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 **(trap)** | A pending booking, an equipment request "Cannot be fully arranged", and a past start | A submits | Refused PT409, hint `EVENT_NOT_READY`, DETAIL listing all three outstanding lines, not just the first | Proved (pglite): `SCRUM489_AC3_three_outstanding_items_are_all_listed_in_the_refusal` |
| AC3-02 | The refusal of AC3-01 | The service | 409 `ConflictError`, `code: 'EVENT_NOT_READY'`, `conflicts` the outstanding lines | Proved (svc): `SCRUM489_AC3_not_ready_is_a_409_with_every_outstanding_line`; (route) `SCRUM489_AC3_not_ready_arrives_as_a_409_with_its_code_and_every_outstanding_line` |
| AC3-03 **(trap)** | A PT409 `EVENT_NOT_READY` whose DETAIL is not JSON | The service | 409 with `conflicts: []`, never a 500 | Proved (svc): `SCRUM489_AC3_a_detail_that_is_%s_is_still_a_409_with_no_conflicts` |
| AC3-04 | A coordinator or a Lead | `GET /:id/readiness` | 200, the whole checklist | Proved (route): `SCRUM489_AC3_%s_reads_the_checklist`; (svc) `SCRUM489_AC3_the_checklist_is_one_rpc_of_event_readiness` |
| AC3-05 **(trap)** | — | `event_readiness` twice | Read-only: nothing changes; and its outstanding lines are exactly the ones the refusal lists | Proved (pglite): `SCRUM489_AC3_the_readiness_read_changes_nothing_and_lists_what_the_refusal_lists` |
| AC3-06 | — | `?noEquipmentConfirmed=true`, `=false`, absent; anything else | Sent as true, false, false; anything else 400, no rpc | Proved (route): `SCRUM489_AC3_%j_reads_with_no_equipment_confirmed_%s`, `SCRUM489_AC3_%s_is_400_and_queries_nothing` |
| AC3-07 | An Organiser, a Safety Officer; no token; a non-uuid id | `GET /:id/readiness` | 403; 401; 400, no rpc | Proved (route): `SCRUM489_AC3_%s_is_refused_the_checklist_with_403_and_queries_nothing`, `SCRUM489_AC3_the_checklist_answers_401_without_a_token`, `SCRUM489_AC3_an_id_that_is_not_a_uuid_is_400_and_queries_nothing`; (svc) `SCRUM489_AC3_%s_is_refused_with_400_before_any_rpc` |
| AC3-08 **(trap)** | — | `GET /:id/readiness` | Not read as an id, and declared with the other `/:id/…` reads | Proved (route): `SCRUM489_AC3_%s_reads_the_checklist`, `SCRUM489_AC3_a_draft_is_answered_as_not_found` |
| AC3-09 | An event with met and outstanding lines | Open the submission panel | Each line shown as met or outstanding, with its detail | **not yet implemented** (SCRUM-557) |

### AC4 — the no-equipment acknowledgement

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 **(trap)** | Requirements not empty, no active equipment request | `event_readiness`, unconfirmed; then A submits | The acknowledgement line is present and outstanding; the submission is refused and lists it | Proved (pglite): `SCRUM489_AC4_requirements_with_no_active_request_need_a_confirmation_and_unconfirmed_are_refused` |
| AC4-02 | The same | A submits, confirming no equipment is needed | Allowed; the submission row records `no_equipment_confirmed` true | Proved (pglite): `SCRUM489_AC4_confirmed_it_submits_and_the_acknowledgement_is_recorded` |
| AC4-03 **(trap)** | Requirements only whitespace | `event_readiness` | No acknowledgement line | Proved (pglite): `SCRUM489_AC4_whitespace_requirements_or_an_active_request_need_no_confirmation` |
| AC4-04 | Requirements not empty, an active equipment request | `event_readiness` | No acknowledgement line; the request's own line decides | Proved (pglite): `SCRUM489_AC4_whitespace_requirements_or_an_active_request_need_no_confirmation` |
| AC4-05 | No acknowledgement line | A submits with `noEquipmentConfirmed` true | Allowed; `no_equipment_confirmed` stored false (nothing was acknowledged) | Proved (pglite): `SCRUM489_AC4_a_confirmation_with_nothing_to_confirm_is_stored_false` |
| AC4-06 | — | The service with a non-boolean `noEquipmentConfirmed` | 400, no rpc | Proved (svc): `SCRUM489_AC3_%s_is_refused_with_400_before_any_rpc`, `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc`; (route) `SCRUM489_AC5_%s_is_400_and_queries_nothing` |
| AC4-07 | The acknowledgement line present | Open the panel | A confirmation the coordinator must tick | **not yet implemented** (SCRUM-557) |

### AC5 — the note for the Safety Officer

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 **(trap)** | Ready | A submits a note of exactly 2,000 characters | Accepted, stored whole | Proved (pglite): `SCRUM489_AC5_a_note_that_is_%s_is_stored_as_it_should_be`; (svc) `SCRUM489_AC5_a_note_of_exactly_2000_characters_is_sent` |
| AC5-02 **(trap)** | Ready | A note of 2,001 characters | 400 from the service, no rpc; 22023 from the function | Proved (pglite): `SCRUM489_AC5_a_note_over_2000_characters_is_refused_with_22023`; (svc) `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc`; (route) `SCRUM489_AC5_%s_is_400_and_queries_nothing` |
| AC5-03 **(trap)** | Ready | An empty or whitespace-only note; no note | Stored as no note (null), in the submission and the history | Proved (pglite): `SCRUM489_AC5_a_note_that_is_%s_is_stored_as_it_should_be`; (svc) `SCRUM489_AC5_a_note_that_is_%s_is_sent_as_null` |
| AC5-04 | Ready | A note with surrounding spaces | Stored trimmed | Proved (pglite): `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once`; (svc) `SCRUM489_AC6_a_submission_is_one_rpc_with_the_caller_the_trimmed_note_and_the_confirmation` |
| AC5-05 | — | The service with a note that is not a string | 400, no rpc | Proved (svc): `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc` |
| AC5-06 | — | Type in the panel | A note box, optional, with a 2,000-character limit | **not yet implemented** (SCRUM-557) |

### AC6 — what a submission records

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 **(trap)** | Ready | A submits with a note | Status `safety_review`; one history row `approved → safety_review`, `changed_by` A, `reason` the note, a time | Proved (pglite): `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once` |
| AC6-02 | The same | — | One `safety_review_submissions` row: the event, A, the note, the acknowledgement, a time | Proved (pglite): `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once` |
| AC6-03 **(trap)** | A submission row | Update it; delete it | Both refused; the row unchanged | Proved (pglite): `SCRUM489_AC6_a_submission_row_cannot_be_changed_or_deleted` |
| AC6-04 | Ready | `POST /:id/safety-review` | 200 with the updated event, shaped as the other action routes return it (`statusDisplay` included) | Proved (route): `SCRUM489_AC6_the_holder_submits_and_gets_the_event_in_safety_review`; (svc) `SCRUM489_AC6_a_submission_is_one_rpc_with_the_caller_the_trimmed_note_and_the_confirmation` |
| AC6-05 **(trap)** | 064 applied | Apply it again | No error; one constraint, one trigger, one function of each signature | Proved (pglite): `SCRUM489_AC6_064_is_safe_to_run_twice` |

### AC7 — equipment locked during Safety review; a significant change returns to Approved

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | In Safety review | A adds, amends or removes an equipment line | 55000 "… only be changed as a significant change" (052's guard, D12) | **not yet implemented** (SCRUM-558) |
| AC7-02 | In Safety review | An approved change request moves the date, time or attendance | The event returns to Approved | **Cannot be tested as written** (D10): `process_change_request` keeps the status today; SCRUM-395 builds this |

### AC8 — the Safety Officers are told; the organiser sees "Safety check"

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 **(trap)** | Two Safety Officers, a Lead, another coordinator | A submits | One `event_submitted_for_safety_review` notice to each Safety Officer, none to anyone else; the payload of D11, without the note | Proved (pglite): `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once` |
| AC8-02 | No Safety Officer | A submits | Allowed; no notice | Proved (pglite): `SCRUM489_AC8_with_no_safety_officer_it_still_submits_and_notifies_nobody` |
| AC8-03 | 064 applied | Read `notifications_type_known` | Fifteen types: 052's eleven, SCRUM-490's three, and this story's one | Proved (pglite): `SCRUM489_AC8_the_type_list_keeps_every_earlier_type_and_adds_this_storys` |
| AC8-04 | In Safety review | The organiser's list | "Safety check" (SCRUM-488's label) | **not yet implemented** (SCRUM-558) |
| AC8-05 | A notice of this type | A Safety Officer opens their notifications | Shown, in words | **Cannot be tested as written**: see below |

---

## Open questions

1. **A submission cannot be withdrawn (D9).** The ticket's decision, team to
   confirm.
2. **Should the note be required (D13)?** AC5 says optional; W7 #6 and SCRUM-490
   AC3 suggest the Safety Officer needs it. Team decision.
3. **Cancelling an event in Safety review (D14).** `cancel_event_request` and the
   two `CANCELLABLE_STATUSES` lists leave out both safety statuses. A fix for
   SCRUM-370's owner; its ticket key is to be given by Calven.
4. **AC7's second half (D10).** Partial until SCRUM-395.
5. **The gate's position (D15).** SCRUM-488's working assumption, awaiting the
   team.

---

## What cannot be tested as written

- **The flag-versus-submit race.** A booking flagged at the moment a submission
  runs should wait on the submission's `for share` lock and be seen by the next
  readiness check. PGlite is one connection, so two transactions never overlap.
- **AC7-02** (D10): SCRUM-395's.
- **AC8-05, the Safety Officer reading the notice.** On `dev` the Safety Officer's
  dashboard (`SafetyOfficerDashboard.jsx`) has no notifications card, so a Safety
  Officer has nowhere to see one. Where a card exists, SCRUM-172's
  `describeNotification` shows a type it does not know as "New notification / This
  notification type cannot be displayed yet.", counted and markable, not hidden.
  Wording this type, and a card for the Safety Officer, are SCRUM-172's and
  SCRUM-490's.

---

## Tally

56 cases, counted from the tables: 0 proved; 54 not yet implemented (five of them,
AC3-09, AC4-07, AC5-06, AC7-01 and AC8-04, marked for SCRUM-557 or SCRUM-558); 2
that cannot be written as specified (AC7-02, AC8-05). Twenty-four are traps. After SCRUM-555 and
SCRUM-556: **49 proved**; 5 not yet implemented (AC3-09, AC4-07, AC5-06, AC7-01,
AC8-04: the screen and SCRUM-558's proofs); the same 2.

| Section | Cases |
|---|---|
| AC1 | 9 |
| AC2 | 13 |
| AC3 | 9 |
| AC4 | 7 |
| AC5 | 6 |
| AC6 | 5 |
| AC7 | 2 |
| AC8 | 5 |
