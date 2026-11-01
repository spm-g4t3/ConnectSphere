# SCRUM-444 — Test Cases

**Story:** Restrict Coordinator Actions to the Assigned Coordinator — Event Coordinator
**Subtasks:** SCRUM-445 (the reads), SCRUM-446, SCRUM-447, SCRUM-450 and SCRUM-451 (the access matrix), SCRUM-448 (reassign is Lead-only)
**Schema:** `055_reassign_lead_only.sql` restates the baseline's `reassign_event_request` (`backend/db/baseline/02_event_requests.sql:660`) with the Lead as the only caller. Every other action is checked by its existing function, unchanged.
**Written:** 2 November 2026, before the tests and the code.
**Marked:** 2 November 2026, round 2: AC1-13 (GET /:id refuses a malformed id with 400) and AC1-14 (a non-holder's 404 echoes the id as typed); AC3-06 now a 400. Both proved.
**Marked:** 2 November 2026: every case proved, and AC2-09 recorded (no code to guard). AC2-01's clarification request is 40001 in SQL, not 42501 (see the row); the Changed by design table lists every test of the old rule.

This document is the written layer between SCRUM-444's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**. The decisions D1 to D5 are the brief's, taken
with Calven on 1 November 2026.

---

## How case IDs relate to test names

Each case has a short stable ID (`AC2-03`) and an **Implemented by** column naming
the test that proves it. New tests are named `SCRUM444_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**. A parametrised test is one case, with its row count in
brackets.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum444AccessMatrixDatabase.test.js` | Every AC2 action as a coordinator who does not hold the event, the handover, reassign and closing notes, on the full schema; statuses reached through the real workflow functions |
| route | `backend/tests/routes/scrum444CoordinatorReadsRoutes.test.js` (fake client) | Each read for the holder, the Lead, another coordinator, the previous holder, other roles and a missing id; the reassign gate; `GET /coordinators` gone |
| rule | `backend/tests/services/scrum444CoordinatorReadRule.test.js` | `assertCoordinatorMayRead`, and the queue's missing caller, without a database |
| service | `backend/tests/services/eventRequestService.test.js` | The queue's filter, statuses, order and arity (renamed `SCRUM45_…` tests) |
| renamed | the files in "Changed by design" below | Tests of the old rule, renamed `SCRUM444_…` and flipped, never loosened |
| existing | the files cited per case | Reads and actions that already allowed only the holder; cited, unchanged |

---

## The story

> As an Event Coordinator, I want only the coordinator assigned to an event to be
> able to act on it, so that responsibility for each event stays clear.

### Acceptance criteria (Jira, as edited 1 November 2026, in substance)

1. An Event Coordinator can view only the events assigned to them, including their
   clarification history. The Event Coordinator Lead can view every event
   (SCRUM-487). Week 9 Q&A: "The co-ordinator will have access to his own assigned
   events."
2. Only the assigned coordinator can start review, request clarification, approve
   or reject, reject an approved event, edit event information, apply a significant
   change, process change requests, submit for the safety check (SCRUM-489),
   confirm, cancel, mark completed, release a venue booking (SCRUM-492), and manage
   equipment lines, venue booking requests and on-site support assignments.
3. Only the Event Coordinator Lead can assign and reassign a coordinator
   (SCRUM-486). A coordinator cannot reassign their own events (Week 9 Q&A).
4. After a reassignment, the previous coordinator can no longer view or act on the
   event.
5. Only coordinators can add closing notes on completed events.
6. A refused attempt leaves all data unchanged.

### Decisions (1 November 2026)

- **D1.** A coordinator reads only the events they hold; the Lead reads all. Anyone
  else gets 404, worded like a missing event: a 403 on a read would confirm the
  event exists (SCRUM-434).
- **D2.** After a handover the previous coordinator is a non-holder like any other.
  No view-only grant.
- **D3.** `GET /queue` is narrowed to the caller's own events.
- **D4.** Reassign is Lead-only. This reverses SCRUM-486 AC6 ("the holder may hand
  over"); by the Week 7 guide that is scenario 2: SCRUM-486 stays Done and SCRUM-444
  carries the change.
- **D5.** `GET /coordinators` and `listCoordinators` are removed. Their only caller
  was the holder's reassign picker; the Lead's picker reads
  `GET /coordinator-workload` (SCRUM-519).

---

## Case tables

The six reads are `GET /:id/review`, `GET /:id/assignments/review`,
`GET /:id/readiness`, `GET /:id/change-requests/review`,
`GET /api/event-requests/:id/equipment` and `GET /:id/clarification-history`.

Every refusal in the pglite file goes through a snapshot of the event row, its
status, clarification, decision and assignment histories, its change requests and
change history, its bookings, its equipment requests and lines, and every
notification, compared before and after (AC6).

### AC1 — a coordinator reads only the events they hold; the Lead reads all

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC1-01 | An Approved event held by the caller | The holder makes each of the six reads | 200 | (route) `SCRUM444_AC1_the_holder_reads_%s` (six) |
| AC1-02 | The same, held by someone else | The Lead makes each of the six reads | 200 | (route) `SCRUM444_AC1_the_lead_reads_%s` (six) |
| AC1-03 **(trap)** | The same, held by someone else | Another Event Coordinator makes each of the six reads | 404, the body exactly a missing id's for that read; nothing past the event read is queried | (route) `SCRUM444_AC1_another_coordinator_gets_the_missing_ids_404_on_%s` (six); (renamed) `SCRUM444_AC1_only_the_holder_reads_an_event_in_%s_and_another_coordinator_gets_404` (two), `SCRUM444_AC1_a_coordinator_who_does_not_hold_it_is_refused_the_history_and_its_notes` |
| AC1-04 | No event with that id | The holder makes each of the six reads | 404, `{ error: "Event request <id> not found" }`: the reference body for AC1-03 and AC4-01 | (route) `SCRUM444_AC1_a_missing_id_is_404_on_%s` (six) |
| AC1-05 | An Approved event | The Organiser, Venue Staff, Technical Support Staff, a Safety Officer and an Attendee make each of the six reads | As before 444: 403 from the role gate, with no query, on the five gated reads; on the clarification history the owner 200 and anyone else a missing id's 404 | (route) `SCRUM444_AC1_other_roles_are_answered_on_%s_as_before` (six) |
| AC1-06 **(trap)** | A draft | The Lead and a coordinator named on it make each of the six reads; its Organiser reads its clarification history | 404 for both, as a missing id; the Organiser 200 | (route) `SCRUM444_AC1_a_draft_is_404_on_%s` (six), `SCRUM444_AC1_the_organiser_still_reads_their_drafts_clarification_history` |
| AC1-07 | Two events in the queue's statuses, one held by the caller and one by another coordinator | `GET /queue` | Only the caller's event; the statuses, the order (oldest submission first) and the row shape as before | (pglite) `SCRUM444_AC1_the_queue_lists_only_the_callers_events`; (service, renamed) `SCRUM444_AC1_the_queue_is_filtered_to_the_caller_with_the_same_statuses_and_order`, `SCRUM444_AC1_the_queue_takes_the_caller_and_no_organiser`; (route) `SCRUM444_AC1_the_queue_route_passes_the_caller`, (renamed) `SCRUM444_AC1_the_queue_returns_the_callers_requests_across_organisers` |
| AC1-08 | — | `listEventRequestsForReview` with no caller (undefined, null, empty, blank) | 400 before any query: unfiltered, it would list every coordinator's events | (rule) `SCRUM444_AC1_the_queue_refuses_a_missing_caller_before_any_query` |
| AC1-09 | — | `assertCoordinatorMayRead` for the Lead, the holder, another coordinator, a coordinator on an event nobody holds (with and without an id), the holder's id with another role, every other role and no role | The Lead and the holder pass; everyone else gets `NotFoundError("Event request <id> not found")`, a missing id's error | (rule) `SCRUM444_AC1_the_lead_may_read_any_event`, `SCRUM444_AC1_the_holder_may_read_their_event`, `SCRUM444_AC1_%s_is_refused_with_the_missing_ids_error` (nine); (service, renamed) `SCRUM444_AC1_the_read_compares_no_coordinator_and_the_rule_refuses_a_non_holder` |
| AC1-10 **(trap)** | Submitted, assigned, with a clarification asked; and a Completed event | A coordinator who does not hold it reads its clarification history, through the real service | 404 (it was 200 before 444); the holder and the Lead still read it | (pglite, renamed) `SCRUM444_AC1_an_unassigned_coordinator_is_refused_the_clarification_history` (in `scrum434AccessMatrixDatabase.test.js`), `SCRUM444_AC1_a_coordinator_who_is_not_assigned_cannot_read_the_clarification_history`, `SCRUM444_AC1_the_clarification_history_is_unchanged_for_the_organiser_and_the_assigned_coordinator` (in `scrum379CompletedEventReadsDatabase.test.js`); (service, renamed) `SCRUM444_AC1_returns_clarification_entries_oldest_first_with_the_author_name_for_the_assigned_coordinator`, `SCRUM444_AC1_a_coordinator_who_does_not_hold_it_gets_not_found`; the existing `SCRUM434_AC6_the_assigned_coordinator_reads_…` and `SCRUM434_AC6_the_lead_reads_…`, unmodified |
| AC1-11 | Past draft | The decision and change histories, which share `requireHistoryReader` with the new rule | Unchanged: the Organiser, the holder and the Lead read them; anyone else 404 | The existing `SCRUM434_AC6_%s_history_is_answered_as_not_found` and `SCRUM434_AC6_a_draft_is_not_readable_by_any_coordinator_or_the_lead`, unmodified |
| AC1-13 | Through the API | `GET /:id`, the Organiser's read, with a malformed id | 400, `[{ field: 'id', message: 'must be a valid id' }]`, before any read (as `GET /:id/readiness`); before 444 Postgres's 22P02 made it a 500 | (route) `SCRUM444_AC1_get_by_id_refuses_a_malformed_id_with_400_before_the_read` |
| AC1-14 **(trap)** | An existing event's id typed in capitals; a missing id in capitals | A coordinator who does not hold it makes each of the six reads | 404 with the id exactly as typed, the same body as the missing id's apart from the id: Postgres finds the event in any case, and the stored lowercase id in the message would give it away | (route) `SCRUM444_AC1_a_non_holder_gets_the_id_back_as_typed_like_a_missing_event` |
| AC1-12 | — | The reads that already allowed only the holder | Cited, not changed: `GET /:id/cancellation-impact` (`event_cancellation_impact_preview`, `013:256`: the holder, or the Lead on an unassigned Submitted event); the decision and change histories (`requireHistoryReader`); the status history (`getEventRequestStatusHistory`: the Organiser or the holder); registrations and counts (`list_event_registrations`, `040:38`; `event_registration_counts`, `037:903`); flagged bookings (`list_event_flagged_bookings`, `04_venue_bookings.sql:2424`); Needs attention and `/mine` (filtered to `req.user.id`); venue suitability (`assertCheckable`, `venueSuitabilityService.js:405`). These answer a non-holder 403 or 42501, not D1's 404 | Existing, unchanged |

### AC2 — only the assigned coordinator acts

Each row runs as an Event Coordinator who does not hold the event, which passes the
route's `coordinatorOnly`, so the function answers. Each is 42501 and changes
nothing (AC6), except the clarification request (AC2-01). Each also has a control
row: the holder takes the same action from the same state and succeeds, so every
refusal is about the caller, not the state.

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC2-01 **(trap)** | Assigned (Submitted); Under review; Pending clarification | Start the review; request clarification; close a clarification; approve; reject | 42501 each, nothing changes; but requesting clarification is **40001** in SQL: `request_event_clarification_with_fields` (`011:524`) has no caller check of its own, only `change_event_request_status`'s expected-coordinator guard (`baseline/02_event_requests.sql:305`). Over HTTP a non-holder gets `requestEventClarification`'s 403 first | (pglite) `SCRUM444_AC2_another_coordinator_cannot_%s_and_nothing_changes` and `SCRUM444_AC2_the_holder_can_%s_from_the_same_state`: start_review, request_clarification, close_clarification, approve, reject |
| AC2-02 | Approved | Reject the approved event (SCRUM-347) | 42501; nothing changes | The same: reject_approved |
| AC2-03 | Under review; Approved | Edit the event's information (387); apply a significant change (395) | 42501 each; nothing changes | The same: edit_details, significant_change |
| AC2-04 | Approved, with an outstanding change request | Process the change request | 42501; nothing changes | The same: process_change_request |
| AC2-05 | Approved with an approved booking; Safety approved | Submit for the safety check (SCRUM-489); confirm | 42501 each; nothing changes | The same: submit_safety_review, confirm |
| AC2-06 | Approved; Confirmed and ended | Cancel; mark completed | 42501 each; nothing changes | The same: cancel, complete |
| AC2-07 | Approved, with an approved booking, a pending one, or a venue | Release the booking (SCRUM-492); request a venue; withdraw the pending request | 42501 each; nothing changes | The same: release_booking, request_venue, withdraw_venue_request |
| AC2-08 | Approved, with an equipment line | Add, amend and remove a line | 42501 each; nothing changes | The same: add_equipment_line, amend_equipment_line, remove_equipment_line |
| AC2-09 | — | Manage on-site support assignments | Nothing to guard: dev has no route, function or table for them. `git grep -n -i "on-site\|onsite\|on_site\|support_assignment\|support assignment" -- backend/src backend/db frontend/src` finds only `backend/src/domain/finalEvent.js:6` (a comment listing what a final event refuses) and `frontend/src/components/EventCancellationPanel.jsx:86` ("not yet available") | Recorded; no test |

The two `it.each` above have 19 rows each (AC2-01 to AC2-08 together).

### AC3 — only the Lead assigns and reassigns

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC3-01 **(trap)** | Under review, held by the caller | The holder reassigns it | 42501, "only the Event Coordinator Lead can hand over event request …"; nothing changes. Over HTTP, `leadOnly`'s 403 before the function | (pglite) `SCRUM444_AC3_the_holder_is_refused_reassign_with_42501_and_nothing_changes`; (renamed) `SCRUM444_AC3_the_holder_cannot_reassign`, `SCRUM444_AC3_the_holder_is_refused_the_handover_with_403_and_queries_nothing` |
| AC3-02 | The same | A null caller; another coordinator; the Organiser, Venue Staff, a Safety Officer and an Attendee reassign it | 42501 each, before any other check; nothing changes | (pglite) `SCRUM444_AC3_%s_is_refused_reassign_with_42501` (six); the existing `SCRUM486_AC6_refuses_%s_as_the_caller_and_writes_nothing`, unmodified |
| AC3-03 | The same | The Lead reassigns it | The new holder set; one handover row naming the Lead and the note; both notices naming the previous holder, as before | (pglite) `SCRUM444_AC3_the_lead_reassigns`; the existing `SCRUM486_AC6_a_lead_who_does_not_hold_the_event_reassigns_it`, unmodified |
| AC3-04 | — | 055 run twice; the function's signature, grants and source | One overload, still not executable by `anon` or `authenticated`; the body live runs is 055's, and against the baseline's it differs only in the caller check (the status list, the new-holder checks, the history and the notices byte-for-byte) | (pglite) `SCRUM444_AC3_055_is_rerunnable_and_keeps_one_overload`, `SCRUM444_AC3_055_changes_only_the_callers_check` |
| AC3-05 | Through the API | A coordinator posts `/:id/reassign`; the Lead does; the function refuses the Lead's call with 42501 | The coordinator 403 from `leadOnly`, nothing queried; the Lead reaches the function, as the caller; the function's 42501 is a 403 with its message | (route) `SCRUM444_AC3_a_coordinator_is_refused_reassign_with_403_and_queries_nothing`, `SCRUM444_AC3_the_lead_reaches_reassign`; (renamed) `SCRUM444_AC3_a_coordinator_is_refused_the_handover_by_the_gate`, `SCRUM444_AC3_the_functions_42501_is_a_403_with_its_message` |
| AC3-06 | Through the API | `GET /coordinators` | No such route: the request falls through to `GET /:id`, which refuses the word as a malformed id with 400 (AC1-13) before reading anything, no event and no profile | (route) `SCRUM444_AC3_get_coordinators_is_gone_and_answers_400_with_no_read` |

### AC4 — after a handover the previous coordinator is a non-holder

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC4-01 **(trap)** | Handed by the Lead from A to B | A makes each of the six reads | 404, a missing id's body | (route) `SCRUM444_AC4_the_previous_holder_gets_the_missing_ids_404_on_%s` (six); (renamed) `SCRUM444_AC4_the_previous_coordinator_can_no_longer_view_the_event` |
| AC4-02 | The same | B makes each of the six reads | 200 | (route) `SCRUM444_AC4_the_new_holder_reads_%s` (six) |
| AC4-03 **(trap)** | Each AC2 state, handed by the Lead from A to B | A attempts each AC2 action | As AC2: 42501 each (the clarification request 40001); nothing changes | (pglite) `SCRUM444_AC4_after_a_handover_the_previous_holder_cannot_%s` (19) |
| AC4-04 | Handed from A to B, Under review | B approves it | Approved, decided by B | (pglite) `SCRUM444_AC4_the_new_holder_can_act`; (renamed, over HTTP) `SCRUM444_AC4_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` |
| AC4-05 | Handed from A to B, Pending clarification | A's and B's queues; A's and B's clarification-history reads, through the real services | The event leaves A's queue and joins B's; A 404, B reads it | (pglite) `SCRUM444_AC4_the_queue_and_the_clarification_history_move_with_the_event` |

### AC5 — closing notes

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC5-01 | Confirmed and ended, held by A | Another coordinator completes it with closing notes | 42501; still Confirmed, no notes written | (pglite) `SCRUM444_AC5_a_non_holder_cannot_complete_the_event_with_notes` |
| AC5-02 | The same | The holder completes it with notes | Completed with the notes (034) | (pglite) `SCRUM444_AC2_the_holder_can_%s_from_the_same_state` (complete); the existing SCRUM-379 completion cases, unmodified |
| AC5-03 | Completed, with notes | Another coordinator reads `GET /:id/review` | 404, a missing id's body: the notes are never sent; the holder still reads them | (route) `SCRUM444_AC5_a_non_holder_cannot_read_the_closing_notes`; (renamed) `SCRUM444_AC5_another_event_coordinator_is_refused_the_closing_notes` |

### AC6 — a refused attempt leaves all data unchanged

| Case | State | Action | Expected | Implemented by |
|---|---|---|---|---|
| AC6-01 | Every AC2, AC3, AC4 and AC5 refusal in the pglite file | Snapshot before and after | Equal: the event row, its histories, change requests, bookings, equipment requests and lines, and every notification | Built into every refusal in the pglite file (`expectRefused`) |
| AC6-02 | Every read refusal | — | No write is attempted; nothing past the event read is queried | (route) AC1-03, AC1-05 and AC4-01 assert the queries made |

---

## Known gaps and accepted answers

- **The clarification request is 40001 in SQL, not 42501 (AC2-01).**
  `request_event_clarification_with_fields` (`011:524`) has no caller check of
  its own; a non-holder meets `change_event_request_status`'s expected-coordinator
  guard (`baseline/02_event_requests.sql:305`), "no longer assigned to this
  coordinator". Over HTTP the non-holder is refused first by
  `requestEventClarification`'s 403. AGENTS.md asks for the check in SQL too;
  that is a new migration, not done here.
- **403 on a write, 404 on a read.** A non-holder's read is a missing id's 404
  (D1); a non-holder's write keeps its function's refusal, 42501, a 403, as
  SCRUM-434 accepted for its actions. So a write confirms that an id exists. The
  reads that already allowed only the holder (AC1-12) answer 403 or 42501 too.
- **Three answers changed.** `GET /:id/change-requests/review` reads the event
  first, so a missing id is a 404 where it was `200 []`. The equipment read's
  missing-id message is now the coordinator read's, `Event request <id> not
  found`, where it was `Event request not found`. And the equipment of a draft
  is a 404 where any coordinator could read it.
  (Round 2 added a fourth: `GET /:id` answers a malformed id 400, where it was a 500.)
- **A flaky frontend test.** `SCRUM583_AC1_no_screen_adds_its_own_expiry_wording`
  (`frontend/tests/flows/scrum583ExpiredSessionFlow.test.jsx`) failed once in
  the full frontend run with "Target cannot be null or undefined" and passed alone
  (19 of 19). It touches no 444 code; it looks timing-dependent under load.

---

## Changed by design

Tests of the old rule, renamed `SCRUM444_…` and flipped to the new one. None is
loosened.

| Old name | New name | File |
|---|---|---|
| `SCRUM486_AC6_the_holder_reassigns_as_scrum327_allowed` | `SCRUM444_AC3_the_holder_cannot_reassign` | `tests/db/eventStatusLifecycleDatabase.test.js` |
| `SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` (A still read the event) | `SCRUM444_AC4_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` (A's read is a 404) | `tests/db/leadReassignmentWalkthrough.test.js` |
| `SCRUM379_AC5_the_clarification_history_is_unchanged_for_the_organiser_and_for_any_coordinator` | `SCRUM444_AC1_the_clarification_history_is_unchanged_for_the_organiser_and_the_assigned_coordinator`, plus `SCRUM444_AC1_a_coordinator_who_is_not_assigned_cannot_read_the_clarification_history` | `tests/db/scrum379CompletedEventReadsDatabase.test.js` |
| The access matrix's left-out row, "any coordinator reads the clarification history" | `SCRUM444_AC1_an_unassigned_coordinator_is_refused_the_clarification_history` | `tests/db/scrum434AccessMatrixDatabase.test.js` |
| `SCRUM379_AC2_%s_gets_closingNotes`, its "another event coordinator" row | `SCRUM444_AC5_another_event_coordinator_is_refused_the_closing_notes` | `tests/routes/scrum379CoordinatorReadsClosingNotesRoutes.test.js` |
| `SCRUM486_AC6_a_coordinator_still_reaches_it` | `SCRUM444_AC3_the_holder_is_refused_the_handover_with_403_and_queries_nothing` | `tests/routes/leadAssignmentRoutes.test.js` |
| `SCRUM486_AC6_a_coordinator_still_reads_it` | `SCRUM444_AC1_a_coordinator_who_does_not_hold_it_gets_not_found` | `tests/services/leadAssignmentService.test.js` |
| `SCRUM332_AC7_any_coordinator_can_read_an_event` | `SCRUM444_AC1_the_read_compares_no_coordinator_and_the_rule_refuses_a_non_holder` | `tests/services/eventRequestService.test.js` |
| `returns clarification entries oldest first with the author name for any Coordinator` | `SCRUM444_AC1_returns_clarification_entries_oldest_first_with_the_author_name_for_the_assigned_coordinator` | `tests/services/eventRequestService.test.js` |
| `SCRUM45_AC1_filters_on_the_three_review_statuses_and_on_a_coordinator_holding_the_request` | `SCRUM444_AC1_the_queue_is_filtered_to_the_caller_with_the_same_statuses_and_order` | `tests/services/eventRequestService.test.js` |
| `SCRUM45_AC1_takes_no_organiser_and_asserts_none` | `SCRUM444_AC1_the_queue_takes_the_caller_and_no_organiser` | `tests/services/eventRequestService.test.js` |
| `SCRUM45_AC1_returns_a_request_belonging_to_another_organiser` | `SCRUM444_AC1_the_queue_returns_the_callers_requests_across_organisers` | `tests/routes/eventRequests.test.js` |
| `SCRUM331_AC6_a_coordinator_who_does_not_hold_the_event_cannot_hand_it_over` | `SCRUM444_AC3_a_coordinator_is_refused_the_handover_by_the_gate`, plus `SCRUM444_AC3_the_functions_42501_is_a_403_with_its_message` | `tests/routes/eventRequests.test.js` |
| `SCRUM332_AC7_any_coordinator_can_read_an_event_in_%s` (two) | `SCRUM444_AC1_only_the_holder_reads_an_event_in_%s_and_another_coordinator_gets_404` (two) | `tests/routes/eventRequests.test.js` |
| `SCRUM332_AC7_the_previous_coordinator_can_still_view_the_event` | `SCRUM444_AC4_the_previous_coordinator_can_no_longer_view_the_event` | `tests/routes/eventRequests.test.js` |
| `SCRUM334_AC9_any_coordinator_sees_the_history_with_notes` | `SCRUM444_AC1_a_coordinator_who_does_not_hold_it_is_refused_the_history_and_its_notes` | `tests/routes/eventRequests.test.js` |

Removed with `GET /coordinators` and `listCoordinators` (D5): seven `SCRUM334_AC9_…`
service tests of `listCoordinators` (`eventRequestService.test.js`), five
`SCRUM334_AC9_…` route tests of `GET /coordinators` and the two
`SCRUM485_AC5_GET /coordinators_refuses_%s…` rows (`eventRequests.test.js`).

---

## Tally

39 cases, counted from the tables: **38 proved** and one recorded (AC2-09: there
is nothing to guard); 0 not yet implemented; 0 that cannot be written as
specified. Eight are traps.

| Section | Cases |
|---|---|
| AC1 | 14 |
| AC2 | 9 |
| AC3 | 6 |
| AC4 | 5 |
| AC5 | 3 |
| AC6 | 2 |
| **Total** | **39** |
