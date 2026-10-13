# SCRUM-486 — Assign and Reassign Event Coordinators from an Unassigned Queue

**Story:** Assign and Reassign Event Coordinators from an Unassigned Queue — Event Coordinator Lead
**Closing subtask:** SCRUM-523 (this document)
**Status as of 12 October 2026:** closed, with the gaps in section 4 recorded rather than hidden.

This document is the record of what SCRUM-486 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC1.

The case-by-case mapping is `docs/test-cases/SCRUM-486.md`: 91 cases, each naming
the tests that prove it or saying in bold why none does. This document cites it
rather than repeating it.

It carries one duty the earlier reviews did not. **This story reverses a decision
the team built, tested and defended in writing**: SCRUM-327's assignment on
submission. Section 5 records exactly what SCRUM-327 no longer means, every place
that still says otherwise and what was done about each, and argues why SCRUM-327
stays Done.

**The short version, for anyone asked "what changed?":** a submitted request used
to be given a coordinator by a rule in the database. Since migration 052 it is
given nobody. It waits in the Event Coordinator Lead's queue, every Lead is told,
and a Lead chooses the coordinator by hand. The holder or a Lead can hand an event
on afterwards.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-514 | The 71 test cases, written before any code, then corrected after the audit of SCRUM-491 (venue holds) | `4cafa0b`, `f3efae6` |
| SCRUM-515 | 052 begun: the relaxed constraint, submission that assigns nobody, two null-caller guards; P0001 → 503 removed from `translateError` | `52b3532` |
| SCRUM-516 | 052: `assign_event_request`, and `reassign_event_request` opened to the Lead | `8e90cf8` |
| SCRUM-517 | 052: start-review and decision refuse a request waiting for the Lead, in words that name the Lead; the screen's 409 message | `8f2b825` |
| SCRUM-518 | 052: the three notification types and their writers; 052 complete | `934c0ab` |
| SCRUM-519 | The Lead's queue, the assignment picker, the reassign route's gate, the Lead's nav link, route and notifications | `406f91c` |
| SCRUM-520 | The Organiser's "waiting" line; unassigned requests out of the coordinators' shared queue | `0f5ce9b` |
| SCRUM-521 | The Lead reassigns from an event's own screen, reached by its address | `15158ab` |
| SCRUM-522 | The remaining tests; the live scripts and the tests SCRUM-327 pinned repaired; the backend's worker cap; every case marked | `757e1a4` |
| SCRUM-523 | This document; stale test names and superseded statements corrected in the docs and comments | — |

### Verification as of 12 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm test` in `backend`) | 4918 tests passing across 95 files, three consecutive runs (section 4, the worker cap) |
| Frontend suite (`npm test` in `frontend`) | 2115 passing and 1 todo across 88 files; every coverage gate met; SCRUM-486's four gated files (`UnassignedQueue.jsx`, `AssignCoordinatorPanel.jsx`, `waitingTime.js`, `EventRequestReviewPage.jsx`) at 100% |
| SCRUM-486's own tests | 201 distinct `SCRUM486_…` titles: 101 backend, 100 frontend (describe titles included; a parametrised test counts once). Older tests this story moved are not counted here; each records in a comment why it was right when written, and the case document's "Existing tests this story must change" says where each of its rows went |
| PGlite | Three suites build a real Postgres with 052: `eventStatusLifecycleDatabase`, `eventClarificationDatabase`, `venueHoldExpiryAfterLeadAssignmentDatabase`; a fourth, `leadReassignmentWalkthrough`, runs the real router and services over it |
| Live database | **052 applied to the shared project, and all three live scripts run on 12 October.** First run: every behaviour check passed in all three, including `assignment:check`'s five rounds of the real AC4 race, but `assignment:check`'s cleanup failed and `routes:check` failed one stale label check (section 4, "Live scripts"). After the fixes: `assignment:check` passed every check but the table-count one, which failed only because another user created three events in the shared project during the run; its by-id check found nothing of the run left, and every other table returned to its starting count. `routes:check` passed 69 of 69 and left nothing. `request:check` passed clean on the first run, notifications back to their starting count, and was not rerun |
| `assignment:check`'s table counts | On `d298ffc`'s run its whole-table count check failed: event_requests 16 → 19, because another writer added three events mid-run ("[TEST] Hack Night", "[TEST] Competing Event", "[TEST] Mic Check", 12:32 UTC). Its by-id check showed nothing of the run was left. The count check is left as it is: on a shared database it can only warn, and the by-id check is the real proof |
| Test-case document | 91 cases: **88 proved**, **3 not** (section 4), each marked in its row. 86 are proved by named tests in CI; AC4-05 is proved live, by the live script run by hand; AC6-26, the Lead's click-through end to end, is proved by hand (13 October, section 2). The 20 added on 12 October are AC6's list of assigned events (D12, revised) |

The layers prove different things, and most of this story is in Postgres
functions. A fake client returns whatever it is given, so only PGlite proves what
052 refuses and writes; only the live scripts prove two connections taking turns
on a row lock (AC4); and the screen tests prove what each person sees.

---

## A note on the wording below

The criteria are quoted from `docs/test-cases/SCRUM-486.md`, which quotes the
ticket. **AC6 was amended in Jira on 11 October**: its first wording took the
handover away from coordinators; the customer says the Lead *can* reassign, not
that coordinators cannot. The amended text is quoted. This document was written
without access to Jira; check the eleven criteria against the ticket before the
examination, and correct this document rather than defend it if they differ.

---

## 1. Acceptance criteria

| AC | Criterion (quoted, shortened where marked …) | Status |
|---|---|---|
| AC1 | Submitting an event request no longer assigns a coordinator. The request becomes Submitted with no coordinator, and the organiser sees that it is waiting for one. This supersedes SCRUM-327 AC1, AC2, AC3 and AC5. | **Done** |
| AC2 | Only the Lead sees the unassigned queue: every Submitted request with no coordinator, oldest first, showing the event name, the organiser, the proposed period, the expected attendance and how long it has waited. Drafts never appear. An unassigned request does not appear in the coordinators' shared review queue either … | **Done** |
| AC3 | The Lead assigns a request to one Event Coordinator, with an optional note. Only users holding the Event Coordinator role can be chosen; the Lead cannot be assigned events. The picker shows each coordinator's current number of active events … The system suggests nobody. | **Done** |
| AC4 | An assignment gives the event its coordinator and writes its history row in one step. If two assignments of the same request happen at the same moment, only one succeeds, and the other is refused and shown who was assigned. | **Done**: one step, and the refusal naming the winner, proved in CI; the true simultaneous race proved live, by the live script run by hand on 12 October (D13), not in CI |
| AC5 | An event can be reassigned … while it is Submitted, Under review, Pending clarification, Approved, Safety review, Safety approved or Confirmed … Reassigning in any other status is refused. | **Partial**: five of the seven statuses proved; Safety review and Safety approved do not exist yet |
| AC6 | Both the event's assigned coordinator and the Event Coordinator Lead can reassign it. SCRUM-327 AC6 stands rather than being superseded. (Amended 11 October.) | **Done** |
| AC7 | After a reassignment the new coordinator can carry out every coordinator action on the event, and the previous coordinator can still view it but change nothing … Open clarification requests, change requests and flagged items belong to the event … | **Done** |
| AC8 | Nobody can start the review of a request that has no coordinator. The attempt is refused with a message that the request is waiting for the Lead to assign it. | **Done** |
| AC9 | Every assignment and reassignment records the previous coordinator (none for the first), the new coordinator, who made it, the date and time, and the note. The organiser and the assigned coordinator can view this history, and the organiser still does not see the note. | **Done** |
| AC10 | The Lead is notified when a request is submitted and unassigned. The newly assigned coordinator, and the organiser with the coordinator's name, are notified when it is assigned or reassigned … | **Partial**: every notice is written and shown, but not yet in words (SCRUM-172) |
| AC11 | If no Lead exists, submission still succeeds and the request waits in the queue. This replaces the refusal in SCRUM-327 AC5. No notification is written, and nothing fails. | **Done** |

**Tally:** 9 done, 2 partial (AC5, AC10), 0 deferred. (8 done, 3 partial until the live race ran on 12 October; AC4 was the third.)

AC1 counts as done because AC1-06 is met: SCRUM-522 had reported it partly
unmet, since the Organiser's row could say a coordinator was assigned but not
who. SCRUM-523 closed it. `listEventRequestsForOrganiser` now reads the
coordinators' names in one `profiles` read for the whole list, and the row reads
"<name> has been assigned; your request is waiting for them to start the review"
(section 2).

A criterion counts as done only where a named test proves it; where the code is
right but the proof is missing, it is partial.

### Evidence for each criterion

| AC | Code (file, function) | Proved by |
|---|---|---|
| AC1 | `052` §1 `event_requests_assigned_when_submitted`; §2 `submit_event_request`; `submitEventRequest` (`eventRequestService.js`); `assignmentLine` (`MyEventRequests.jsx`); `AssignmentHistory.jsx`'s current coordinator | Section 2 |
| AC2 | `listUnassignedEventRequests`; `GET /unassigned` behind `leadOnly`; `UnassignedQueue.jsx`, `waitingTime.js`; `listEventRequestsForReview`'s `.not('assigned_coordinator_id', 'is', null)` | `SCRUM486_AC2_reads_submitted_requests_with_no_coordinator_oldest_first`, `SCRUM486_AC2_each_row_carries_name_organiser_period_attendance_and_when_it_was_submitted`, `SCRUM486_AC2_neither_queue_lists_a_draft_even_one_with_a_stale_coordinator` (service); `SCRUM486_AC2_a_lead_reads_the_unassigned_queue`, `SCRUM486_AC2_%s_refuses_%s_with_403_and_queries_nothing` (route); `SCRUM486_AC2_lists_each_request_oldest_first_with_what_the_lead_needs_to_choose`, `SCRUM486_AC2_an_empty_queue_says_nothing_is_waiting_and_invents_no_rows` (screen); `SCRUM486_AC2_the_review_queue_leaves_out_a_submitted_request_nobody_holds`, `SCRUM486_AC2_the_review_queue_still_lists_a_held_request_in_every_status_it_listed_before` (the shared queue) |
| AC3 | `052` §5 `assign_event_request`; `assignEventRequest`, `listCoordinatorWorkload`; `POST /:id/assign`, `GET /coordinator-workload` behind `leadOnly`; `AssignCoordinatorPanel.jsx` | `SCRUM486_AC3_a_lead_assigns_an_unassigned_submitted_request`, `SCRUM486_AC3_refuses_%s_as_the_assignee_and_writes_nothing`, `SCRUM486_AC3_refuses_%s_as_the_caller_and_writes_nothing` (PGlite); `SCRUM486_AC3_lists_every_event_coordinator_with_their_active_count`, `SCRUM486_AC3_ordered_by_name_never_by_workload` (service); `SCRUM486_AC3_nothing_is_chosen_for_the_lead_and_nothing_is_recommended` (screen) |
| AC4 | `assign_event_request`: `for update`, then one statement writing the coordinator and the history row; `readHolder` in `assignEventRequest` (`ALREADY_ASSIGNED`) | `SCRUM486_AC4_the_coordinator_and_its_history_row_stand_or_fall_together`, `SCRUM486_AC4_refuses_a_second_assignment_and_names_who_got_there_first`, `SCRUM486_AC4_of_two_leads_assigning_at_once_exactly_one_wins_and_the_other_is_told_who` (PGlite); `SCRUM486_AC4_a_lost_race_is_a_409_that_names_who_holds_it` (service); `SCRUM486_AC4_a_lost_race_names_who_was_assigned_and_offers_only_the_way_back` (screen). The real race: `check-coordinator-assignment.js` section 2, **run live twice on 12 October**, one winner and a named refusal in every round (the live script, not CI) |
| AC5 | `052` §6 `reassign_event_request`'s status list, compared as text | `SCRUM486_AC5_a_lead_reassigns_a_request_that_is_%s`, `SCRUM486_AC5_refuses_to_reassign_a_request_that_is_%s_and_writes_nothing`, `SCRUM486_AC5_an_unassigned_request_is_assigned_not_reassigned` (PGlite); `SCRUM486_AC5_the_status_list_names_the_safety_statuses_before_they_exist` pins the two names only |
| AC6 | `reassign_event_request`'s caller check; `coordinatorOrLead` on `POST /:id/reassign` and the event screen's three reads; `canReassign` (`CoordinatorRequestDetail.jsx`); `EventRequestReviewPage.jsx` at `/event-requests/:eventRequestId`; the way there: `listAssignedEventsForLead`, `GET /assigned` behind `leadOnly`, `AssignedEvents.jsx` at `/assigned-events` and its nav link (D12) | `SCRUM486_AC6_the_holder_reassigns_as_scrum327_allowed`, `SCRUM486_AC6_a_lead_who_does_not_hold_the_event_reassigns_it`, `SCRUM486_AC6_refuses_%s_as_the_caller_and_writes_nothing` (PGlite); `SCRUM486_AC6_a_lead_reaches_the_handover_function` (route); `SCRUM486_AC6_a_lead_sees_the_hand_over_action_on_an_event_they_do_not_hold`, `SCRUM486_AC6_for_a_lead_the_holder_is_left_out_not_the_caller` (screen); `SCRUM486_AC6_the_assigned_list_holds_a_held_event_in_each_active_status`, `SCRUM486_AC6_the_assigned_list_names_the_coordinator_and_the_organiser_from_one_profiles_read` (service); `SCRUM486_AC6_a_lead_reads_every_held_event_with_both_names_and_its_status_display`, `SCRUM486_AC6_does_not_read_the_assigned_path_as_a_request_id` (route); `SCRUM486_AC6_open_links_to_the_events_page_and_goes_there` (screen) |
| AC7 | No new code: every function that acts on an event checks its `assigned_coordinator_id` when it runs | `SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` (real router over PGlite); `SCRUM486_AC7_the_new_coordinator_reviews_and_decides_and_the_previous_one_cannot`, `SCRUM486_AC7_the_coordinator_the_lead_hands_it_to_asks_for_clarification_and_the_previous_one_cannot`, `SCRUM486_AC7_an_open_clarification_follows_the_event_to_its_new_coordinator`, `SCRUM486_AC7_a_pending_change_request_follows_the_event_to_its_new_coordinator` (PGlite); `SCRUM486_AC7_the_new_coordinator_lists_the_booking_and_the_previous_one_does_not` (service) |
| AC8 | `052` §7: `start_event_review` and `decide_event_request`, one check each before the caller check; `requestEventClarification`'s same check; `CoordinatorRequestDetail.jsx`'s waiting text and 409 entry | `SCRUM486_AC8_starting_the_review_of_an_unassigned_request_is_refused_naming_the_lead_for_%s`, `SCRUM486_AC8_deciding_an_unassigned_request_is_refused_naming_the_lead` (PGlite); `SCRUM486_AC8_%s_is_a_409_with_the_functions_message`, `SCRUM486_AC8_asking_for_clarification_on_an_unassigned_request_names_the_lead` (service); `SCRUM486_AC8_an_unassigned_request_opened_by_%s_says_it_is_waiting_for_the_lead` (screen) |
| AC9 | The history row each of 052's functions writes, `assigned_by` the caller; `listAssignmentHistory`'s `automatic`; `AssignmentHistory.jsx` | `SCRUM486_AC9_reads_correctly_across_a_submission_an_assignment_and_two_reassignments` (PGlite); `SCRUM486_AC9_an_old_row_reads_automatic_and_a_leads_row_names_the_lead` (service); `SCRUM486_AC9_the_organisers_route_has_both_rows_and_no_note_on_either`, `SCRUM486_AC9_the_coordinators_route_has_both_rows_with_the_note` (route); `SCRUM486_AC9_an_old_automatic_row_and_a_leads_row_read_differently_in_one_history` (screen) |
| AC10 | `052` §1b `notifications_type_known` (eleven types: 048's eight and this story's three) and `notifications.event_request_id`, set on every notice; the inserts in §2, §5, §6; `CoordinatorNotifications` on `EventCoordinatorLeadDashboard.jsx` | `SCRUM486_AC10_submission_tells_every_lead_a_request_is_waiting`, `SCRUM486_AC10_an_assignment_tells_the_coordinator_and_the_organiser_by_name`, `SCRUM486_AC10_a_reassignment_tells_the_new_coordinator_and_the_organiser_who_held_it`, `SCRUM486_AC10_a_refused_assignment_notifies_nobody_when_%s`, `SCRUM486_AC10_052_keeps_every_type_048_allows_and_adds_three`, `SCRUM486_AC10_a_lapsed_hold_still_expires_and_is_notified_after_052` (PGlite); `SCRUM486_AC10_each_new_type_is_shown_as_a_notification_that_cannot_be_displayed_yet` (screen: shown, counted, markable, **not worded**) |
| AC11 | `submit_event_request`'s Lead notice is an insert from a select; no P0001 path | `SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists` (PGlite); `SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503` (service) |

---

## 2. Traceability: AC1, end to end

**Criterion:** "Submitting an event request no longer assigns a coordinator. The
request becomes Submitted with no coordinator, and the organiser sees that it is
waiting for one. This supersedes SCRUM-327 AC1, AC2, AC3 and AC5."

**Why this one.** It crosses every layer: a CHECK constraint, a Postgres function,
a service, a route, two screens and the status display. And it reverses a
decision the team had defended in writing (`docs/SCRUM-327.md`, D1, D2 and D5), so
it is also the criterion where "why did your tests change?" is asked.

**What it reverses.** Before 052, `submit_event_request` (016, redefined by 021)
called `pick_event_coordinator` (015), set the coordinator in the same update as
the status, wrote an assignment-history row with `assigned_by` null ("the
system"), and raised P0001 "No coordinator is available" when nobody qualified.
017's constraint made the database refuse a submitted row with no coordinator.
Every one of those is undone, and nothing else.

**Test cases, layer by layer**

| Layer | Case | Test | Proves |
|---|---|---|---|
| Constraint | TR-01 | `SCRUM486_TR01_accepts_a_submitted_request_with_no_coordinator`, `SCRUM486_TR01_still_refuses_a_request_that_is_%s_with_no_coordinator`, `SCRUM486_TR01_still_accepts_a_request_that_is_%s_with_no_coordinator` | Submitted may have no coordinator; under review, pending clarification, approved and confirmed still may not (23514); draft and cancelled as before |
| Function | AC1-01 | `SCRUM486_AC1_submits_with_no_coordinator_even_when_coordinators_exist` | Two coordinators exist, and none is chosen: `submitted`, no coordinator, no reviewer, one status-history row, no assignment-history row |
| Function | AC1-02 | `SCRUM486_AC1_the_submission_function_in_force_does_not_call_pick_event_coordinator` | The function's own source, read from `pg_proc`, never names the selection rule |
| Function | TR-02 | `SCRUM486_TR02_a_resubmitted_request_reaches_the_queue_with_no_coordinator_and_no_reviewer` | A request reopened from rejected, which 022 leaves holding its old coordinator, is submitted with none (D2) |
| Function | AC10-01, AC11-01 | `SCRUM486_AC10_submission_tells_every_lead_a_request_is_waiting`, `SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists` | Every Lead is told; with no Lead and no coordinator at all, submission still succeeds and writes no notice |
| Migration text | TR-07 | `draftToSubmittedSinglePath.test.js`, `eventStatusHistoryMigration.test.js` | The only writers of `status = 'submitted'` and of the status history now include 052 |
| Service | AC1-03 | `SCRUM330_AC1_submits_through_one_call_that_names_no_coordinator`, `SCRUM330_AC1_returns_the_submitted_request_in_camelCase_with_no_coordinator`, `SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503` | One read, one rpc, the same three arguments; `assignedCoordinatorId` comes back as a present `null`; no 503 path |
| Route | AC1-04 | `SCRUM10_AC5_returns_200_and_the_submitted_request` | 200, the caller from the token as `p_changed_by`, and `assignedCoordinatorId: null` in the body |
| Screen | AC1-05 | `SCRUM486_AC1_a_submitted_request_with_no_coordinator_says_it_is_waiting_for_the_lead`, `SCRUM486_AC1_the_two_are_visibly_different_on_rows_that_share_a_status` | On the row itself, not behind a click: "Waiting for the Event Coordinator Lead to assign a coordinator to your request." |
| Service | AC1-06 | `SCRUM486_AC1_each_held_row_carries_its_coordinators_name_from_one_read`, `SCRUM486_AC1_no_coordinator_on_any_row_means_no_second_read` | The Organiser's list carries `assignedCoordinatorName`, from one profiles read narrowed to the list's coordinators, skipped when no row has one |
| Screen | AC1-06 | `SCRUM486_AC1_a_submitted_request_names_the_coordinator_it_was_assigned_to` | Once assigned, the row names who: "Priya Nair has been assigned; your request is waiting for them to start the review." |
| Screen | TR-03 | `SCRUM486_TR03_a_resubmitted_request_waiting_for_the_lead_reads_not_assigned` | The history beside it says "Not assigned yet", although its newest row names the old coordinator |
| Live | — | `check-event-request-service.js` step 4; `check-event-request-routes.js`, the queue section; `check-coordinator-assignment.js` section 1 | The same against Supabase. **Run on 12 October**, passing (section 4, "Live scripts") |

**Production code, top to bottom**

1. **The constraint** (`052` §1). `event_requests_assigned_when_submitted` is
   dropped and re-added as `status in ('draft', 'submitted', 'cancelled') or
   assigned_coordinator_id is not null`. Every row 017's version accepted, this
   one accepts, so it cannot fail on existing data. It comes first in the file,
   before the function that relies on it (D1).
2. **The function** (`052` §2, `submit_event_request`). Refuses a null time or a
   null submitter (22004); locks the row `for update`; refuses anything but a
   draft (55000); then one `update` sets `status = 'submitted'`, `submitted_at`,
   **`assigned_coordinator_id = null` and `reviewing_coordinator_id = null`**
   (D2); one status-history row, draft → submitted; and one insert from a select
   of every Lead, which writes the Leads' notices (D7). Same three arguments as
   021, so the service did not have to change to call it.
3. **The service** (`submitEventRequest`, `eventRequestService.js`). Reads the
   draft, validates it with every gap listed at once, then one
   `rpc('submit_event_request', { p_event_request_id, p_submitted_at,
   p_changed_by })`. `translateError` no longer has a P0001 → 503 branch: nothing
   this module calls raises it any more.
4. **The route** (`POST /api/event-requests/:id/submit`). The Organiser ownership
   pre-check (`getEventRequestForOrganiser`, 404 for someone else's), then the
   service with `changedBy: req.user.id`; the response carries `statusDisplay`.
5. **The status display** (`getStatusDisplay`, `domain/eventRequestStatus.js`).
   **Unchanged**, on purpose: "Requested", "Received by ConnectSphere and waiting
   to be picked up by a Coordinator", true whether or not anyone is assigned (D8).
6. **Screen one** (`MyEventRequests.jsx`, `assignmentLine`). For a submitted
   request only, a line under the status: no coordinator, "Waiting for the Event
   Coordinator Lead to assign a coordinator to your request."; one assigned,
   "<name> has been assigned; your request is waiting for them to start the
   review." Derived from `assignedCoordinatorId`, which every read carries, and
   `assignedCoordinatorName`, which `listEventRequestsForOrganiser` reads in one
   `profiles` read for the whole list (the two-read pattern of the Lead's queue;
   skipped when no row has a coordinator). A coordinator with no name on record
   reads "A coordinator has been assigned; …".
7. **Screen two** (`AssignmentHistory.jsx`, in the Organiser's "Your coordinator
   and assignment history"). "Current coordinator" comes from the request's own
   `assignedCoordinatorId`, passed in by the parent, not from the newest history
   row, which after a resubmission names someone who no longer holds it (TR-03).

**What the reversal cost in tests.** Eight older tests pinned the rule AC1
removes. Each was right when written, was moved rather than deleted, and records
why in a comment: `SCRUM325_assigns_exactly_one_coordinator_…`,
`SCRUM325_refuses_the_submission_when_no_coordinator_exists_…`,
`SCRUM318_lets_the_reopened_draft_be_submitted_again_…` and
`SCRUM325_refuses_a_second_submission_…` in PGlite (SCRUM-515); the three
`SCRUM330_AC1_…` service tests and `SCRUM10_AC5_returns_200_and_the_submitted_request`
(SCRUM-522). Section 5 lists them with what each now proves.

**Manual verification.** Two runs by hand, both by Calven, both against the
shared Supabase project with 052 applied, both passed.

*AC1 walkthrough, 12 October, on the branch at `6035664`.*

| Check | Seen | Case |
|---|---|---|
| 1 | A submitted request's row says "Waiting for the Event Coordinator Lead to assign a coordinator to your request." | AC1-05 |
| 2 | The Lead got a notification, shown as "cannot be displayed yet" (the wording is SCRUM-172's) | AC10-01; AC10-06 stays unmet |
| 3 | The request is in the Unassigned Queue with organiser, dates, attendance and waiting time | AC2-07 |
| 4 | Nothing pre-selected in the picker; coordinators only | AC3-07, AC3-06 |
| 5 | After "Confirm assignment" it left the queue | AC3-01, AC2-01 |
| 6 | The Organiser's row then named the coordinator ("<name> has been assigned; your request is waiting for them to start the review.") | AC1-06 |

It also showed a gap: the Lead could reassign only an event whose address they
typed. D12 (revised) closes it.

*Lead click-through, 13 October, on `5260207`.*

| Check | Seen | Case |
|---|---|---|
| A | The Lead's nav shows Dashboard, Unassigned Queue, Assigned Events | AC6-24, AC6-25 |
| B | The held request is listed with coordinator, organiser, badge and start date; no unassigned or cancelled rows | AC6-17, AC6-08 |
| C | Open shows the event page with "Hand over to another coordinator" and no review or decide actions | AC6-19, AC6-05 |
| D | After "Confirm handover" the page shows the new coordinator, and the newest history row names the Lead with the note | AC6-02, AC9-02 |
| E | Assigned Events shows the new coordinator | AC6-26 |
| F | The Organiser's My Events row names the new coordinator | AC1-06 |

A to F together are AC6-26, the click-through end to end, which no test covers
(the PGlite walkthrough's adapter cannot run a list read); it is proved by this
run. Every other case above was already proved by a test, and its row now says
it was also seen by hand.

**Likely follow-ups.** "Why not just stop setting the coordinator?" (D2). "Why one
migration, when 016 and 017 were split?" (D1). "Why not change the status label?"
(D8). "Why did SCRUM-327's tests change if SCRUM-327 was right?" (section 5). "How
does the row know the coordinator's name?" One `profiles` read for the whole list,
narrowed to its coordinators: SCRUM-334 left the name behind a click to avoid one
read per row, and one read per list costs neither.

---

## 3. Design decisions

Each is stated as the argument, because that is what will be asked for. 052's
header carries most of them in full; these are the versions to give aloud.

### D1. The constraint and the submission function changed in one migration, against the 016/017 precedent

SCRUM-327 split them (016 the function, 017 the constraint) because the
constraint had to wait for the old code to stop: the old service submitted with
a plain update that set no coordinator, so a constraint requiring one, applied
early, would have failed every submission. Here the dependency runs the other
way. The new function writes a submitted row with **no** coordinator, which 017's
constraint refuses. Applied first, on its own, it would fail every submission
with 23514. So the constraint is relaxed first and the function replaced second,
**in one file**, which the SQL Editor runs as one transaction: there is no moment
at which the two disagree, on the one shared database the team develops and
demos against. The service needed no change because the function kept 021's
three arguments. Same reasoning as 016/017 (no window of broken submissions),
opposite conclusion, because the order of the dependency is reversed.

The constraint is relaxed for `submitted` **only**. Under review and every later
status still require a coordinator, because only the assigned coordinator can
move a request there.

### D2. Submission clears the coordinator, rather than merely not setting it

Deleting the assignment from `submit_event_request` would not deliver AC1. 022
(SCRUM-318) reopens a rejected request to a draft and **leaves its coordinator on
it**: 017 allowed a draft to carry one, and 022's header says "submit_event_request
chooses again on resubmission". A function that simply stopped writing the column
would hand the resubmitted request straight back to its old coordinator, past
the Lead. So 052 sets `assigned_coordinator_id = null` explicitly. It clears
`reviewing_coordinator_id` too, which 022 also leaves behind: a stale reviewer
names someone no longer responsible, and would make 029 refuse the new
coordinator's decision. That closes SCRUM-19's open question 5. TR-02 pins both,
showing the stale values first.

### D3. The first assignment is its own function

018's update is guarded `and assigned_coordinator_id = p_assigned_by`. On a first
assignment the column is null, `null = x` matches no row, and the assignment would
fail as a 40001 "changed hands". The alternative weighed was one function for
both jobs, with the guard rewritten as `is not distinct from` against the
outgoing coordinator. Not taken, because the two jobs differ in everything but the
history row: **who** (only a Lead assigns; the holder or a Lead reassigns),
**what must be true** (no coordinator and Submitted, against a coordinator and one
of seven statuses), and **what a refusal says** (AC4's "already assigned to X",
against "changed hands"). One function would branch on whether a holder exists,
and a reassignment aimed at an event whose holder had just gone would silently
become a first assignment instead of being refused. Two functions keep each rule
set readable on its own, at the cost of one repeated role check.

The requirement that the request have **no** coordinator is also what makes the
second of two simultaneous assignments fail (AC4).

### D4. Both the holder and the Lead reassign

AC6 was amended on 11 October: the customer says the Lead *can* reassign, not that
coordinators can no longer. So SCRUM-327 AC6 stands, and 052 widens
`reassign_event_request`'s caller check to "the holder, or anyone holding
`event_coordinator_lead`", looked up under `for share`. Its guarded update now
compares with the outgoing coordinator read under the lock (`v_outgoing`), not
with the caller: a Lead is not the holder, and the guard's job was never "the
caller holds it" but "nobody moved it in between".

The same widening then had to happen one layer up, three times, each found by
following the Lead's path rather than the database's: the route gate
(`coordinatorOnly` refused the Lead before the function could say yes; SCRUM-519),
the event screen's reads (`GET /:id/review` refused the Lead the screen a handover
is made from, and so did the history, change-request, clarification and equipment
reads it makes on mount; SCRUM-521), and the picker's filter (it left out
the caller, which for a Lead removed nobody and offered the holder, a choice the
function refuses; SCRUM-521).

### D5. The Lead cannot be assigned events

The customer describes supervision: the Lead "should be able to view all
coordinator assignments and active events under their supervision". That is
oversight of a caseload, not a caseload. The team decided it on 11 October,
answering SCRUM-485's open question 3. The incoming person must hold
`event_coordinator`; one role per account (SCRUM-485 AC2) means that check alone
excludes every Lead, with no second "and not a Lead" check to forget.

### D6. The coordinators' shared review queue stays, but loses unassigned requests

The obvious question once every request in the queue belongs to somebody is why
a shared queue exists at all. The answer is a distinction the **customer** drew,
not a preference. The customer restricts what a coordinator may **manage**:
"Event Coordinators should only be able to manage events assigned to them"
(SCRUM-327 AC6, AC7). It does not restrict what they may **view**: SCRUM-444 AC1
lets any coordinator view any event. The shared queue is that viewing right as a
worklist: what colleagues have waiting, which a coordinator covering for someone,
or choosing who to hand an event to, needs. Removing it would take away something
the customer allowed in order to enforce a restriction the customer never made.

What the customer *did* reserve is the choice of who takes a new request: the
Lead's. So the only rows taken out are those that belong to nobody. Listed, they
would be rows every coordinator can open and do nothing with, since every action
on them is refused (AC8). The argument is in `listEventRequestsForReview`'s
docstring, because "why is there still a shared queue?" is the question an
examiner will ask of that code.

### D7. Where the AC10 notices are written, and why

**Inside the three functions, in the transaction that does the work**, as every
notice in this schema is (014, 026, 030, 031, 033 to 036, 040).
`notificationService.js` only reads them. So a notice cannot exist for a
submission or an assignment that was refused: every refusal raises before the
inserts, and the raise rolls them back.

**The Lead's notice is an insert from a select** of every profile holding the role,
as 014 notifies every coordinator. "The Lead" means everyone with the role, and
with nobody holding it the select is empty, so the insert writes nothing and fails
nothing: that one shape delivers AC11. A `select … into` or a single-row insert
would not.

**Three types, not one.** The coordinator is told "you have this event", with the
handover note; the Organiser is told "your request has this coordinator", without
it (AC9). One type carries one headline, and a payload is what the screen
receives, so a shared type would carry the note to the Organiser. A reassignment
reuses the same two types, with `previousCoordinatorId` set.

**The type list is restated from 048's eight, and the file is numbered after it.**
The constraint is dropped and re-added whole each time, so whichever list is
restated is the one in force, and whichever file runs second wins. Restated from
034, venue holds would silently stop expiring (or 052 would not apply);
`venueHoldExpiryAfterLeadAssignmentDatabase.test.js` demonstrates both failures.
Restated without 048's `event_cancelled`, cancellation would break the same way.

This migration was written as **041**, restating 040's seven. The merge of dev on
12 October brought SCRUM-370's 042 to 049, and 048 restates the same constraint
with `event_cancelled` and without this story's three. At 041 a fresh build would
run ours, then 048, and lose our three types, and every submission would then
fail, because `submit_event_request` writes the Lead's notice in its own
transaction. The live database, where 048 had already run, would have been fine:
broken only on a fresh build, the worst shape the bug takes. So the file is now
**052**, restating 048's eight plus our three, and both orders agree.

The lesson is about the technique this story leans on. **The live database was
ahead of the repository, and no test could see it**: each story's PGlite suites
apply only that story's migrations, so two stories that restate one shared
constraint each pass every test and still break each other. A PGlite suite proves
what a set of files does together, not what happens with files it was never
given, or in the order a live database actually received them.

Since 048 added `notifications.event_request_id`, our notices fill it too, and
keep `eventRequestId` in the payload: the column makes them queryable by event,
like cancellation's, and the payload key is the contract SCRUM-172 builds against.
048 constrains the column only for `event_cancelled`.

### D8. The Organiser's "waiting" line is separate from the status display

`STATUS_DISPLAY` is keyed on the status alone, and after this story one status,
`submitted`, covers two situations an Organiser must tell apart. The display could
have been widened to take the assignment into account. Counted before choosing:
`getStatusDisplay` has three call sites in the backend, one of which,
`withStatusDisplay`, puts it on all sixteen event-request responses, and five
frontend screens render it, three of them the coordinators'. Widening it means
every one passing the coordinator in, including `GET /:id/status`, the cheap
refetch that reads only the status, or two responses describing the same request
differently. And the assignment is not a status: 052 deliberately added none. The
shared description, "waiting to be picked up by a Coordinator", is true in both
situations, so it stays, and `MyEventRequests` adds one line that says which.

### D9. One 409 message names both causes (AC8-05)

Since 052, starting the review of a request nobody holds is refused with 55000, a
409, where it used to fall through to a misleading 42501 "only the coordinator
assigned…" (D10). On `CoordinatorRequestDetail` that 409 joins the one that
already meant "no longer waiting to be reviewed". The case document asked for the
screen to tell the two apart by the request's own `assignedCoordinatorId`. That
cannot work: the Start review button is shown only to the holder, so at click time
the field always names the person clicking. The only other way to tell them apart
is to read the server's message text, which the screen never does, because it
breaks silently the day a message is reworded. Both causes have the same remedy,
go back and reopen the request, so one message names both. This is the screen's
existing practice (`docs/SCRUM-327.md` D15). AC8-05 is recorded as **met
differently**, by this decision.

### D10. 55000 for "waiting for the Lead", not 42501; and 018's codes, not 040's

029's functions already refused a request with no coordinator, by accident: their
caller check is true when the column is null. But they said 42501, "only the
coordinator assigned … can start reviewing it", which tells the caller it is
someone else's when it is nobody's. 052 adds one check before the caller check,
raising 55000: "not in a state that allows this", which is the truth for every
caller. Before the caller, not after as 029 orders things, because 029's ordering
exists to tell a stranger nothing beyond "not yours", and here there is no "yours".

052 raises 018's and 029's standard SQLSTATEs, which `translateError` maps once,
not 040's PostgREST `PT409` with a hint. That was considered: these functions sit
beside 018 and 029, and the service should go on translating one convention.

### D11. The Lead's picker reads a list of its own, and suggests nobody

`GET /coordinators` (SCRUM-334) is every coordinator's handover list, and SCRUM-485
deliberately pinned that a Lead is refused it. Widening it would have shown every
coordinator everyone's caseload and undone that refusal. So the Lead reads
`GET /coordinator-workload`, behind `leadOnly`, with each coordinator's active
events counted (submitted through confirmed, one definition, in the service). It
is ordered by **name**, never by count, and nothing is pre-selected: a list sorted
by workload would put a recommendation at the top in all but name, which is the
automatic choice AC1 removes. The picker is radio buttons, not a select, so every
count is visible without a click.

### D12 (revised 12 October). The Lead reaches an assigned event from a list

**Before.** SCRUM-521 added a page that loads one event by its address,
`/event-requests/:eventRequestId`, rendering the existing event screen with its
hand-over action, and widened the reads that screen makes on mount. It built no
list to reach it from, on the argument that the list was SCRUM-487's coordinator
overview, and a list here would be built twice and thrown away once.

**Why it changed.** The AC1 walkthrough on 12 October showed the cost. The Lead
*can* reassign, but an assigned request leaves the Unassigned queue, and nothing
else links a Lead to the event's page; the only way there was to type its
address. A reassignment that can only be reached that way does not deliver
change 5's "reassign events where necessary", and Calven's done criterion for
this story is that a Lead reassigns entirely by clicking.

**What was built.** The smallest list that closes it: every event someone holds
in an active status, earliest event first, each row naming the event, its
organiser, its coordinator, its status and its start, with an "Open" link to the
event's page. No filters, no counts, no actions of its own.
`listAssignedEventsForLead` reads it, `GET /event-requests/assigned` serves it
behind `leadOnly`, and `AssignedEvents.jsx` shows it at `/assigned-events`, linked
from the Lead's nav. It reads the same `ACTIVE_EVENT_STATUSES` as the picker's
"N active events", so the list and the count always agree, and when SCRUM-488
adds the safety statuses to that one constant both pick them up. `leadOnly`, not
`coordinatorOrLead`: coordinators have the shared queue and My events, and this
list would show each of them everyone's caseload, the reason
`/coordinator-workload` is the Lead's alone.

**Why this is not "built twice".** It is the first slice of SCRUM-487 AC3's list,
built as that criterion asks (earliest event first). SCRUM-487 extends it with
filters, per-coordinator counts, a finished-events toggle and the unassigned
count; it does not replace it.

**Rejected.**
- *Opening the coordinators' review queue to the Lead.* It stops at pending
  clarification, so approved and confirmed events, where an absent coordinator
  matters most, would stay unreachable. And it would undo the Lead's refusal on
  the `coordinatorOnly` routes that SCRUM-485 pinned.
- *Pulling all of SCRUM-487 forward.* Two stories in one PR blurs traceability,
  and its filters and counts are not needed for AC6.
- *Linking from the Lead's notifications.* They are unworded until SCRUM-172, and
  they reach only the events the Lead was told about, not every event a Lead may
  need to move.

### D13. The real race is in the live script, not the suite

PGlite runs one connection, one statement at a time. Two assignments "at once"
there are issued together and run back to back: that proves each call's check and
write are one unit, and that the second is refused naming the first, but never
that the row lock holds a second **transaction** while the first commits.
Nothing in CI can make two transactions overlap. Each supabase-js `rpc` is its own
HTTP request on its own connection, so `check-coordinator-assignment.js` section 2
runs five rounds of two Leads assigning the same request at once. That is AC4's
only true proof. It ran twice on 12 October, against the shared project: the first
run after 052 and the run at `d298ffc`. Every round of both ended with one winner,
the other refused with a message naming the winner, and one history row. It is the
live script, run by hand; CI still cannot run it.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC4-05 proved live, not in CI | The true race (`check-coordinator-assignment.js` section 2) ran twice on 12 October, five rounds each, one winner and a named refusal every round (D13). No suite can run it, so a change to 052's lock is caught only by running the script again | Run it again after any change to `assign_event_request` |
| AC5-03: Safety review, Safety approved | Not values of `event_request_status` yet. 052 names them in its status list, compared as text, so nothing needs to change when they arrive; until then no test can reassign at them | SCRUM-488 |
| AC10-06: the new notices are not worded | Each is shown, counted and can be marked read, as "New notification / This notification type cannot be displayed yet". `describeNotification` does not know the three types | SCRUM-172 |
| The Lead finds events only by address | **Closed (12 October).** `/assigned-events` lists every held active event, each linking to `/event-requests/:id` (D12, revised). SCRUM-487 extends that list. Not end-to-end over PGlite: `leadReassignmentWalkthrough.test.js`'s adapter answers only `rpc` and single-row reads, and was not extended; the click-through was checked by hand on 13 October and passed (section 2) | Done |
| A reopened draft stays in its old coordinator's "My events" | **Found while writing this review; inferred from the code, not reproduced.** 022 reopens a rejected request to a draft and keeps its coordinator; `listEventRequestsForCoordinator` filters only on the coordinator, with no status filter, so the old coordinator's list shows the Organiser's private draft until it is resubmitted (when 052 clears it). The service's comment claimed this could not happen ("assignment happens at submission"); it now says it can. Opening the draft is refused (404), so the list shows a name and status, not the content. Predates this story (it came with 022) | Follow-up: exclude drafts in that read, or clear the coordinator in 022's reopen |
| The organiser dashboard has no waiting line | `EventOrganiserDashboard` shows the shared status description in its expanded detail, without D8's line. The brief named only `MyEventRequests` | Follow-up |
| A request waiting for the Lead can be cancelled by nobody | **Found after the merge of dev; a dead end this story created in SCRUM-370's flow.** `cancel_event_request` (045) admits only the event's assigned coordinator, and `POST /:id/cancel` is `coordinatorOnly`; the Organiser has no cancellation or withdrawal route of their own (no route calls `changeEventRequestStatus`, and no change-request field names a status), and a change request asking for it could not be decided either, since 019 lets only the holder decide one. Before this story every submitted request had a holder, so someone could always cancel it. 045 also refuses with "Only the coordinator assigned … can cancel it", the wrong-reason message SCRUM-517 fixed for review. Not changed here: 045 is SCRUM-370's | A ticket, with SCRUM-370's owner: who cancels a request nobody holds (the Lead, the Organiser, or both) |
| The previous coordinator is not told | AC10 names the new coordinator and the Organiser. A coordinator whose event a Lead moves away hears nothing | Open question 1 |
| Live scripts: run on 12 October, after 052 was applied | **First run.** `check-event-request-routes.js:379` was fixed first: it expected "Submitted", which SCRUM-318 renamed "Requested". Then `request:check` passed clean. `routes:check` passed every SCRUM-486 check and cleaned up, but failed at line 403, which expected "Under Review" where SCRUM-318 has "Under review": the same stale label, dating from SCRUM-42. `assignment:check` passed every behaviour check, the five race rounds included, then its cleanup failed: section 5 had asked for clarification on one event, 030's `event_clarification_history_immutable` trigger (SCRUM-162) refuses every delete of clarification history, the event delete's cascade included, and because the events went in one statement, that one row kept all eleven and, through them, the three test users. Notifications and every child table returned to their starting counts; the 11 `__check_assign_1791803720214_*` events and 3 auth users were removed by hand in the SQL Editor. **Fixed:** the script no longer asks for clarification successfully (its two refusals stay; they write nothing), the hazard is in its header, cleanup deletes each event and its rows on their own and names any that stick, line 403 expects "Under review", and the `assignment:check` npm script is back (the merge `158a327` dropped it on 4 October). **Second run:** `assignment:check` passed every check except the table count (event_requests 16 → 19); the by-id check found 0 events, history rows, status rows, notifications, profiles and users of the run, and the three extra rows were `[TEST]` events another user created mid-run. `routes:check` passed 69 of 69 and left nothing. **What the live run no longer proves:** a coordinator the Lead handed the event to asking for clarification. No PGlite test did it through the clarification function either, and the case document's AC7-01 had claimed it since SCRUM-523; `SCRUM486_AC7_the_coordinator_the_lead_hands_it_to_asks_for_clarification_and_the_previous_one_cannot` now does, with the previous holder refused first | Done |
| `request:check` signs in as whoever comes first | `check-event-request-service.js` uses the first auth user `listUsers()` returns as its organiser. On the first run that was a test user left behind by `assignment:check`: harmless there, but the script depends on live data it did not create | Follow-up: create its own organiser, as the other two scripts do |

### Technical debt, inherited and left

| Item | Detail |
|---|---|
| `pick_event_coordinator` alive but dead | 015's selection rule is still in the database. Nothing calls it since 052: not submission, not the backfills (they ran once), and since SCRUM-522 not the check script either. It is kept deliberately, and 052's header now says why: the customer reversed a decision they had already given, so the rule is what would be needed back if they reverse it again; and dropping it would leave 015's applied header describing a function that does not exist. The cost is a function implementing SCRUM-327 AC2 and AC3, which are superseded |
| Applied migration headers that argue for automatic assignment | 014, 015, 016, 017, 018, 021 and 022 describe the old model, in places as the reason for their code. They are applied and append-only, so they stay; 052's header records the correction. Listed in section 5 |
| 052's header, corrected before applying | Two of its "does not do" notes went stale in SCRUM-522: the reason for keeping `pick_event_coordinator` (the check script no longer calls it) and "no script counts notifications". Both were rewritten in SCRUM-523, while 052 was still unapplied; nothing else in the file changed |
| The backend's worker cap manages contention, it does not remove it | `vitest.config.js` sets `maxWorkers: '50%'` (SCRUM-522): one worker per physical core instead of one per logical one, because the PGlite suites are CPU-bound and two on one core starved the cheap text tests into timeouts. It costs nothing (the run is as long as its slowest file), but every PGlite suite added still raises the load, and the heaviest PGlite test takes about 3.5 s in a full run against a 5 s timeout (1.4 s alone). If that margin closes, the remedy is that suite's own timeout or fewer migrations per suite, not a higher global timeout |
| Test fakes that apply filters | Two fakes in `leadAssignmentService.test.js` apply `eq`, `in`, `is` and `not` to rows, so the queue reads are proved against data rather than against the query string. They model PostgREST; if the service starts using an operator they do not know, they throw by name rather than answer wrongly, but they are a second implementation of filter semantics to keep honest |
| A PGlite adapter for supabase-js | `leadReassignmentWalkthrough.test.js` turns `rpc` and `from().select().eq().maybeSingle()` into SQL so the real router runs over a real database. It does exactly what that path needs and throws on anything else |
| Migration-number collisions | Inherited: eight numbers used twice (005, 014, 015, 016, 017, 022, 023, 030). 052 adds none |
| Lint | `UnassignedQueue.jsx` and `EventRequestReviewPage.jsx` carry the same `react-hooks/set-state-in-effect` warning as `ReviewQueue`, `MyEventRequests` and `CoordinatorNotifications`, matched on purpose; a different fetching pattern across all of them is its own ticket |

### Process notes

Stated plainly, because they will be asked.

- **The cases came first.** SCRUM-514 wrote all 71 before any code, then corrected
  them after the SCRUM-491 audit found 040's notification types and its error-code
  convention.
- **052 was built across four subtasks**, each adding a section with its tests in
  the same commit.
- **Every changed test records why it was right when written**, in a comment beside
  it, and is renamed where its name had become false. None was deleted.
- **Teeth were checked** for every new behaviour: the fix was disabled, the named
  tests were shown to fail, and the fix restored. Each subtask's report records
  which tests failed.
- **The flaky backend suite was fixed on its mechanism, not a sample.** SCRUM-521
  got three clean runs with nothing fixed; SCRUM-522 measured the contention
  (a regex-only test at 221 ms alone and 3137 ms under the default worker count)
  and capped the workers.
- **One defect was found by tests and fixed**: TR-03, "Current coordinator" taken
  from the newest history row (SCRUM-522).

---

## 5. What SCRUM-327 no longer means

### Why SCRUM-327 stays Done

SCRUM-327 delivered automatic assignment on submission because that was the
requirement it was given. Its review (`docs/SCRUM-327.md`) records each criterion
proved and each decision argued, and nothing in this story found it wrong against
that brief. In Week 7 the customer changed the requirement: "Newly submitted event
requests should no longer be assigned directly to an Event Coordinator. Instead,
they first enter an unassigned queue that can be viewed by the Event Coordinator
Lead." That is the change guide's **scenario 2: a new requirement, not a missed
one**. A missed requirement would reopen SCRUM-327, because it would mean SCRUM-327
was never done. A new requirement is a new story, and the old story's "Done" is a
true statement about the brief it was given.

So SCRUM-327 is not reopened. Its tests were right when written, and were moved
here with that recorded, not rewritten as if they had always said the new thing.
SCRUM-486 carries the change and names exactly which of SCRUM-327's criteria it
supersedes. Reopening SCRUM-327 instead would have erased the record that the
team built the first model deliberately, and would have made the sprint history
claim a defect that never existed.

### Which criteria are superseded, and which stand

| SCRUM-327 | As recorded in `docs/SCRUM-327.md` | Now |
|---|---|---|
| AC1 | Assigned automatically on submission | **Superseded** by AC1 |
| AC2 | The coordinator with the fewest active events is chosen | **Superseded**: there is no automatic choice. The count survives as information in the Lead's picker (AC3), not as a rule |
| AC3 | The tie-break | **Superseded** with AC2 |
| "AC4" | A resubmitted event returns to its previous coordinator | **Superseded** by AC1 and TR-02: a resubmission goes to the Lead's queue. (SCRUM-485 D3 records that Jira's AC4 is a different criterion; this row is the resubmission rule, whatever its number) |
| AC5 | With no coordinator available, submission is refused | **Superseded** by AC11: submission always succeeds |
| AC6 | Only the assigned coordinator hands over, in five statuses | **Stands, widened**: the Lead may too, and AC5 here lists seven statuses |
| AC7 | The new coordinator acts; the previous one only views | **Stands**, and is now proved for a Lead's handover too |
| AC9, AC10, AC11 | The history, the Organiser's view of it, "My events" | **Stand**. New history rows name the Lead; old ones still read as automatic (AC9-03) |

### Every statement that still says otherwise, and what was done

**Corrected** means the text now says what is true, or carries a dated note beside
the original saying what changed. **Left** means deliberately unchanged, with the
reason.

| Where | What it said | Verdict |
|---|---|---|
| `docs/SCRUM-327.md`, D1 | "a request is assigned the moment it is submitted" | **Corrected** by a dated note (SCRUM-523); the decision itself stands |
| `docs/SCRUM-327.md`, D2 | "An event must never be submitted without a coordinator" | **Corrected** by a note (SCRUM-523) |
| `docs/SCRUM-327.md`, D11 | The selection function's design | **Corrected**: marked superseded (SCRUM-523) |
| `docs/SCRUM-327.md`, D13 | The second half "needs decision fields, which are SCRUM-19's" | **Corrected** by a note: both halves are proved now, and submission clears the reviewer (SCRUM-523) |
| `docs/SCRUM-327.md`, section 4 | "AC4 unreachable" | **Corrected**: out of date twice (022 made it reachable; 052 superseded it) (SCRUM-523) |
| `docs/SCRUM-327.md`, AC table and evidence | AC1, AC2, AC3, AC5 as Done | **Corrected** by a dated banner naming each superseded part; the table is left as the record of what was done then |
| `docs/SCRUM-327.md`, lines citing six renamed tests | `SCRUM330_AC1_assigns_…`, `SCRUM330_AC5_refuses_…`, `SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over` (three places) | **Corrected**: current names, old names beside them (SCRUM-523) |
| `docs/SCRUM-485.md` section 5, questions 1 and 3 | The queue "can never hold anything"; "Can the Lead also be assigned events?" | **Corrected** by notes: answered by this story (SCRUM-523) |
| `docs/SCRUM-485.md` lines 90 and 331; `docs/test-cases/SCRUM-485.md` AC4-01, AC4-05 | The Lead's single nav link | **Corrected**: current names, old beside (SCRUM-523) |
| `docs/test-cases/SCRUM-486.md`, "Existing tests this story must change" | Old names, as the plan | **Corrected**: each row now says where its test went (SCRUM-523). The SCRUM-334 row predicted a change that did not happen; it now says why (D11) |
| `docs/test-cases/SCRUM-486.md`, "What exists today" and its open questions | The model before this story | **Left**: dated 11 October, a description of the starting point. The open questions are answered in section 6 below |
| `015_assignment_function.sql` header | The selection rule, "the story requires" | **Left**: applied, append-only. 052's header records that nothing calls it |
| `016_submit_event_request.sql` header | Submission assigns, and why | **Left**: applied. Superseded by 052 §2 |
| `017_require_assigned_coordinator.sql` header | Nothing past draft without a coordinator | **Left**: applied. 052 §1 replaces the constraint |
| `018_reassign_event_request.sql` header | Only the holder hands over; the guard compares with the caller | **Left**: applied. 052 §6 records both changes |
| `021_event_status_history.sql` | Redefines `submit_event_request` with the pick and the P0001 | **Left**: applied. 052 §2 replaces it |
| `022_event_status_transitions.sql`:47 | "submit_event_request chooses again on resubmission" | **Left**: applied. 052's header (D2 here) records why 052 clears the column |
| `014_coordinator_assignment.sql` header | Assignment at submission; the constraint "arrives in 015" | **Left**: applied |
| `052_lead_assignment.sql` header, two lines | The check script calls `pick_event_coordinator`; no script counts notifications | **Corrected** in SCRUM-523, before 052 is applied: the new reason for keeping the function, and which scripts now count and delete notifications |
| `eventRequestService.js`, module header | "it also assigns an Event Coordinator" | **Corrected** in SCRUM-520 |
| `eventRequestService.js`, `submitEventRequest` | The pick and the P0001 | **Corrected** in SCRUM-515 |
| `eventRequestService.js`, `translateError` | The P0001 → 503 branch | **Corrected** in SCRUM-515: removed, with a comment saying why |
| `eventRequestService.js`, `listEventRequestsForReview` | "a queue of work nobody has taken on" | **Corrected** in SCRUM-520, with the D6 argument |
| `eventRequestService.js`, `listEventRequestsForCoordinator` | "the queue is the view of work nobody holds yet"; "a draft never has an assigned coordinator, because assignment happens at submission" | **Corrected** in SCRUM-520 and SCRUM-523; the second now states the gap in section 4 |
| `eventRequestService.js`, `changeEventRequestStatus` | Submission "also assigns a coordinator" | **Corrected** in SCRUM-523 |
| `eventRequestService.js`, `listAssignmentHistory` | "which 016 writes on submission" | **Corrected** in SCRUM-523 |
| `routes/eventRequests.js`, `GET /mine` | "The queue is the only view of work nobody holds yet" | **Corrected** in SCRUM-523 |
| `domain/eventRequestStatus.js`, `COORDINATOR_QUEUE_STATUSES` | "no coordinator_id on event_requests and no assignment model" | **Corrected** in SCRUM-523 (stale since 014; SCRUM-327 recorded it and left it) |
| `EventCoordinatorDashboard.jsx` | "Since SCRUM-330 every event is assigned the moment it is submitted" | **Corrected** in SCRUM-520, with the D6 argument |
| `MyEventRequests.jsx` | "a coordinator is assigned at submission, so a draft has nobody" | **Corrected** in SCRUM-520 |
| `AssignmentHistory.jsx` | The current coordinator is the newest row | **Corrected** in SCRUM-522 (TR-03), and the `automatic` comment in SCRUM-523 |
| `frontend/src/services/eventRequestService.js` | `automatic` explained without saying it is only old rows | **Corrected** in SCRUM-523 |
| `scripts/check-coordinator-assignment.js` | Sections 1 and 2 tested the selection rule and assignment on submission | **Corrected**: rewritten in SCRUM-522 |
| `scripts/check-event-request-service.js`, `check-event-request-routes.js` | "a coordinator is assigned"; "joins the queue" | **Corrected** in SCRUM-522 |
| `scripts/check-event-change-request-service.js`:124, `check-venue-calendar.js`:39, `check-venue-routes.js`:280 | Fixture users kept out of `pick_event_coordinator`'s candidates | **Left**: a precaution against a hazard that is gone, harmless, in other stories' scripts; behaviour unaffected |

---

## 6. Open questions for the team

1. **Should the coordinator an event is taken from be told?** AC10 names the new
   coordinator and the Organiser. The previous one learns of a Lead's handover only
   by noticing the event gone from "My events".
2. **Should a resubmission write a history row?** TR-02 clears the coordinator,
   but the history table cannot record "back to nobody" (`new_coordinator_id` is
   not null), so the history reads "A", then later "Assigned to B", with nothing
   between. The screen is honest about the current state (TR-03); whether the
   record should say more is open.
3. **Drop `pick_event_coordinator`?** Nothing calls it. A migration of its own,
   when the team wants the schema to stop describing SCRUM-327's rule.

Answered by this story, from the case document's list: which route the picker
reads (its own, D11); whether the Lead opens the full event and its history (yes,
since SCRUM-521, D4 and D12); what counts as active (submitted through confirmed,
defined once in `listCoordinatorWorkload`); whether AC9 narrows who sees the
history (no: every coordinator, and now the Lead).

---

## Before the examination

- **052 is applied and the three live scripts have run** (12 October; section 4,
  "Live scripts"). Run one again only to show it: each makes and removes real
  rows in the shared project.
- **AC1 and the Lead's click-through have been walked by hand** (12 and 13
  October; section 2). Walk them again only to show them.
- **Check the eleven criteria against Jira**, AC6's amendment in particular.
- **Be ready for "if SCRUM-327 was done, why did its tests change?"** Section 5, in
  two sentences: the customer changed the requirement, which is a new story, not a
  defect in the old one; the tests were right for the old requirement, and each
  records that beside the change.
- **Be ready for "why is there still a shared queue?"** D6: the customer restricts
  managing, not viewing.
