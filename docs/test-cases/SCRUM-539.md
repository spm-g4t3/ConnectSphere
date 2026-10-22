# SCRUM-539 — Test Cases

**Story:** A request waiting in the Lead's unassigned queue can be cancelled by nobody (Task, E3) — Event Coordinator Lead
**Subtask:** SCRUM-576 (this document)
**Schema:** `013_lead_cancels_unassigned_request.sql` (SCRUM-577), on top of the baseline (`backend/db/baseline/09_event_workflows.sql`'s `cancel_event_request`) and 011's `event_cancellation_impact_preview`.
**Written:** 22 October 2026, **before the code.** Every case describes what will be built. None is implemented yet; each **Implemented by** says so, and the subtask that writes its tests fills it in.
**Marked:** 22 October 2026, SCRUM-577 and SCRUM-578: every case their tests prove names them. The cases themselves are unchanged.
**Marked:** 22 October 2026: the migration is 013, not 012; SCRUM-575 (PR #79) took 012 first.
**Marked:** 23 October 2026, SCRUM-579 and SCRUM-580: the screen's cases (AC2-03, AC4-06); every case is now proved.

This document is the written layer between SCRUM-539's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**. It is also where this story's decisions are
argued, with the alternatives rejected: the code's comments say why in a line or
two and point here (AGENTS.md).

---

## How case IDs relate to test names

Each case has a short stable ID (`AC3-01`) and an **Implemented by** column naming
every test that proves it. New tests are named `SCRUM539_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum539LeadCancelDatabase.test.js` | What the database does, on the full schema (`createSchemaDb()`): who may cancel and preview what, what is written, released and notified, and that a refusal changes nothing |
| route | `backend/tests/routes/scrum539LeadCancelRoutes.test.js` (fake client) | The gates on `POST /:id/cancel` and `GET /:id/cancellation-impact`, the caller from the token, the status each refusal arrives as |
| existing | the cancel suites named in AC6-01 | That the coordinator's path is unchanged |
| screen | `frontend/tests/components/scrum539LeadCancelPanel.test.jsx`; the `SCRUM539_AC2` block in `UnassignedQueue.test.jsx`; one test in `EventCancellationPanel.test.jsx` | The Lead's cancel on the unassigned queue, and the coordinator's form unchanged (SCRUM-579) |

Which subtask writes each: SCRUM-577 (every pglite case), SCRUM-578 (every route
case), SCRUM-579 (every screen case), SCRUM-580 (anything still open, the teeth
checks).

---

## The story

> **USER STORY:** As the Event Coordinator Lead, I want to cancel a submitted
> request that no coordinator holds yet, so that a request the Organiser no longer
> needs does not sit in the unassigned queue with nobody able to close it.

### Acceptance criteria

From the ticket, in substance.

1. The Lead can cancel a request that is Submitted and has no coordinator. A
   non-blank reason and an initiator (the organiser's request, or ConnectSphere's
   decision) are required. The request becomes Cancelled. The reason, initiator,
   the Lead as the person who cancelled it, and the date and time are recorded, and
   the status history names the Lead.
2. The request leaves the unassigned queue, and the Event Organiser is notified
   with the reason.
3. The Lead cannot cancel an event that has a coordinator. The attempt is refused
   and nothing changes (SCRUM-487 AC5; the assigned coordinator cancels held
   events).
4. Nobody but a Lead can cancel an unassigned request. A coordinator is told the
   request is waiting for the Event Coordinator Lead, not that it belongs to
   another coordinator.
5. A cancellation that races an assignment has exactly one winner. The loser is
   refused and nothing is half-done.
6. The assigned coordinator's cancellation (SCRUM-370, SCRUM-561) is unchanged.
7. A refused attempt leaves all data unchanged.

---

## Case tables

### AC1 — the Lead cancels a submitted request nobody holds

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 **(trap)** | Submitted, no coordinator | A Lead cancels with "  Organiser no longer needs it  " and an initiator | Cancelled; the reason trimmed; the initiator stored; `cancelled_by` the Lead; `cancelled_at` set; one status-history row submitted → cancelled, `changed_by` the Lead, the reason as its reason | Proved (pglite): `SCRUM539_AC1_a_lead_cancels_and_is_recorded_as_the_canceller_with_one_history_row` |
| AC1-02 | The same | The reason is blank | 22023 (400); nothing changes | Proved (pglite): `SCRUM539_AC1_a_blank_reason_is_refused_with_22023_and_nothing_changes` |
| AC1-03 | The same | No initiator | Refused (the existing null check); nothing changes | Proved (pglite): `SCRUM539_AC1_no_initiator_is_refused_and_nothing_changes` (22004, the existing null check) |
| AC1-04 **(trap)** | An approved event with a pending and an approved booking, an active hold and an equipment request, sent back to the Lead's queue by rejecting, reopening and resubmitting it (`returnToLeadQueue`) | A Lead cancels it | The pending booking withdrawn, the approved one cancelled, the hold released with `released_by` the Lead, the equipment request cancelled; Venue Staff and Technical Support told, as on the coordinator's path. "An unassigned request has nothing to release" is false | Proved (pglite): `SCRUM539_AC1_a_lead_cancel_releases_the_bookings_hold_and_equipment_and_tells_their_staff` |
| AC1-05 | As AC1-04 | A Lead previews the cancellation | The preview lists its bookings, requests, hold and equipment, as it does for a coordinator | Proved (pglite): `SCRUM539_AC1_a_lead_previews_what_cancelling_an_unassigned_request_releases` |
| AC1-06 | The same, through the API | The Lead's id is the token's, never the body's | The function gets the token's user | Proved (route): `SCRUM539_AC1_a_lead_cancels_and_the_caller_comes_from_the_token` |
| AC1-07 | The same, through the API | A Lead previews | The route reaches the function with the Lead as caller | Proved (route): `SCRUM539_AC1_a_lead_reaches_the_preview` |

### AC2 — the queue and the Organiser

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | After AC1-01 | Read the Organiser's notices | Exactly one `event_cancelled`, audience organiser, with the reason | Proved (pglite): `SCRUM539_AC2_the_organiser_gets_exactly_one_notice_with_the_reason` |
| AC2-02 | After AC1-01 | Read the unassigned queue | The request is not in it: the queue lists `submitted` with no coordinator, and it is now `cancelled` | Proved (pglite): `SCRUM539_AC2_the_cancelled_request_leaves_the_unassigned_queue` (the queue's own filter, asked of the table) |
| AC2-03 | The unassigned queue screen | The Lead cancels from a row | The row leaves the list | Proved (screen): `SCRUM539_AC2_a_cancel_returns_to_the_queue_says_so_and_the_row_is_gone`, `SCRUM539_AC2_cancel_request_opens_the_cancel_form_for_that_row`, `SCRUM539_AC1_every_row_offers_cancel_beside_assign` (`UnassignedQueue.test.jsx`) |

### AC3 — the Lead never cancels a held event

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 **(trap)** | Held by a coordinator: Approved; Under review | A Lead cancels | 42501 (403), the message saying the assigned coordinator cancels it and the Lead cancels only requests nobody holds; nothing changes | Proved (pglite): `SCRUM539_AC3_a_lead_is_refused_a_held_%s_event_with_42501_and_nothing_changes` (approved, under review) |
| AC3-02 | The same | A Lead previews | 42501 (403) | Proved (pglite): `SCRUM539_AC3_a_lead_is_refused_the_preview_of_a_held_event_with_42501`; (route) `SCRUM539_AC3_a_lead_previewing_a_held_event_is_answered_403_by_the_function` |
| AC3-03 | Through the API | A Lead's cancel of a held event | The route lets the Lead through; the function's 42501 arrives as 403 | Proved (route): `SCRUM539_AC3_a_lead_reaches_cancel_and_the_database_refuses_a_held_event_with_403` |

### AC4 — nobody but a Lead cancels an unassigned request

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 **(trap)** | Submitted, no coordinator | A coordinator cancels | 55000 (409), the message naming the Event Coordinator Lead, without "only the coordinator assigned"; nothing changes | Proved (pglite): `SCRUM539_AC4_a_coordinator_is_told_the_request_waits_for_the_lead_with_55000` |
| AC4-02 | The same | A coordinator previews | 42501 (403), the preview's existing wording | Proved (pglite): `SCRUM539_AC4_a_coordinator_is_refused_the_preview_of_an_unassigned_request_with_42501` |
| AC4-03 | Through the API | An Organiser, Venue Staff, Technical Support, a Safety Officer, an Attendee call `POST /:id/cancel` | 403 at the route, nothing queried | Proved (route): `SCRUM539_AC4_%s_is_refused_with_403_and_queries_nothing` (both routes) |
| AC4-04 | Submitted, no coordinator; and a held event | A null caller; a user with no profile | Null: the existing null check. No profile: 55000 on the unassigned request (not a Lead), 42501 on the held one. Nothing changes | Proved (pglite): `SCRUM539_AC4_a_null_caller_is_refused_by_the_existing_null_check`, `SCRUM539_AC4_a_user_with_no_profile_is_refused_%s` |
| AC4-05 | A draft (no coordinator, not submitted) | A Lead cancels | 42501; nothing changes. A draft is still the Organiser's (the SCRUM-19 AC1-03 precedent `start_event_review` cites) | Proved (pglite): `SCRUM539_AC4_a_lead_is_refused_a_draft_with_42501` |
| AC4-06 | The coordinator's event screen | — | Its cancel is unchanged | Proved (screen): `SCRUM539_AC4_the_coordinators_cancel_form_keeps_its_403_text` (`EventCancellationPanel.test.jsx`, added: no earlier test pinned the 403 text); the file's other tests and `scrum487LeadReadOnly.test.jsx` pass unmodified |
| AC4-07 | Through the API | A coordinator's cancel of an unassigned request | The function's 55000 arrives as 409 | Proved (route): `SCRUM539_AC4_a_coordinator_on_an_unassigned_request_gets_409` |

### AC5 — a cancellation and an assignment: one winner

PGlite has one connection, so the two transactions never overlap here: each race
is its two orders run in sequence, as SCRUM-486 D13 did. Under the row lock both
functions take, the second always meets the first's result.

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 **(trap)** | Submitted, no coordinator | Another Lead assigns it, then the first Lead's cancel runs | The cancel refused with AC3-01's 42501; the assignment stands | Proved (pglite): `SCRUM539_AC5_assigned_first_the_lead_cancel_is_refused_and_the_assignment_stands` |
| AC5-02 | The same | A Lead cancels it, then another Lead's assign runs | The assign refused 55000 (409): not submitted; the cancellation stands | Proved (pglite): `SCRUM539_AC5_cancelled_first_the_assignment_is_refused_with_55000_and_the_cancel_stands` |
| AC5-03 **(trap)** | The same | Two Leads cancel it | The second refused with 55000 (409), "cannot be cancelled", not 403; one history row, one Organiser notice | Proved (pglite): `SCRUM539_AC5_a_second_lead_cancel_is_refused_with_55000_not_403` |

### AC6 — the coordinator's cancellation is unchanged

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | — | Every existing test in the cancel suites (`cancelEventRequestDatabase`, `eventCancellationImpactPreviewDatabase`, the SCRUM-370 HTTP block in `eventRequests.test.js`, `scrum487CoordinatorOverviewRoutes`, `eventCancellationService`) | Passes unmodified, except the one SCRUM-487 row moved by design in SCRUM-578 | Proved (existing): every test in `cancelEventRequestDatabase`, `eventCancellationImpactPreviewDatabase`, `cancelEventReleasesReservationsDatabase`, `cancelConflictingBookingRequestDatabase`, `bookingDecisionsAfterSafetyReviewDatabase`, `scrum561SafetyCancelNotificationDatabase`, `eventRequests.test.js`, `eventCancellationService.test.js` passes unmodified; in `scrum487CoordinatorOverviewRoutes.test.js` only the `POST /:id/cancel` row moved, to AC3-03 |
| AC6-02 | An approved event held by a coordinator | The coordinator cancels | Unchanged: `cancelled_by` the coordinator; a stale holder (the event handed over under them) still refused by the expected-coordinator guard | Proved (pglite): `SCRUM539_AC6_the_assigned_coordinator_still_cancels_their_held_event`, `SCRUM539_AC6_a_coordinator_who_no_longer_holds_the_event_is_still_refused` |

### AC7 — a refusal changes nothing

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 **(trap)** | Every refusal above | Count before and after | Status, status history, cancellation columns, notifications, bookings and holds unchanged | Proved (pglite): every refusal above compares a snapshot of the status, history, cancellation columns, notifications, bookings and holds before and after |
| AC7-02 | 013 applied | The grants | `cancel_event_request` and `event_cancellation_impact_preview` stay non-executable by anon and authenticated | Proved (pglite): `SCRUM539_AC7_cancel_and_preview_stay_closed_to_the_client_roles` |

---

## Design decisions

### D1. Widen `cancel_event_request`; don't add a Lead function

One path, so the status change, the record, the release and the notices cannot
drift between two copies. SCRUM-486 widened `reassign_event_request` the same way
for the Lead's handover.

*Rejected: a `lead_cancel_event_request`.* A second copy of the release and notice
logic, which SCRUM-571 would then have to change twice.

### D2. The outgoing holder is the expected coordinator

`change_event_request_status` is passed `v_request.assigned_coordinator_id`, read
under the lock, as its sixth argument. That is null on the Lead's path, so the
guard is skipped while the lock holds the row; on the coordinator's path it is the
caller, as before. *Rejected: passing the Lead*: every Lead cancel would trip
40001, since the Lead is never the assigned coordinator. *Rejected: passing null
always*: it drops the guard from the coordinator's path.

### D3. Only Submitted and unassigned

`event_requests_assigned_when_submitted` (baseline `02_event_requests.sql:51`)
admits no coordinator only in draft, submitted and cancelled. So the only
cancellable status a request nobody holds can be in is submitted. The Lead never
cancels a held event (SCRUM-487 AC5; Week 9 Q&A row 16).

### D4. The refusal says the right reason

A coordinator on an unassigned request is told it waits for the Lead (55000, 409),
as `start_event_review` tells them since SCRUM-486 AC8, not "only the coordinator
assigned … can cancel it", which would say it is someone else's when it is
nobody's. A Lead on a held event is told the holder cancels it. *Rejected: one
42501 for everything*: true, but it sends the reader to the wrong person.

### D5. Widen the routes; don't add new ones

`POST /:id/cancel` and `GET /:id/cancellation-impact` become `coordinatorOrLead`,
and the database decides who may act on which event, as `POST /:id/reassign`
(SCRUM-519) does. *Rejected: Lead-only routes*: two routes to the same function.

### D6. The Lead gets the preview, on the same rule

AC1-04's request still holds bookings and a hold; cancelling it releases them. The
Lead previews what will be released, as a coordinator does. *Rejected: no preview
for the Lead*: they would release bookings blind.

### D7. The Lead's form sits on the unassigned queue

Each queue row's "Cancel request" opens `UnassignedRequestCancelPanel` in place of
the list, as Assign opens its picker, and a cancel returns to the queue, re-read,
with the row gone. The form is the coordinator's (reason, initiator, preview,
confirmation) less the attendee message: a request nobody holds has no attendees
to tell, so none is sent. Its errors are keyed on status: 403 and 409 say the
request was assigned or cancelled since the Lead opened it (AC5). *Rejected:
opening the coordinator's event screen*: the Lead would land on a screen built for
the holder, whose cancel is hidden from them (SCRUM-487).

### D8. The notices are the existing ones

The Organiser, and the staff whose arrangements are released, as on the
coordinator's path. No notice to other Leads. *Rejected: telling every Lead*: no
source asks for it.

### D9. Organiser self-withdrawal (SCRUM-427) is not built

Organisers request withdrawal through ConnectSphere (Week 4 clarification; Week 9
Q&A row 11), which is what the initiator "the organiser's request" records.

---

## What cannot be tested as written

- **AC5's races as true races.** PGlite is one connection; each is its two orders
  run in sequence. The row lock both functions take is the argument.

---

## Tally

27 cases, counted from the tables: 0 proved; 27 not yet implemented (two of them,
AC2-03 and AC4-06, for SCRUM-579); 0 that cannot be written as specified. Seven are
traps. After SCRUM-577 and SCRUM-578: **25 proved**; 2 not yet implemented (AC2-03,
AC4-06, the screen, SCRUM-579); 0 that cannot be written. After SCRUM-579 and
SCRUM-580: **27 of 27 proved**; 0 not yet implemented; 0 that cannot be written.

| Section | Cases |
|---|---|
| AC1 | 7 |
| AC2 | 3 |
| AC3 | 3 |
| AC4 | 7 |
| AC5 | 3 |
| AC6 | 2 |
| AC7 | 2 |
