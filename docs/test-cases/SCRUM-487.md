# SCRUM-487 — Test Cases

**Story:** View Every Coordinator's Events — Event Coordinator Lead
**Subtask:** SCRUM-540 (this document)
**Schema:** no migration. Everything here reads tables and functions that exist after `052_lead_assignment.sql` (SCRUM-486).
**Written:** 13 October 2026, **before the code.** Every case describes what will be built. None is implemented yet; each **Implemented by** says so, and the subtask that writes its tests fills it in.
**Marked:** 13 October 2026, SCRUM-541: AC1-01 to AC1-03 and AC2-01 to AC2-11 name their tests; SCRUM-542: AC1-04 and AC3-01 to AC3-16. The cases themselves are unchanged.

This document is the written layer between SCRUM-487's acceptance criteria and the
Vitest files that will implement them. Deliverable #3 requires test cases
traceable from user stories and acceptance criteria to tests; the chain is
**user story → acceptance criteria → test case → test class → code**, and it is
walked for a randomly chosen feature in the Week 13 Q&A.

This story extends what SCRUM-486 built for the Lead, so much of its argument is
about what it does *not* rebuild. Section *Design decisions* is that argument.

---

## How case IDs relate to test names

As in `docs/test-cases/SCRUM-486.md`: each case has a short stable ID (`AC3-02`)
and an **Implemented by** column, which will name every test that proves the
case, read from the test files. New tests are named `SCRUM487_ACn_…`, where `n` is
the acceptance criterion. A case already proved by a SCRUM-486 test says so in
its expected result, and keeps that test's name when it is marked; this story
does not rename another story's tests to claim them. A case not yet proved says
so in bold.

The traps the brief named are cases under the criterion they belong to, marked
**(trap)**: they are the places this story breaks if nobody tests them.

| Short | File | Proves |
|---|---|---|
| svc | `backend/tests/services/` (fake client) | Which rows the service asks for, with which filters, what it refuses before asking, and the shape it returns |
| route | `backend/tests/routes/` (fake client) | Gates, status codes, query parameters reaching the service, declaration order |
| pglite | a PGlite suite with the real migrations (`backend/tests/db/`) | What the database itself does: who may reassign, and that nothing else moves |
| screen | `frontend/tests/components/` | What the Lead sees and can click |
| nav | `frontend/tests/components/Navigation.test.jsx` | Who is offered the link |

Which subtask writes each: SCRUM-541 (AC2's service and route), SCRUM-542 (AC3's
service and route), SCRUM-543 (AC4), SCRUM-544 (every screen and nav case),
SCRUM-545 (AC5 and AC6), SCRUM-546 (any case still open at the end).

---

## The story

> **USER STORY:** As the Event Coordinator Lead, I want to see every coordinator's
> events and workload, so that I can balance the work and step in when a
> coordinator is away.

### Acceptance criteria

Quoted from the ticket.

1. Only the Lead can open the view. Any other user is refused.
2. It lists every Event Coordinator with their number of active events and the
   count in each status. Active means Submitted, Under review, Pending
   clarification, Approved, Safety review, Safety approved or Confirmed.
3. It lists all active events across coordinators, earliest event first, showing
   the event name, the organiser, the status, the coordinator and the start date.
   The list can be filtered by coordinator and by status. Completed, Rejected and
   Cancelled events are hidden unless the Lead asks to include them.

   _The unfiltered list was built in SCRUM-486 (AC6, 12 October); this story adds
   the filters, the counts and the option to include finished events._
4. Unassigned requests are counted at the top, with a link to the queue
   (SCRUM-486).
5. The Lead can open any event read-only: its details, its clarification history
   and its assignment history with the handover notes. The Lead cannot start a
   review, decide, confirm or cancel.
6. From this view the Lead can reassign an event (SCRUM-486). An event whose
   coordinator is absent is reassigned without that coordinator doing anything.

### Design decisions, from the ticket

- **The Lead can see everything and change only the assignment.** Everyone with a
  coordinator-level role can already view any event (SCRUM-332), so this adds the
  whole picture and the one action.
- **The Lead reads handover notes.** They are written for coordinators, and the
  Lead is one. Team decision, to confirm. (D6 below.)

---

## Design decisions

Each is argued, with the alternative it rejects.

### D1. Extend SCRUM-486's list, don't rebuild it

SCRUM-486 built the unfiltered list of every held active event for the Lead,
`listAssignedEventsForLead` behind `GET /event-requests/assigned`, shown by
`AssignedEvents.jsx` at `/assigned-events`, so that a Lead could reach an event
to hand over by clicking. Its D12 (revised, `docs/SCRUM-486.md`) built it as the
first slice of this story's AC3 list and said this story "extends it rather than
replaces it"; AC3's own note says the same. So the filters, the finished-events
option and the counts are added to that read and that route, and called with no
options they behave exactly as SCRUM-486 left them.

*Rejected: a new overview page with its own read.* The Lead would have two lists
of the same events, built twice, able to disagree about which events are active,
and SCRUM-486's AC6 cases would prove a list nobody uses.

### D2. Filters run on the server

`coordinatorId`, `status` and `includeFinished` are query parameters of `GET
/assigned`, applied in the query. Active events are bounded; finished events are
not: every event that ever completes, is rejected or is cancelled stays one for
good. Filtering in the browser would mean fetching every finished event just to
hide most of them, on every load, and the list would grow slower for ever.

*Rejected: fetch everything once and filter in the browser.* Fine for twenty
events, wrong for a list that only grows, and it would send finished events to
the browser when the Lead has not asked for them.

### D3. Per-status counts are a new Lead-only read that shares its counting with the picker

`listCoordinatorOverview` behind `GET /event-requests/coordinator-overview`
returns `{ id, fullName, activeEvents, byStatus }` per coordinator. It counts
through the same internal helper as `listCoordinatorWorkload` (the assignment
picker's read, SCRUM-486 AC3): the same coordinators (role `event_coordinator`,
by name then id) and the same events (held, in `ACTIVE_EVENT_STATUSES`). So "N
active events" beside a name in the picker and that coordinator's total in the
overview are one count, and cannot drift apart.

*Rejected: add `byStatus` to `GET /coordinator-workload`.* SCRUM-486 pins that
response with an exact `toEqual` on purpose ("an extra key fails: no role, no
recommended"): the picker shows a name and a count and nothing that reads as a
suggestion. A per-status breakdown is the supervision view's, not the picker's,
and adding it there would mean loosening the test that guards that.

### D4. Safety review and Safety approved are not counted yet

AC2's definition of active names them, but they are not values of
`event_request_status` until SCRUM-488. Naming an unknown enum value in a
PostgREST `in` filter fails the whole read (Postgres rejects the literal with
22P02), so naming them now would break the overview, the list and the picker
together. `ACTIVE_EVENT_STATUSES` already says SCRUM-488 adds them there. The
counts, the list, the filter and `byStatus`'s keys are all built from that one
constant, so when 488 adds the two statuses, every one of them picks them up with
no change here.

So **AC2 and AC3 are partial until SCRUM-488**, and say so. This story does not
edit `ACTIVE_EVENT_STATUSES`; SCRUM-488 owns that line.

*Rejected: name them now.* It breaks every read that uses the constant, today.

### D5. Unassigned requests are counted, not listed

AC4 counts them at the top, with a link to the queue. The list stays held events
only (`assigned_coordinator_id` not null), as SCRUM-486 built it: the unassigned
queue is where an unassigned request is acted on, by assigning it, and an
unassigned row in the supervision list would offer nothing to do there. The count
reuses `GET /unassigned` (its length), so the number at the top and the queue it
links to are the same read.

*Rejected: list unassigned requests among the events, or add a count route.* The
first mixes two kinds of row with different actions; the second is a second
definition of "unassigned" beside the queue's.

### D6. The Lead reads handover notes, confirmed

The ticket asks the team to confirm it. It is built: SCRUM-521 put `GET
/:id/assignments/review` behind `coordinatorOrLead`, reading the history with
`includeNotes: true`, so the Lead's event page shows the notes. This story records
the decision as confirmed (Calven's brief, 13 October). The Organiser's history
route still never carries a note (SCRUM-486 AC9). Jira's "to confirm" should be
updated to match.

### D7. "Cannot confirm" holds because no confirm path exists

No API route moves an event to confirmed today: `changeEventRequestStatus` is
called by no route, and no migration's function sets `confirmed` from a request.
So there is nothing for a Lead to be refused. That is recorded under *What cannot
be tested as written*, not as a test that would prove the absence of a route.
When a confirm route is built, its story owns the case that the Lead is refused
it.

### D8. AC5's "cannot cancel" and SCRUM-539

SCRUM-539 (option 1) would let the Lead cancel an *unassigned* request, the
dead end SCRUM-486 found: nobody holds it, so nobody could cancel it. That does
not contradict AC5. Every event in this overview is held (D5), and AC5 is about
those: the Lead opens a held event and cannot cancel it, because `POST
/:id/cancel` is `coordinatorOnly` and 045 admits only the holder. An unassigned
request is in the queue, not here. No case is written for SCRUM-539; if it is
built, its own cases say what the Lead may cancel there.

---

## Case tables

### AC1 — only the Lead opens the view

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | LEAD | `GET /coordinator-overview` | 200, a bare array | Proved (route): `SCRUM487_AC2_a_lead_reads_every_coordinator_with_counts_per_status` |
| AC1-02 | COORD, ORG, venue staff, technical support, attendee, SAFETY, an account with no profile (role null) | `GET /coordinator-overview` | 403 from `leadOnly`, nothing queried | Proved (route): `SCRUM487_AC1_%s_is_refused_the_coordinator_overview_with_403_and_queries_nothing` |
| AC1-03 | No token | `GET /coordinator-overview` | 401, nothing queried | Proved (route): `SCRUM487_AC1_the_coordinator_overview_answers_401_without_a_token` |
| AC1-04 | COORD, ORG | `GET /assigned?coordinatorId=…&status=…&includeFinished=true` | 403, nothing queried: the filters do not widen the gate | Proved (route): `SCRUM487_AC1_%s_is_refused_the_filtered_list_with_403_and_queries_nothing`. Unfiltered: SCRUM-486's `SCRUM486_AC6_%s_is_refused_the_assigned_list_with_403_and_queries_nothing` |
| AC1-05 | COORD, ORG | Open the overview's address | Turned away by `ProtectedRoute` (`event_coordinator_lead` only) | **not yet implemented** (SCRUM-544) |
| AC1-06 | Every role | Render `Navigation` | Only the Lead is offered the overview | **not yet implemented** (SCRUM-544) |

### AC2 — every coordinator, with active events and the count in each status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | Coordinators A (Omar) and B (Priya); Omar holds more | `listCoordinatorOverview` | Every `event_coordinator`, by name then id, never by workload | Proved (svc): `SCRUM487_AC2_lists_every_coordinator_with_a_count_for_every_active_status`, `SCRUM487_AC2_reads_coordinators_by_name_and_only_their_active_events_with_status`, `SCRUM487_AC2_the_order_is_the_reads_never_the_workload` |
| AC2-02 | A holds one event in each active status | `listCoordinatorOverview` | `byStatus` has one key for every status in `ACTIVE_EVENT_STATUSES`, each counted | Proved (svc): `SCRUM487_AC2_lists_every_coordinator_with_a_count_for_every_active_status` |
| AC2-03 **(trap)** | B holds nothing | `listCoordinatorOverview` | B is listed, `activeEvents` 0 and 0 in every status; not left out | Proved (svc): `SCRUM487_AC2_lists_every_coordinator_with_a_count_for_every_active_status` |
| AC2-04 **(trap)** | Any | `listCoordinatorOverview` | Each coordinator's `activeEvents` equals the sum of their `byStatus` | Proved (svc): `SCRUM487_AC2_active_events_is_the_sum_of_by_status_and_the_pickers_count` |
| AC2-05 **(trap)** | The same coordinators and events | `listCoordinatorOverview` and `listCoordinatorWorkload` | Each coordinator's `activeEvents` is the same in both (D3) | Proved (svc): `SCRUM487_AC2_active_events_is_the_sum_of_by_status_and_the_pickers_count` |
| AC2-06 | — | The overview's event read | Narrowed to the coordinators read and to `ACTIVE_EVENT_STATUSES`: no draft or finished event is counted | Proved (svc): `SCRUM487_AC2_reads_coordinators_by_name_and_only_their_active_events_with_status` |
| AC2-07 | No coordinators | `listCoordinatorOverview` | `[]`, and the event read is skipped | Proved (svc): `SCRUM487_AC2_no_coordinators_is_an_empty_array_and_no_event_read` |
| AC2-08 | Either read fails | `listCoordinatorOverview` | The error through `translateError`, never an empty or zero-filled list | Proved (svc): `SCRUM487_AC2_a_failure_in_%s_is_an_error_not_a_zero_filled_list`, `SCRUM487_AC2_a_known_sqlstate_from_the_events_read_is_translated` |
| AC2-09 **(trap)** | — | `listCoordinatorWorkload` after the shared helper | Exactly `{ id, fullName, activeEvents }`, selecting only `assigned_coordinator_id`: SCRUM-486's AC3 tests pass unchanged | Proved (svc): SCRUM-486's `SCRUM486_AC3_lists_every_event_coordinator_with_their_active_count`, `SCRUM486_AC3_counts_only_the_active_statuses_of_the_coordinators_listed` and the rest of its AC3 block, unedited, passing after the shared helper |
| AC2-10 **(trap)** | LEAD | `GET /coordinator-overview` | Not read as an id: declared above `GET /:id` | Proved (route): `SCRUM487_AC2_does_not_read_the_coordinator_overview_path_as_a_request_id`. Moved below `/:id`, it and the gate tests fail |
| AC2-11 | A Lead exists | `listCoordinatorOverview` | No Lead listed: role `event_coordinator` only (a Lead cannot be assigned events) | Proved (svc): `SCRUM487_AC2_reads_coordinators_by_name_and_only_their_active_events_with_status` |
| AC2-12 | A holds a Safety review event | `listCoordinatorOverview` | Counted under `safety_review` | **Cannot be written yet** (D4): the status does not exist until SCRUM-488 |
| AC2-13 | LEAD; two coordinators | Open the overview | Each coordinator's name, total and per-status counts | **not yet implemented** (SCRUM-544) |

### AC3 — every active event, earliest first, filtered by coordinator and status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 **(trap)** | — | `listAssignedEventsForLead()` with no options | The same query and rows as SCRUM-486 AC6: `in` status `ACTIVE_EVENT_STATUSES`, held only, by `proposed_start` (nulls last) then id. SCRUM-486's AC6 tests pass unchanged | Proved (svc): `SCRUM487_AC3_with_no_options_the_read_is_scrum486s`; and SCRUM-486's `SCRUM486_AC6_…` service and route tests, unedited, passing |
| AC3-02 | — | `coordinatorId` A | Adds `eq assigned_coordinator_id A`; still held only | Proved (svc): `SCRUM487_AC3_a_coordinator_filter_adds_one_eq_on_the_coordinator` |
| AC3-03 | — | `status` `approved` | Adds `eq status approved` | Proved (svc): `SCRUM487_AC3_a_status_filter_narrows_the_read_to_that_status` |
| AC3-04 | — | `coordinatorId` A and `status` `approved` | Both, together | Proved (svc): `SCRUM487_AC3_coordinator_and_status_filters_combine` |
| AC3-05 | — | `includeFinished` true | The status set is `ACTIVE_EVENT_STATUSES` plus exactly completed, rejected and cancelled; never draft | Proved (svc): `SCRUM487_AC3_include_finished_adds_exactly_the_three_finished_statuses` |
| AC3-06 **(trap)** | Held events in every status, draft included | `includeFinished` false, then true | Off: completed, rejected and cancelled hidden. On: shown. Draft: never | Proved (svc): `SCRUM487_AC3_finished_events_are_hidden_unless_asked_for_and_a_draft_never_shows` |
| AC3-07 **(trap)** | — | `status` `completed`, `includeFinished` false | `[]`, and no query: a finished status asked for while finished events are hidden is an empty answer, not an error | Proved (svc): `SCRUM487_AC3_asking_for_%s_while_finished_events_are_hidden_is_empty_and_makes_no_query` |
| AC3-08 | — | `status` `completed`, `includeFinished` true | `eq status completed` | Proved (svc): `SCRUM487_AC3_a_finished_status_with_include_finished_is_read` |
| AC3-09 **(trap)** | — | `coordinatorId` not a uuid | 400 (`ValidationError`), no query | Proved (svc, route): `SCRUM487_AC3_%s_is_refused_with_400_before_any_query`, `SCRUM487_AC3_%s_is_400_and_queries_nothing` |
| AC3-10 **(trap)** | — | `status` `draft` | 400, no query: draft is a known status but never in this list | Proved (svc, route): `SCRUM487_AC3_%s_is_refused_with_400_before_any_query`, `SCRUM487_AC3_%s_is_400_and_queries_nothing` |
| AC3-11 **(trap)** | — | `status` `nonsense` | 400, no query | Proved (svc, route): `SCRUM487_AC3_%s_is_refused_with_400_before_any_query`, `SCRUM487_AC3_%s_is_400_and_queries_nothing` |
| AC3-12 **(trap)** | — | `includeFinished` not a boolean (service); `?includeFinished=yes` (route) | 400, no query: a stray value never silently means false | Proved (svc, route): `SCRUM487_AC3_%s_is_refused_with_400_before_any_query`, `SCRUM487_AC3_%s_is_400_and_queries_nothing` |
| AC3-13 | LEAD | `?includeFinished=true`, `=false`, absent | true, false, false | Proved (route): `SCRUM487_AC3_include_finished_%j_reads_its_statuses` |
| AC3-14 | LEAD | `GET /assigned?coordinatorId=A&status=approved` | The filters reach the query (the recorded `eq`s) | Proved (route): `SCRUM487_AC3_the_query_string_reaches_the_read` |
| AC3-15 | — | Any filter | The order is unchanged: `proposed_start` ascending, nulls last, then id | Proved (svc): `SCRUM487_AC3_coordinator_and_status_filters_combine`, `SCRUM487_AC3_include_finished_adds_exactly_the_three_finished_statuses` |
| AC3-16 **(trap)** | LEAD | `GET /assigned?…` | Not read as an id, with a query string too | Proved (route): `SCRUM487_AC3_the_query_string_reaches_the_read`. Unfiltered: SCRUM-486's `SCRUM486_AC6_does_not_read_the_assigned_path_as_a_request_id` |
| AC3-17 | LEAD | Choose a coordinator, a status, "include finished" on screen | The list is re-read with those parameters and shows only those rows | **not yet implemented** (SCRUM-544) |
| AC3-18 | A Safety approved event | Filter by `safety_approved` | Listed | **Cannot be written yet** (D4) |

### AC4 — unassigned requests counted at the top, with a link to the queue

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | Three UNASSIGNED requests | Open the overview | "3" at the top, from `GET /unassigned`'s length (D5) | **not yet implemented** (SCRUM-543) |
| AC4-02 | The same | Click the count's link | A router link to `/unassigned-queue` | **not yet implemented** (SCRUM-543) |
| AC4-03 | No UNASSIGNED request | Open the overview | Says none are waiting; the count is shown as 0, not hidden | **not yet implemented** (SCRUM-543) |
| AC4-04 | An UNASSIGNED request | Read the events list | Not in it: held events only. Already proved for the unfiltered list by SCRUM-486's `SCRUM486_AC6_the_assigned_list_leaves_out_the_unassigned_drafts_and_finished_events`; for the filtered list by AC3-02 to AC3-08 keeping the held filter | **not yet implemented** (SCRUM-542, SCRUM-543) |

### AC5 — the Lead opens any event read-only

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | HELD BY A | LEAD, `GET /:id/review` | 200, the full event. Already SCRUM-486's `SCRUM486_AC6_a_lead_who_holds_nothing_reads_%s` | **not yet implemented** (SCRUM-545) |
| AC5-02 | HELD BY A, with clarification history | LEAD reads the clarification history | Allowed (SCRUM-521's service check) | **not yet implemented** (SCRUM-545) |
| AC5-03 | HELD BY A, a handover with a note | LEAD, `GET /:id/assignments/review` | The history, with the note (D6). Already SCRUM-486's `SCRUM486_AC6_the_lead_reads_the_history_with_its_notes` | **not yet implemented** (SCRUM-545) |
| AC5-04 **(trap)** | HELD BY A | LEAD, `POST /:id/start-review` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-05 **(trap)** | HELD BY A, under review | LEAD, `POST /:id/decision` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-06 **(trap)** | HELD BY A | LEAD, `POST /:id/cancel` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-07 **(trap)** | HELD BY A, under review | LEAD, `POST /:id/clarification` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-08 **(trap)** | HELD BY A, pending clarification | LEAD, `POST /:id/clarification/close` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-09 **(trap)** | A pending change request on an event HELD BY A | LEAD, `POST /change-requests/:id/decision` | 403, nothing queried | **not yet implemented** (SCRUM-545) |
| AC5-10 | HELD BY A, open on the event page | As LEAD | No start-review, decide, cancel, clarification or change-request action; the hand-over action only | **not yet implemented** (SCRUM-545) |
| AC5-11 | — | LEAD confirms an event | **Cannot be tested as written** (D7): no confirm path exists | — |

### AC6 — the Lead reassigns from this view, without the holder

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | HELD BY A, in the overview | LEAD clicks the row's Open, then hands it to B | Reaches the event page by a router link; the hand-over is the SCRUM-486 one | **not yet implemented** (SCRUM-544, SCRUM-545) |
| AC6-02 **(trap)** | HELD BY A; A does nothing | LEAD reassigns to B | Allowed; history previous A, new B, `assigned_by` LEAD. No call by A at any point. Already SCRUM-486's `SCRUM486_AC6_a_lead_who_does_not_hold_the_event_reassigns_it` (pglite) | **not yet implemented** (SCRUM-545) |
| AC6-03 | After AC6-02 | Re-read the overview | A's counts down by one, B's up by one, in the event's status | **not yet implemented** (SCRUM-545) |
| AC6-04 | After AC6-02 | Re-read the list filtered by B | The event is listed under B, not under A | **not yet implemented** (SCRUM-545) |

---

## Open questions

1. **Does the coordinator filter accept an id that is not a coordinator?** A Lead's
   or an Organiser's id is a valid uuid, so it passes validation and the filter
   returns `[]`, since no event names them as coordinator. Proposed: that is the
   right answer (nothing held), not a 404, which would make the route an oracle for
   which ids are coordinators.
2. **Should the per-coordinator counts follow "include finished"?** AC2 counts
   active events only, and the counts sit beside the picker's, which are active
   only. Proposed: no; the finished option is the list's (AC3).
3. **One status at a time, or several?** AC3 says "by status". Proposed: one, as a
   single `status` parameter; several can be added without breaking it.
4. **D6's confirmation.** The ticket says "to confirm". This document records it as
   confirmed from Calven's brief; the Jira design decision should say so too.
5. **Safety statuses** (D4). AC2 and AC3 stay partial until SCRUM-488 adds them to
   `ACTIVE_EVENT_STATUSES`. Should `FINISHED_EVENT_STATUSES` be checked then too?
   Proposed: no change; safety statuses are active.

---

## What cannot be tested as written

- **AC5's "cannot confirm"** (D7): there is no route that confirms an event, so
  there is nothing to refuse.
- **AC2's and AC3's Safety review and Safety approved** (D4): the statuses do not
  exist until SCRUM-488 (AC2-12, AC3-18).
- **AC6's "absent"**: absence is not modelled anywhere; there is no "away" flag to
  set. What is testable, and tested, is the consequence AC6 names: the Lead
  reassigns with no action from the holder (AC6-02).

---

## Tally

56 cases, counted from the tables: 0 proved; 53 not yet implemented; 3 that cannot
be written as specified (AC2-12, AC3-18, AC5-11). After SCRUM-541: **14 proved**
(AC1-01 to AC1-03, AC2-01 to AC2-11); 39 not yet implemented; the same 3. After
SCRUM-542: **31 proved** (adding AC1-04 and AC3-01 to AC3-16); 22 not yet implemented;
the same 3.

| Section | Cases |
|---|---|
| AC1 | 6 |
| AC2 | 13 |
| AC3 | 18 |
| AC4 | 4 |
| AC5 | 11 |
| AC6 | 4 |
