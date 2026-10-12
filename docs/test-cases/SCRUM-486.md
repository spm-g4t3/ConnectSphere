# SCRUM-486 — Test Cases

**Story:** Assign and Reassign Event Coordinators from an Unassigned Queue — Event Coordinator Lead
**Subtask:** SCRUM-514 (this document)
**Schema:** `041_lead_assignment.sql` (SCRUM-515 to SCRUM-518). 040 is `040_venue_holds.sql`
**Written:** 11 October 2026, **before the code.** Every case describes what will be built. None is implemented yet; SCRUM-522 fills in the test names.
**Corrected:** 11 October 2026, after the audit of SCRUM-491 (venue holds, migration 040): which suites need 041, 040's notification types and their failure mode, and the error codes 041 uses.
**Marked:** 12 October 2026, SCRUM-522: every case's **Implemented by** names the tests that prove it, or says why none does yet. The cases themselves are unchanged.

This document is the written layer between SCRUM-486's acceptance criteria and the
Vitest files that will implement them. Deliverable #3 requires test cases
traceable from user stories and acceptance criteria to tests; the chain is
**user story → acceptance criteria → test case → test class → code**, and it is
walked for a randomly chosen feature in the Week 13 Q&A.

This story reverses a decision the team built and defended in SCRUM-327, so it
carries more argument than usual. Section *Design decisions* is that argument.

---

## How case IDs relate to test names

As in `docs/test-cases/SCRUM-485.md`: each case has a short stable ID (`AC3-02`)
and an **Implemented by** column, which names every test that proves the case,
read from the test files (SCRUM-522). New tests are named `SCRUM486_ACn_…`. An
older test that this story moved keeps its own story's prefix
(`SCRUM330_…`, `SCRUM45_…`, `SCRUM10_…`, `SCRUM331_…`), so its history can be
followed; each records in a comment why it changed. A case not yet proved says so
in bold, and is listed under the tally.

The audit before this story found eight places where removing automatic
assignment would break if nobody tested it. They are not acceptance criteria;
they are traps. Each is either a case under the criterion it belongs to, or, where
no criterion owns it, a `TR-` case in *The traps* below.

**Where each case is proved** matters more than usual here, because most of this
story lives in Postgres functions:

| Short | File | Proves |
|---|---|---|
| pglite | a PGlite suite applying the real migrations, 041 included (`backend/tests/db/`, beside `eventStatusLifecycleDatabase.test.js`) | What the database accepts and what the functions write. The only place that proves the constraint and the functions, rather than what a fake client was told |
| mig | a migration-text test for 041 | What 041 contains |
| svc | `backend/tests/services/eventRequestService.test.js` (fake client) | The service calls the right function with the right arguments, and maps each SQLSTATE to the right error |
| route | `backend/tests/routes/eventRequests.test.js` (fake client) | Gates, status codes, the caller from the token |
| screen | the component tests in `frontend/tests/components/` | What each person sees |
| live | `backend/scripts/check-coordinator-assignment.js`, against Supabase | What a single-connection test cannot provoke |

A fake client returns whatever it is given, so it can never prove that a
function refuses a null, or that two writes happen in one statement. Every case
marked **pglite** is one a fake client would pass whether or not the code was
right.

---

## The story

> **USER STORY:** As the Event Coordinator Lead, I want to assign each submitted
> event request to a coordinator myself, and move events between coordinators, so
> that every event has one clear point of contact chosen by a person.

### Acceptance criteria

Quoted from the ticket.

1. Submitting an event request no longer assigns a coordinator. The request
   becomes Submitted with no coordinator, and the organiser sees that it is
   waiting for one. This supersedes SCRUM-327 AC1, AC2, AC3 and AC5.
2. Only the Lead sees the unassigned queue: every Submitted request with no
   coordinator, oldest first, showing the event name, the organiser, the proposed
   period, the expected attendance and how long it has waited. Drafts never
   appear. An unassigned request does not appear in the coordinators' shared
   review queue either, because no coordinator can act on it.
3. The Lead assigns a request to one Event Coordinator, with an optional note.
   Only users holding the Event Coordinator role can be chosen; the Lead cannot be
   assigned events. The picker shows each coordinator's current number of active
   events, so the Lead can balance work. The system suggests nobody.
4. An assignment gives the event its coordinator and writes its history row in one
   step. If two assignments of the same request happen at the same moment, only
   one succeeds, and the other is refused and shown who was assigned.
5. An event can be reassigned to another coordinator while it is Submitted, Under
   review, Pending clarification, Approved, Safety review, Safety approved or
   Confirmed, with an optional handover note. Reassigning in any other status is
   refused.
6. Both the event's assigned coordinator and the Event Coordinator Lead can
   reassign it. SCRUM-327 AC6 stands rather than being superseded. (Amended 11
   October; the first wording removed the coordinator's ability. The customer says
   the Lead can reassign, not that coordinators cannot.)
7. After a reassignment the new coordinator can carry out every coordinator action
   on the event, and the previous coordinator can still view it but change nothing
   (SCRUM-327 AC7 stands). Open clarification requests, change requests and
   flagged items belong to the event, so the new coordinator sees them straight
   away.
8. Nobody can start the review of a request that has no coordinator. The attempt
   is refused with a message that the request is waiting for the Lead to assign it
   (SCRUM-19).
9. Every assignment and reassignment records the previous coordinator (none for
   the first), the new coordinator, who made it, the date and time, and the note.
   The organiser and the assigned coordinator can view this history, and the
   organiser still does not see the note.
10. The Lead is notified when a request is submitted and unassigned. The newly
    assigned coordinator, and the organiser with the coordinator's name, are
    notified when it is assigned or reassigned (SCRUM-173). "The Lead" means every
    user holding the role, as migration 014 notifies every coordinator.
11. If no Lead exists, submission still succeeds and the request waits in the
    queue. This replaces the refusal in SCRUM-327 AC5. No notification is written,
    and nothing fails.

### The customer's words

AC1 rests on the Week 7 changes document, change 5:

> "ConnectSphere has introduced a new internal role, the Event Coordinator Lead,
> who is responsible for overseeing incoming event requests and assigning them to
> individual Event Coordinators. Newly submitted event requests should no longer be
> assigned directly to an Event Coordinator. Instead, they first enter an
> unassigned queue that can be viewed by the Event Coordinator Lead. The Lead can
> review basic event information, assign a suitable Event Coordinator, and reassign
> events where necessary. Event Coordinators should only be able to manage events
> assigned to them, while the Event Coordinator Lead should be able to view all
> coordinator assignments and active events under their supervision. Relevant
> users should be notified when assignments or reassignments occur."

---

## What exists today, which this story changes

Read from the code on 11 October, so the cases below describe a change from a
known starting point.

- **Submission assigns.** `submit_event_request` (redefined in 021; 016's
  two-argument version is dropped) locks the row, checks it is a draft, calls
  `pick_event_coordinator`, raises P0001 "No coordinator is available; please try
  again later" if it finds nobody, then sets status, `submitted_at` and
  `assigned_coordinator_id` in one update and writes one row to each history
  table (`assigned_by` null: the system).
- **The database forbids a submitted request with no coordinator.** 017's
  `event_requests_assigned_when_submitted`:
  `status in ('draft', 'cancelled') or assigned_coordinator_id is not null`.
- **Only the holder hands over.** `reassign_event_request` (018) refuses any caller
  but the current `assigned_coordinator_id` (42501), and its update is guarded
  `and assigned_coordinator_id = p_assigned_by`.
- **`pick_event_coordinator` has one live caller**, submission. The only other
  callers are 016's and 017's one-off backfills, already run, and the live check
  script.
- **Every function that reads `assigned_coordinator_id` refuses or skips a null**,
  except two that would let a null caller through (see TR-04, TR-05).
- **The latest `notifications_type_known` is 040's**, seven types:
  `booking_flagged`, `booking_request_withdrawn`, `clarification_requested`,
  `clarification_replied`, `clarification_closed`, `booking_flagged_setup_change`,
  `venue_hold_expired`. There is no `event_request_id` column; the clarification
  notices carry `eventRequestId` in the payload. Every writer is a Postgres
  function.

---

## Design decisions the cases rest on

Each is stated as the argument, because each will be questioned.

**Why automatic assignment is going, and why SCRUM-327 stays Done.** SCRUM-327
built assignment on submission correctly, against the brief it had, and argued
every part of it (`docs/SCRUM-327.md`). In Week 7 the customer changed the
requirement: "Newly submitted event requests should no longer be assigned directly
to an Event Coordinator." That is the change guide's scenario 2, a new
requirement, not a missed one. So SCRUM-327 is not reopened, its tests were right
when written, and this story carries the change and says which of 327's criteria
it supersedes (AC1, AC2, AC3, AC5) and which stand (AC6, AC7).

**A resubmitted request goes to the queue, and that is not automatic.** SCRUM-327
AC4 sent a resubmitted request back to its previous coordinator; AC1 here says
submission assigns nobody, which supersedes it. But simply deleting the assignment
from `submit_event_request` would not achieve that. Migration 022's
rejected → draft leaves `assigned_coordinator_id` on the draft (017 allows a draft
to carry one), so a submission that merely stopped writing the column would hand
the request straight back to its old coordinator, past the Lead. The submission
function must **set the coordinator to null explicitly**. It also clears
`reviewing_coordinator_id`, which 022 leaves behind too: that closes the stale
reviewer question SCRUM-19 left open (its open question 5). TR-02 pins both.

**Both the coordinator and the Lead reassign** (AC6 as amended on 11 October). The
customer says the Lead can reassign, not that coordinators cannot. So 018's caller
check widens from "the holder" to "the holder, or anyone holding
`event_coordinator_lead`", and its guarded update stops comparing with the caller.

**The first assignment is not a reassignment.** 018's update is guarded
`and assigned_coordinator_id = p_assigned_by`. For a request with no coordinator,
`null = x` is null, so it matches no row whatever the caller, and the assignment
would fail as a 40001 "changed hands". The first assignment therefore has a path
of its own that requires the request to have no coordinator, and that requirement
is also what makes AC4's second, simultaneous assignment fail (AC4-02).
Reassignment keeps 018's path, which requires one.

**The Lead cannot be assigned events.** The customer describes supervision: the
Lead "should be able to view all coordinator assignments and active events under
their supervision". That is oversight of a caseload, not a caseload. So only
`event_coordinator` profiles can be chosen, exactly as 018 already checks for a
handover. This answers SCRUM-485's open question 3.

**Coordinators keep the shared review queue, minus unassigned requests.** The
customer restricted what coordinators may *manage* to their own events.
SCRUM-444 AC1 explicitly allows any coordinator to *view* any event, and the queue
is how a coordinator covering for a colleague sees their work. So the queue is not
narrowed to "mine". Only requests that belong to nobody are filtered out, because
no coordinator can act on them (AC2), and they are the Lead's to place.

**The system suggests nobody.** The picker shows each coordinator's active-event
count so the Lead can balance work, but pre-selects nobody and is ordered by name,
not by count. Ordered by count, the top of the list would be a recommendation in
all but name, which is the automatic selection AC1 removes.

**The organiser's "waiting" line comes from the assignment, not the status.**
`STATUS_DISPLAY` is decided by status alone, and `submitted` reads "Received by
ConnectSphere and waiting to be picked up by a Coordinator." After this story one
status covers both "waiting for the Lead to assign" and "assigned, waiting to be
reviewed". So the organiser's waiting line is derived from the request having no
`assignedCoordinatorId`, and the status display is left to describe the status.

**041 raises 018's and 029's codes, not 040's.** Two conventions now exist in the
schema. 018 and 029 raise standard SQLSTATEs (55000 for a state that does not
allow the action, 42501 for the wrong caller, 22023 for a bad value, 40001 for a
lost race) and leave the HTTP status to `translateError` in
`eventRequestService.js`, which maps each code once. 040, the venue holds, raises
`errcode = 'PT409'` with a hint (`EVENT_NOT_APPROVED`), a PostgREST code that sets
the HTTP status itself. 041's functions follow 018 and 029, because they sit
beside them: `assign_event_request` is the first-assignment twin of
`reassign_event_request` (018), and the not-yet-assigned refusal is added to
`start_event_review` (029). A reader comparing the assign and reassign functions
should find the same codes for the same refusals, and the service should go on
translating one convention, not two. The cases below assert those codes.

**Notices are written inside the functions.** Every notification in this schema is
written by a Postgres function, in the transaction that causes it, so a request
and its notice cannot part. AC10's three notices follow: the Lead's inside
`submit_event_request`, the coordinator's and organiser's inside the assign and
reassign functions. "The Lead" is every profile holding the role (AC10), written
as an insert from a select, so zero Leads writes zero rows and fails nothing
(AC11).

---

## Shorthand for preconditions

- **LEAD** — a signed-in `event_coordinator_lead`. **LEAD2** — a second one.
- **A**, **B** — two `event_coordinator` users. **SAFETY** — a `safety_officer`.
- **ORG** — the request's own `event_organiser`.
- **UNASSIGNED** — a request at `submitted` with `assigned_coordinator_id` null.
- **HELD BY A** — a request whose `assigned_coordinator_id` is A.
- **Nothing written** — the event row, both history tables and `notifications` are
  exactly as they were.

---

## AC1 — submission no longer assigns; the organiser sees it waiting

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | A complete draft; A and B exist | `submit_event_request` | `submitted`, `submitted_at` set, `assigned_coordinator_id` null; one status-history row `draft → submitted`; **no** assignment-history row | Proved (pglite): `SCRUM486_AC1_submits_with_no_coordinator_even_when_coordinators_exist` |
| AC1-02 | A complete draft | The same | `pick_event_coordinator` is not called (no P0001 path; a database with no Event Coordinator at all still submits) | Proved (pglite, mig): `SCRUM486_AC1_the_submission_function_in_force_does_not_call_pick_event_coordinator`, `SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists` |
| AC1-03 | — | `submitEventRequest` | One rpc with the same three arguments as today; returns `assignedCoordinatorId: null`; no `ServiceUnavailableError` path | Proved (svc): `SCRUM330_AC1_submits_through_one_call_that_names_no_coordinator`, `SCRUM330_AC1_returns_the_submitted_request_in_camelCase_with_no_coordinator` (both moved in SCRUM-522), `SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503` |
| AC1-04 | ORG's complete draft | `POST /api/event-requests/:id/submit` | 200, `assignedCoordinatorId` null | Proved (route): `SCRUM10_AC5_returns_200_and_the_submitted_request`, re-expected in SCRUM-522 to a null coordinator |
| AC1-05 | ORG; one UNASSIGNED request | Open their requests list | The row itself says it is waiting for a coordinator to be assigned, without opening anything | Proved (screen): `SCRUM486_AC1_a_submitted_request_with_no_coordinator_says_it_is_waiting_for_the_lead`, `SCRUM486_AC1_the_two_are_visibly_different_on_rows_that_share_a_status` |
| AC1-06 | ORG; the same request, now HELD BY A | Open their requests list | The row names A instead; no "waiting" line | Proved (svc, screen), after SCRUM-523: `SCRUM486_AC1_each_held_row_carries_its_coordinators_name_from_one_read`, `SCRUM486_AC1_no_coordinator_on_any_row_means_no_second_read` (the Organiser's list reads the names in one profiles read); `SCRUM486_AC1_a_submitted_request_names_the_coordinator_it_was_assigned_to` (the row reads "A has been assigned; your request is waiting for them to start the review", and the waiting-for-the-Lead line is gone) |

---

## AC2 — only the Lead sees the unassigned queue; coordinators do not

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | — | The queue read in the service | Selects `status = 'submitted'` and `assigned_coordinator_id is null`, ordered by `submitted_at` ascending, then `id` | Proved (svc): `SCRUM486_AC2_reads_submitted_requests_with_no_coordinator_oldest_first` |
| AC2-02 | — | The queue read | Each row carries the event name, the organiser's name, proposed start and end, expected attendance, and `submittedAt` (from which "how long it has waited" is computed) | Proved (svc): `SCRUM486_AC2_each_row_carries_name_organiser_period_attendance_and_when_it_was_submitted` |
| AC2-03 | A draft (with or without a stale coordinator), an UNASSIGNED request, a request HELD BY A | Read the queue | Only the UNASSIGNED request | Proved (svc, not pglite): `SCRUM486_AC2_neither_queue_lists_a_draft_even_one_with_a_stale_coordinator`, `SCRUM486_AC2_the_unassigned_request_is_the_leads_and_appears_in_the_leads_queue`, through a fake that applies the query's own filters to a mixed table. The read is a PostgREST query, which PGlite cannot run. Live: `check-coordinator-assignment.js` section 1 |
| AC2-04 | LEAD | `GET` the queue route | 200 | Proved (route): `SCRUM486_AC2_a_lead_reads_the_unassigned_queue` |
| AC2-05 | A, ORG, venue staff, technical support, SAFETY | `GET` the queue route | 403 from the role gate, nothing queried; no token is 401 | Proved (route): `SCRUM486_AC2_%s_refuses_%s_with_403_and_queries_nothing`, `SCRUM486_AC2_%s_answers_401_without_a_token` |
| AC2-06 | — | The coordinators' shared review queue (`listEventRequestsForReview`) | Adds `assigned_coordinator_id is not null`; every other status it listed is still listed | Proved (svc): `SCRUM486_AC2_the_review_queue_leaves_out_a_submitted_request_nobody_holds`, `SCRUM486_AC2_the_review_queue_still_lists_a_held_request_in_every_status_it_listed_before`, `SCRUM45_AC1_filters_on_the_three_review_statuses_and_on_a_coordinator_holding_the_request`. The pglite half as AC2-03 |
| AC2-07 | LEAD; two UNASSIGNED requests, submitted three days and one hour before an injected `now` | Open the Lead's dashboard | Both rows, oldest first, with name, organiser, period, attendance and "waiting 3 days" / "waiting 1 hour" | Proved (screen): `SCRUM486_AC2_lists_each_request_oldest_first_with_what_the_lead_needs_to_choose`; the wording `SCRUM486_AC2_a_request_submitted_%s_ago_reads_%j` |
| AC2-08 | LEAD; no UNASSIGNED request | Open the dashboard | Says the queue is empty; no invented rows | Proved (screen): `SCRUM486_AC2_an_empty_queue_says_nothing_is_waiting_and_invents_no_rows` |

---

## AC3 — the Lead assigns to one Event Coordinator; the system suggests nobody

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | UNASSIGNED | LEAD assigns it to A, note "Over to you" | `assigned_coordinator_id` A; one assignment-history row: previous null, new A, `assigned_by` LEAD, the note | Proved (pglite): `SCRUM486_AC3_a_lead_assigns_an_unassigned_submitted_request` |
| AC3-02 | UNASSIGNED | LEAD assigns it to LEAD2, to SAFETY, or to ORG | Refused 22023 ("not an Event Coordinator"); nothing written | Proved (pglite): `SCRUM486_AC3_refuses_%s_as_the_assignee_and_writes_nothing` |
| AC3-03 | UNASSIGNED | A, ORG, SAFETY, or a null caller, makes the first assignment | Refused 42501; nothing written. Only a Lead assigns | Proved (pglite): `SCRUM486_AC3_refuses_%s_as_the_caller_and_writes_nothing` |
| AC3-04 | — | The service call for an assignment | One rpc with the request, the chosen coordinator, the caller from the token and the note; a blank note sent as null | Proved (svc): `SCRUM486_AC3_an_assignment_is_one_rpc_with_the_caller_and_the_note`, `SCRUM486_AC3_a_note_that_is_%s_is_sent_as_null` |
| AC3-05 | — | The assignment route | Gated on `event_coordinator_lead`; another role is 403 with nothing queried; the caller is the token's user, never the body | Proved (route): `SCRUM486_AC3_a_lead_assigns_and_is_recorded_from_the_token_not_the_body`, and the `POST /:id/assign` rows of `SCRUM486_AC2_%s_refuses_%s_with_403_and_queries_nothing` |
| AC3-06 | A holds two active events, B none | The picker's coordinator list | Every `event_coordinator`, each with their active-event count (A 2, B 0); no Lead in the list | Proved (svc), by SCRUM-519's workload read: `SCRUM486_AC3_lists_every_event_coordinator_with_their_active_count`, `SCRUM486_AC3_only_the_event_coordinator_role_is_read_so_no_lead_is_listed`, `SCRUM486_AC3_counts_only_the_active_statuses_of_the_coordinators_listed`. The pglite half (the counts against real rows) is `check-coordinator-assignment.js` section 6, live |
| AC3-07 | — | Open the picker | Ordered by name, nothing pre-selected, no "recommended" mark | Proved (screen): `SCRUM486_AC3_lists_every_coordinator_with_their_active_events_in_the_servers_order`, `SCRUM486_AC3_nothing_is_chosen_for_the_lead_and_nothing_is_recommended` |

---

## AC4 — one step; of two simultaneous assignments, one succeeds

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | UNASSIGNED | An assignment whose history insert fails (a missing user as `assigned_by`) | 23503; `assigned_coordinator_id` still null; no history row. The two writes stand or fall together | Proved (pglite): `SCRUM486_AC4_the_coordinator_and_its_history_row_stand_or_fall_together` |
| AC4-02 | UNASSIGNED, then assigned to A | LEAD assigns it to B (the second of two) | Refused, with a message naming A as the coordinator already assigned; nothing written | Proved (pglite): `SCRUM486_AC4_refuses_a_second_assignment_and_names_who_got_there_first` |
| AC4-03 | The function refuses as in AC4-02 | The service | A 409 carrying the function's message, so the name reaches the screen | Proved (svc, route): `SCRUM486_AC4_a_lost_race_is_a_409_that_names_who_holds_it`, `SCRUM486_AC4_a_lost_race_arrives_as_a_409_with_the_holder_as_data` |
| AC4-04 | LEAD; the assignment comes back 409 | — | The screen says who was assigned, and the request leaves the queue on refresh | Proved (screen): `SCRUM486_AC4_a_lost_race_names_who_was_assigned_and_offers_only_the_way_back`, `SCRUM486_AC4_after_a_lost_race_the_request_leaves_the_queue_on_the_way_back` |
| AC4-05 | Two connections, the same UNASSIGNED request | Both assign at once | Exactly one succeeds; the other is refused as in AC4-02 | **Written, not run.** PGlite proves two calls issued together end with one winner and a named refusal (`SCRUM486_AC4_of_two_leads_assigning_at_once_exactly_one_wins_and_the_other_is_told_who`), not the row lock under true overlap (one connection). The real race is `check-coordinator-assignment.js` section 2, five rounds of two Leads; it runs against the live database and has not been run |

AC4-02 is the proof that the second assignment is refused: PGlite runs one query at
a time, so it shows the refusal of an assignment that arrives after another, which
is what the row lock turns a simultaneous one into. AC4-05 is the only case that
provokes two at once, and needs two real connections.

---

## AC5 — reassignment in the listed statuses only

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | HELD BY A, at each of `submitted`, `under_review`, `pending_clarification`, `approved`, `confirmed` | Reassign to B | Allowed: B holds it; one history row | Proved (pglite): `SCRUM486_AC5_a_lead_reassigns_a_request_that_is_%s` |
| AC5-02 | HELD BY A, at each of `rejected`, `completed`, `cancelled` | Reassign to B | Refused 55000 naming the status; nothing written | Proved (pglite): `SCRUM486_AC5_refuses_to_reassign_a_request_that_is_%s_and_writes_nothing` |
| AC5-03 | — | Reassign at `safety_review` or `safety_approved` | **Cannot be written as specified**: neither status exists (see *What cannot be tested*) | **Cannot be written yet** (see *What cannot be tested*). `SCRUM486_AC5_the_status_list_names_the_safety_statuses_before_they_exist` pins that 041 names them; the behaviour waits for the statuses |
| AC5-04 | — | Reassign with no note, or a blank one | Allowed; the note stored as null | Proved (pglite, svc): `SCRUM486_AC5_a_handover_with_no_note_stores_null`, `SCRUM331_AC9_sends_an_omitted_or_blank_note_as_null` |
| AC5-05 | UNASSIGNED | Reassign it | Refused, with a message saying it has no coordinator yet and must be assigned, not a 40001 "changed hands" | Proved (pglite): `SCRUM486_AC5_an_unassigned_request_is_assigned_not_reassigned` |

---

## AC6 — both the assigned coordinator and the Lead reassign

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | HELD BY A | A reassigns to B | Allowed (SCRUM-327 AC6, unchanged); history `assigned_by` A | Proved (pglite): `SCRUM486_AC6_the_holder_reassigns_as_scrum327_allowed` |
| AC6-02 | HELD BY A | LEAD, who does not hold it, reassigns to B | Allowed; history previous A, new B, `assigned_by` LEAD. No 40001 from the guarded update | Proved (pglite): `SCRUM486_AC6_a_lead_who_does_not_hold_the_event_reassigns_it`; over HTTP, `SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` |
| AC6-03 | HELD BY A | B (not the holder), SAFETY, ORG, or a null caller reassigns | Refused 42501; nothing written | Proved (pglite): `SCRUM486_AC6_refuses_%s_as_the_caller_and_writes_nothing` |
| AC6-04 | — | `POST /:id/reassign` | Admits `event_coordinator` and `event_coordinator_lead`; every other role 403 with nothing queried | Proved (route): `SCRUM486_AC6_a_lead_reaches_the_handover_function`, `SCRUM486_AC6_%s_is_refused_the_handover_with_403_and_queries_nothing` |
| AC6-05 | HELD BY A, open on the event screen | As A, as LEAD, as B | The hand-over action for A and for LEAD; none for B | Proved (screen): `SCRUM486_AC6_a_lead_sees_the_hand_over_action_on_an_event_they_do_not_hold`, `SCRUM486_AC6_the_holder_still_sees_it`, `SCRUM486_AC6_a_coordinator_who_holds_nothing_does_not` |
| AC6-06 | HELD BY A, `under_review`, A the reviewer, no decision | LEAD reassigns to B | The reviewer follows to B, as 018 does for a holder's handover. A decided event keeps its reviewer | Proved (pglite): `SCRUM486_AC6_the_reviewer_follows_an_undecided_event_the_lead_moves`, `SCRUM486_AC6_a_decided_event_keeps_its_reviewer_when_the_lead_moves_it` |

---

## AC7 — the new coordinator acts; the previous one only views

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | Reassigned from A to B by LEAD | B starts the review, asks for clarification, decides | Each allowed | Proved (pglite, route): `SCRUM486_AC7_the_new_coordinator_reviews_and_decides_and_the_previous_one_cannot`, `SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` |
| AC7-02 | The same | A tries each of those | Refused 42501 / 403 | Proved (pglite, route): the same two |
| AC7-03 | The same | A reads the event | Allowed (any coordinator reads any event, SCRUM-332) | Proved (route, on a real database): `SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` |
| AC7-04 | A clarification request open when LEAD reassigned A → B | B closes it; A tries to | B allowed; A refused | Proved (pglite): `SCRUM486_AC7_an_open_clarification_follows_the_event_to_its_new_coordinator` |
| AC7-05 | A change request pending when LEAD reassigned A → B | B decides it; A tries to | B allowed (019 checks the holder); A refused | Proved (pglite): `SCRUM486_AC7_a_pending_change_request_follows_the_event_to_its_new_coordinator` |
| AC7-06 | A booking flagged before LEAD reassigned A → B | B reads their booking requests | The flagged booking is listed for B, not A | Proved (svc): `SCRUM486_AC7_the_new_coordinator_lists_the_booking_and_the_previous_one_does_not` |

---

## AC8 — nobody starts the review of an unassigned request

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | UNASSIGNED | A calls `start_event_review` | Refused with a message that the request is waiting for the Event Coordinator Lead to assign it. Not 42501 "only the coordinator assigned … can start reviewing it", which is today's answer and tells A the wrong thing | Proved (pglite): `SCRUM486_AC8_starting_the_review_of_an_unassigned_request_is_refused_naming_the_lead_for_%s` |
| AC8-02 | UNASSIGNED | `start_event_review` with a null caller, and with LEAD | The same waiting message: the check comes before the caller check, so nobody is told it is "not theirs" | Proved (pglite): the same, its Lead and null-caller rows |
| AC8-03 | The function refuses as in AC8-01 | The service | 409 with the function's message | Proved (svc): `SCRUM486_AC8_%s_is_a_409_with_the_functions_message` |
| AC8-04 | UNASSIGNED, opened by A by id | The event screen | "Waiting for the Event Coordinator Lead to assign this request"; no Start review button, for anyone | Proved (screen): `SCRUM486_AC8_an_unassigned_request_opened_by_%s_says_it_is_waiting_for_the_lead` |
| AC8-05 | Start review refused with 409 | — | The screen tells "waiting for assignment" from "no longer waiting to be reviewed" by the request's own `assignedCoordinatorId`, not by the server's message text | **Met differently.** The screen never reads the message (`SCRUM486_AC8_a_409_on_start_review_says_it_may_be_waiting_for_the_lead`), but it does not choose between the two causes either: SCRUM-517 gave the 409 one message naming both. Choosing by the request's own `assignedCoordinatorId` cannot work at click time, because the button shows only to the holder, so that field always names them. SCRUM-523 to report the deviation |

---

## AC9 — every assignment and reassignment is recorded

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC9-01 | — | LEAD's first assignment | Row: previous null, new A, `assigned_by` LEAD, note, `created_at` | Proved (pglite): `SCRUM486_AC3_a_lead_assigns_an_unassigned_submitted_request`, `SCRUM486_AC9_reads_correctly_across_a_submission_an_assignment_and_two_reassignments` |
| AC9-02 | — | LEAD's reassignment A → B | Row: previous A, new B, `assigned_by` LEAD, note | Proved (pglite): `SCRUM486_AC9_reads_correctly_across_a_submission_an_assignment_and_two_reassignments` |
| AC9-03 | A history with one system row (from before this story) and one LEAD row | `listAssignmentHistory` | The old row `automatic: true`; the LEAD row `automatic: false`, `assignedByName` the Lead's name | Proved (svc): `SCRUM486_AC9_an_old_row_reads_automatic_and_a_leads_row_names_the_lead`, `SCRUM486_AC9_a_lead_with_no_name_is_still_not_automatic`; live, `check-coordinator-assignment.js` section 6 |
| AC9-04 | The same | The organiser's history route | Both rows, and no `handoverNote` key on either | Proved (route): `SCRUM486_AC9_the_organisers_route_has_both_rows_and_no_note_on_either` |
| AC9-05 | The same | The assigned coordinator's history route | Both rows, with the note | Proved (route): `SCRUM486_AC9_the_coordinators_route_has_both_rows_with_the_note` |
| AC9-06 | The same | Open the history on screen | The old row "by ConnectSphere, automatically on submission"; the LEAD row "by" the Lead's name | Proved (screen): `SCRUM486_AC9_an_old_automatic_row_and_a_leads_row_read_differently_in_one_history` |

---

## AC10 — the Lead, the coordinator and the organiser are notified

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC10-01 | LEAD and LEAD2 exist | Submit a request | One notice to each Lead, of a new type, with `eventRequestId` and the event name in the payload | Proved (pglite): `SCRUM486_AC10_submission_tells_every_lead_a_request_is_waiting` |
| AC10-02 | UNASSIGNED | LEAD assigns it to A | One notice to A, and one to ORG naming A | Proved (pglite): `SCRUM486_AC10_an_assignment_tells_the_coordinator_and_the_organiser_by_name` |
| AC10-03 | HELD BY A | LEAD (or A) reassigns to B | One notice to B, and one to ORG naming B | Proved (pglite): `SCRUM486_AC10_a_reassignment_tells_the_new_coordinator_and_the_organiser_who_held_it` |
| AC10-04 | — | Read 041's `notifications_type_known` | All seven of 040's types, `booking_flagged`, `booking_request_withdrawn`, `clarification_requested`, `clarification_replied`, `clarification_closed`, `booking_flagged_setup_change`, `venue_hold_expired`, plus the new ones. Not 034's six, which lack `venue_hold_expired` | Proved (mig, pglite): `SCRUM486_AC10_041_keeps_every_type_040_allows_and_adds_three` |
| AC10-05 | An assignment refused (AC4-02, AC3-02) | — | No notice written | Proved (pglite): `SCRUM486_AC10_a_refused_assignment_notifies_nobody_when_%s` |
| AC10-06 | A notice of each new type | Each recipient opens their notifications | Shown in words, not as a raw type | **Unmet.** Each new type is shown, counted and markable, but as "New notification / This notification type cannot be displayed yet" (`SCRUM486_AC10_each_new_type_is_shown_as_a_notification_that_cannot_be_displayed_yet`), not in words. The wording is SCRUM-172's. SCRUM-523 to report |
| AC10-07 | 041 applied after 040; an active hold whose expiry has passed | `process_venue_hold_expiry` | The hold is marked expired and its `venue_hold_expired` notice written, as before 041 | Proved (pglite): `SCRUM486_AC10_a_lapsed_hold_still_expires_and_is_notified_after_041` |

**Why AC10-04 and AC10-07 matter beyond this story.** `notifications_type_known`
is restated whole every time a type is added: 041 drops it and adds it again with
the new types beside the old. The last restatement is 040's, with seven types.
An earlier list, 034's, has six and lacks `venue_hold_expired`. If 041 restated
that one, one of two things would follow. If any hold has already expired on the
live database, its notice row would fail the new constraint, so 041 would not
apply at all. If none has, 041 would apply cleanly and every later run of
`process_venue_hold_expiry` would fail with 23514 on its notice insert, and
because the expiry and the notice are one statement, **venue holds would silently
stop expiring**. AC10-04 catches the list; AC10-07 catches the effect. 041 leaves
040's other notification objects (`notifications_hold_expired_needs_hold` and the
partial index `notifications_one_per_expired_hold`) as they are; both are
written `type <> 'venue_hold_expired' or …`, so the new types pass them
untouched.

---

## AC11 — with no Lead, submission still succeeds

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC11-01 | No profile holds `event_coordinator_lead` | Submit a request | Succeeds, the request UNASSIGNED; zero notices; no error | Proved (pglite): `SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists` |
| AC11-02 | No Event Coordinator either | Submit a request | Succeeds as in AC11-01. The old P0001 refusal is gone | Proved (pglite): the same |
| AC11-03 | — | `submitEventRequest` when the database raises nothing | No `ServiceUnavailableError`; the P0001 branch of `translateError` is no longer reached by submission | Proved (svc): `SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503` |

---

## The traps

From the audit, where removing automatic assignment breaks if nobody tests it.
Where a criterion owns a trap, the case is above and named here; the rest are
`TR-` cases.

| Trap | Covered by |
|---|---|
| The relaxed constraint must accept a submitted request with no coordinator and still refuse an under-review one | TR-01 |
| A reopened and resubmitted request must reach the queue with no coordinator | TR-02 |
| A first assignment must succeed although 018's guarded update cannot match a null | AC3-01, AC5-05 |
| A Lead reassigning an event they do not hold must succeed, and so must the holder | AC6-01, AC6-02 |
| `start_event_review` must name the Lead, not say "not assigned to you" | AC8-01, AC8-02 |
| The two null-caller holes must close (037 equipment lines, 030 close clarification) | TR-04, TR-05 |
| Submission must succeed with no Lead, writing no notice | AC11-01 |
| The suites that build or read the database must know about 041 | TR-06, TR-07 |
| Of two simultaneous assignments, one succeeds and the other names the winner | AC4-02, AC4-05 |

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| TR-01 | 041 applied | Write a request at `submitted` with no coordinator; then at `under_review`, `pending_clarification`, `approved`, `confirmed` with none | `submitted` accepted; every other status refused 23514 naming the relaxed constraint. `draft` and `cancelled` still accepted with none | Proved (pglite): `SCRUM486_TR01_accepts_a_submitted_request_with_no_coordinator`, `SCRUM486_TR01_still_refuses_a_request_that_is_%s_with_no_coordinator`, `SCRUM486_TR01_still_accepts_a_request_that_is_%s_with_no_coordinator` |
| TR-02 | HELD BY A, rejected, reopened to draft by 022 (which leaves A and the reviewer on it) | Submit again | `assigned_coordinator_id` null and `reviewing_coordinator_id` null; the request is in the queue, not back with A | Proved (pglite): `SCRUM486_TR02_a_resubmitted_request_reaches_the_queue_with_no_coordinator_and_no_reviewer` |
| TR-03 | TR-02's request | Open its assignment history | "Current coordinator" reads not assigned, although the newest history row names A. Today `AssignmentHistory` takes the current coordinator from the newest row, which after TR-02 would be wrong | Proved (screen), with the fix made in SCRUM-522: `SCRUM486_TR03_a_resubmitted_request_waiting_for_the_lead_reads_not_assigned`. `AssignmentHistory` now takes the current coordinator from the request |
| TR-04 | UNASSIGNED | Migration 037's equipment-lines function with a null caller | Refused 42501. Today `v_assigned is distinct from p_coordinator_id` lets null meet null through; safe only while 017 guaranteed a coordinator | Proved (pglite): `SCRUM486_TR04_refuses_a_null_caller_on_a_request_with_no_coordinator` and its two companions |
| TR-05 | UNASSIGNED at `pending_clarification` is impossible, so: a request whose coordinator is null, by a direct write | Migration 030's close-clarification function with a null caller | Refused 42501 before the status check. The same `is distinct from` hole as TR-04 | Proved (pglite): `SCRUM486_TR05_closing_refuses_a_null_caller_before_the_status_check` |
| TR-06 | — | The two suites that apply migrations to a real PGlite database and include 016, 017 or 021: `eventStatusLifecycleDatabase.test.js`, `eventClarificationDatabase.test.js` | Each also applies 041, after 040, so its database is the one production will have | Proved (pglite), by setup: both suites apply 041 last, so every case in them runs on it |
| TR-07 | — | The two text tests that read every migration: `draftToSubmittedSinglePath.test.js`, `eventStatusHistoryMigration.test.js` | Their expectations change to include 041 (see *Existing tests this story must change*). `venueSetupTimeMigration.test.js` needs nothing: its mention of 021 is in a fixed list of 018 to 022 about the venue functions, not the status history | Proved (mig): both text tests' expectations include 041 (SCRUM-515) |

**Two kinds of suite, and why a text test can break without being wrong.** A PGlite
suite applies the migrations to a real database, so it needs 041 in its list to
test the database production will have; leave it out and it goes on passing
against the old behaviour, which is the dangerous case. A text test reads the
migration files and pins a fact about them, such as "only 016 and 021 set
`status = 'submitted'`". Both of these scan every migration with `readdirSync`,
so they pick 041 up on their own, and the moment 041 adds a third definition of
`submit_event_request` the fact they pin stops being true. That failure is the
test working: it was written to notice exactly a new writer of the status, and the
fix is to add 041 to its expectation, with the reason, not to loosen it.

---

## Existing tests this story must change

Each was right when written: it pinned SCRUM-327's requirement, which the customer
has since changed (Week 7, change 5). They are updated to the new requirement, not
deleted to make room.

| Test | File | Why it changes |
|---|---|---|
| `SCRUM330_AC5_refuses_when_no_coordinator_is_available` | svc | Pins the P0001 → 503 refusal. AC11 removes it: submission no longer looks for a coordinator. Its replacement is AC11-03. **Done in SCRUM-515:** now `SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503` |
| `SCRUM330_AC1_assigns_a_coordinator_on_submission` | svc | Its assertions (one read, one rpc, three arguments, nothing naming a coordinator) still hold; its name and comment ("the function does [choose one]") become false. Renamed, and the fixture's returned row has no coordinator. **Done in SCRUM-522:** now `SCRUM330_AC1_submits_through_one_call_that_names_no_coordinator` |
| `SCRUM330_AC1_returns_the_assigned_coordinator_in_camelCase` | svc | The mapping still holds; the fixture and name assume a coordinator on every submitted row. **Done in SCRUM-522:** now `SCRUM330_AC1_returns_the_submitted_request_in_camelCase_with_no_coordinator` |
| `SCRUM330_AC1_never_assigns_a_coordinator_to_an_incomplete_draft` | svc | Still true, trivially; renamed to what it proves, that an incomplete draft is not submitted. **Done in SCRUM-522:** now `SCRUM330_AC1_never_submits_an_incomplete_draft` |
| The other `SCRUM330_AC1_*` (submits only through the function, leaves the draft check to the function, translates a vanished request, reports a non-draft as a conflict, treats a missing time as a server fault) | svc | Unchanged: none asserts anything about the coordinator |
| `SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over` | svc, route | Still true for another coordinator, but no longer the whole rule: a Lead may too (AC6). Renamed and extended by AC6-02 and AC6-04. **Done in SCRUM-521:** now `SCRUM331_AC6_a_caller_who_neither_holds_the_event_nor_leads_is_refused` (svc) and `SCRUM331_AC6_a_coordinator_who_does_not_hold_the_event_cannot_hand_it_over` (route), with 041's message |
| `SCRUM334_AC9_lists_every_event_coordinator`, `SCRUM334_AC9_returns_each_coordinator_as_an_id_and_a_name` | svc | AC3 adds each coordinator's active-event count to the list. **Did not change:** SCRUM-519 gave the Lead a read of its own (`listCoordinatorWorkload`, `GET /coordinator-workload`) rather than widening this one, so both tests still pin SCRUM-334's list as it was (open question 1 below, answered) |
| `SCRUM325_refuses_the_submission_when_no_coordinator_exists_and_leaves_the_draft_alone` | pglite | Pins P0001 with no coordinator. Reverses: AC11-02. **Done in SCRUM-515:** now `SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists` |
| `SCRUM325_assigns_exactly_one_coordinator_and_records_one_row_in_each_history` | pglite | Reverses: AC1-01 (no coordinator, no assignment row). **Done in SCRUM-515:** now `SCRUM486_AC1_submits_with_no_coordinator_even_when_coordinators_exist` |
| `SCRUM325_refuses_a_second_submission_and_adds_no_assignment_and_no_history` | pglite | The 55000 holds; its assertion that the coordinator and the one assignment row are kept assumes the first submission assigned |
| `SCRUM325_gives_no_other_way_to_submit_without_a_coordinator` | pglite | Pins the constraint TR-01 relaxes. Reverses |
| `SCRUM318_lets_the_reopened_draft_be_submitted_again_through_the_one_submission_path` | pglite | Asserts the resubmitted request is given a coordinator again. Reverses: TR-02 |
| `sets status = 'submitted' only in the two definitions of submit_event_request`; `chooses the coordinator once, with the one selection rule`; `sets status, submitted_at and the coordinator in one statement`; `writes the assignment history once, after the update, in the same function`; `stops before writing when no coordinator is available`; `is backed by the constraint that refuses a submitted request with no coordinator` | `backend/tests/db/draftToSubmittedSinglePath.test.js` | They read 016's and 021's text and pin assignment on submission. 041 adds a third definition, without a selection, and relaxes the constraint |
| `has no other writer in any migration` | `backend/tests/db/eventStatusHistoryMigration.test.js` | Lists the files whose functions write the status history (`021_event_status_history.sql: 2`, `022_event_status_transitions.sql: 1`, `029_event_request_decisions_functions.sql: 2`). 041 redefines `submit_event_request` and `start_event_review`, both of which write a history row, so 041 joins the list with its count. Right when written: it pinned every writer there was |
| `SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing` (its `GET /coordinators` rows) | route | Asserts a Lead is refused the coordinator list. If the picker reads that route, this row changes (open question 1) |
| `SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard`, `SCRUM485_AC3_the_%s_dashboard_calls_no_service`, `SCRUM485_AC3_the_%s_dashboard_has_no_link_to_a_page_that_does_not_exist` | `frontend/tests/components/Dashboard.test.jsx` | They pin the Lead's dashboard as a placeholder that fetches nothing. The queue makes it real (AC2-07), for the Lead only; the Safety Officer's cases stand |
| `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_link` | `frontend/tests/components/Navigation.test.jsx` | Pins one link. Changes if the queue gets a route and a link of its own; SCRUM-485's design said the count case would force exactly this update. **Done in SCRUM-519:** now `SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_and_unassigned_queue_links` |
| Sections 1 and 2 of `check-coordinator-assignment.js` (the selection rule; assignment on submission), and section 4's "previous coordinator can no longer hand it over" | live | Sections 1 and 2 test what this story removes. Section 4's refusal of the outgoing coordinator still holds, but needs a Lead case beside it |

---

## What cannot be tested as written

- **Two simultaneous assignments in CI** (AC4-05). PGlite runs one query at a
  time, so it proves the second, later assignment is refused (AC4-02), not that
  two real connections take turns on the row lock. Only the live script can.
- **AC5's Safety review and Safety approved** (AC5-03). Neither is a value of
  `event_request_status`, nor of `domain/eventRequestStatus.js`. The only mention
  in the code is 037's comparison of `status::text` with those strings, which can
  never match. They presumably arrive with the Safety Officer's review
  (SCRUM-490). Until then the case cannot be written; when they exist, both must
  be added to 018's status list.
- **Delivery of a notice beyond the table.** The cases prove a row is written; that
  a person is told is the screen's job (AC10-06), and there is no email.

---

## Open questions for the team

1. **Which route does the Lead's picker read?** `GET /api/event-requests/coordinators`
   is behind `coordinatorOnly`, and SCRUM-485's
   `SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing` asserts a Lead is
   refused it. Opening it to the Lead changes that test and SCRUM-485's case
   AC5-09; a route of the Lead's own, which also carries AC3's counts, changes
   nothing of SCRUM-485's.
2. **How does the Lead "review basic event information"?** The customer's words
   say the Lead can. The coordinator's read, `GET /:id/review`, and the history,
   `GET /:id/assignments/review`, are both `coordinatorOnly`, so a Lead is refused
   both today. AC2's queue rows carry the basics; whether the Lead also opens the
   full event, and its history, is a decision this story has to make.
3. **What counts as an "active event"** in AC3's count? 015's selection rule
   counted submitted, under review, pending clarification, approved, planning and
   confirmed; 020 removed planning. SCRUM-327 AC2 named five statuses. The count
   needs one definition, stated once.
4. **Should `pick_event_coordinator` be dropped?** After this story nothing calls
   it but the live check script. Leaving it means a function that implements
   SCRUM-327 AC2 to AC4, which are superseded; dropping it means the check
   script's section 1 goes too.
5. **Does the previous coordinator hear about a reassignment?** AC10 names the new
   coordinator and the organiser. A coordinator whose event the Lead moves away
   is not mentioned.
6. **Does a resubmission need a history row?** TR-02 clears the coordinator, but
   the history table cannot record "back to nobody" (`new_coordinator_id` is not
   null). So the history will read A, then later "Assigned to B", with nothing
   between. TR-03 makes the screen honest; whether the record should say more is
   open.
7. **Does AC9's "the organiser and the assigned coordinator" narrow who sees the
   history?** Today every coordinator can read it (SCRUM-334 AC9), and the Lead
   cannot (open question 2). The cases above keep every coordinator's view, since
   nothing in AC9 says to remove it.

---

## Case ownership

| Cases | Subtask |
|---|---|
| This document | SCRUM-514 |
| Every test named here | SCRUM-522 |
| The implementation | The SCRUM-486 subtasks between them |

**Tally:** 71 cases (64 under the criteria, 7 traps), counted from the tables.
After SCRUM-522: **66 proved**; **5 not**. After SCRUM-523: **67 proved**; **4 not**,
each marked in its row and listed here. AC1-06 was the fifth: SCRUM-522 found the
Organiser's row could not name the coordinator, and SCRUM-523 added the name to
the Organiser's list.

- **AC4-05**, written, not run: the real race is in the live script.
- **AC5-03**, cannot be written: the safety statuses do not exist yet.
- **AC8-05**, met differently: one 409 message names both causes.
- **AC10-06**, unmet: the new notices are not yet worded (SCRUM-172).

Three were proved at a different layer than planned, each with its reason in
its row: AC2-03 and AC2-06's pglite halves (the reads are PostgREST queries),
and AC3-06's pglite half (in the live script).

| Section | Cases |
|---|---|
| AC1 | 6 |
| AC2 | 8 |
| AC3 | 7 |
| AC4 | 5 |
| AC5 | 5 |
| AC6 | 6 |
| AC7 | 6 |
| AC8 | 5 |
| AC9 | 6 |
| AC10 | 7 |
| AC11 | 3 |
| Traps (TR) | 7 |

By where each is proved: **40 need PGlite**, by themselves or beside another
layer; **17** use a fake client alone (svc, route); **1** is a text test alone
(TR-07); the rest are the screen, or the live database. AC4-05 is the one case
only the live database can prove.
