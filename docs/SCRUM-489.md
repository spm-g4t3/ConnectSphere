# SCRUM-489 — Submit an Event for the Operational Safety Check

**Story:** Submit an Event for the Operational Safety Check — Event Coordinator
**Closing subtask:** SCRUM-560 (this document)
**Status as of 15 October 2026:** built and tested; seven criteria done and one partial until SCRUM-395 (section 1). The manual walkthrough (section 2) was run by Calven on 15 October and every check passed, check C on a retry after a fix to the live database.

This document is the record of what SCRUM-489 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for the submit.

The case-by-case mapping is `docs/test-cases/SCRUM-489.md`: 62 cases, each naming
the tests that prove it or saying in bold why none can be written. It also holds
the design decisions D1 to D15 in full. This document cites it rather than
repeating it.

**The short version, for anyone asked "what changed?":** the assigned coordinator
of an Approved event now sees a readiness checklist on the event's page: every
venue booking, every equipment request and the date, each Met or Outstanding. If
the organiser asked for equipment and none was requested, the coordinator
confirms that none is needed. They can add a note for the Safety Officer and
submit the event to Safety review. From then on the event's equipment is locked,
every Safety Officer is told, and the organiser sees "Safety check". The story
does not approve, confirm or cancel anything: approval is SCRUM-490's, confirm is
SCRUM-363's, and cancelling in a safety status is SCRUM-561's.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-554 | The test cases, written before any code: 56 cases across the eight criteria, twenty-four of them traps, and the design decisions D1 to D15 | `c81bfcb` |
| SCRUM-555 | The readiness check: `event_readiness` in migration 064 behind `GET /:id/readiness` (`coordinatorOrLead`) | `c81bfcb` |
| SCRUM-556 | The submit: `submit_event_for_safety_review`, the `safety_review_submissions` table, the `event_submitted_for_safety_review` notification type, the service and `POST /:id/safety-review` (`coordinatorOnly`) | `c81bfcb` |
| SCRUM-557 | The coordinator's `SafetyCheckSubmissionPanel`, its frontend calls, the notification's wording, the `SCRUM489_FILES` gate | `3678be4` |
| SCRUM-558 | AC7's equipment lock and AC8's organiser label proved from a real submission (tests only) | `3678be4` |
| Fix-up (AC8-07) | The Safety Officer dashboard mounts the notifications card; SCRUM-485's no-service test's last row moved to a test that pins the one read | `c9f6a70` |
| Fix-up (panel) | A 400 names the note only when its details say so; the checklist is a table | `adc91d1` |
| Merge of dev | SCRUM-300's reservations (PR #54: 053, 054, 055, 060, 061). No file overlapped; every 489 suite passed after it | `8f00f8a` |
| SCRUM-559 | The sweep: the suites after the merge, 064 against the migrations rules, the seam with SCRUM-300 (AC2-14, AC2-15), every cited name checked | uncommitted at writing |
| SCRUM-560 | This document | uncommitted at writing |

### Verification as of 15 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | 6043 passing across 127 files, after the merge of dev (5715 across 116 before it; the rest are SCRUM-300's suites and this story's seam suite) |
| Frontend suite (`npm run test:coverage` in `frontend`) | 2549 passing and 1 todo across 111 files, after the merge (2456 across 110 before it); every coverage gate met; `npm run lint` 0 errors, `npm run build` passes |
| SCRUM-489's gate | `SCRUM489_FILES` in `frontend/vite.config.js`: `SafetyCheckSubmissionPanel.jsx` at 100% statements, branches, functions and lines. `SafetyOfficerDashboard.jsx` stays at 100% in `SCRUM485_FILES` |
| SCRUM-489's own tests | 102 distinct `SCRUM489_…` titles (a parametrised test counts once): 57 in five backend files, 45 in five frontend files. Each file is a `scrum489…` file of its own except `Dashboard.test.jsx` (section 4) |
| PGlite | Three suites run 064 on a real Postgres: `scrum489SafetyReviewSubmissionDatabase.test.js` (readiness, the submit, its refusals and writes), `scrum489EquipmentLockDatabase.test.js` (AC7's lock, AC8's label), `scrum489EquipmentArrangedDatabase.test.js` (SCRUM-300's reservations loaded) |
| Live database | 064 was applied by Calven to the shared Supabase project. No live script was run by us; none covers the submit (section 4) |
| Test-case document | 62 cases: **61 proved**, **0 not yet implemented**, **1 that cannot be written as specified** (AC7-02, SCRUM-395's) |
| Manual walkthrough | Passed, checks A to I, 9 of 9, by Calven on 15 October 2026, against the shared Supabase project (section 2). Check C failed first with a 400 caused on the live database, and passed on a retry once the live list was fixed |

---

## 1. Acceptance criteria

| AC | Criterion (quoted) | Status |
|---|---|---|
| AC1 | Only the assigned coordinator can submit an event for the safety check, and only while it is Approved. Anyone else is refused, and so is any other status, with a message stating the status. | **Done** |
| AC2 | Submission requires all of these, using the same readiness check as SCRUM-363: Venue: every venue booking the event relies on is approved, covers the event's current start to end, and is not flagged for review. Equipment: if the event has an equipment request that is not Cancelled, its status is "Arranged". Date: the event's start is in the future. | **Done**. Built as one SQL function for SCRUM-363 to reuse (D1); David to confirm (section 5) |
| AC3 | If any condition is not met, submission is refused and every outstanding item is listed, not just the first. Before submitting, the coordinator sees the checklist with each condition as met or outstanding. | **Done** |
| AC4 | The equipment acknowledgement in SCRUM-363 AC5 applies here too: if the organiser's original equipment requirements are not empty but there is no active equipment request, the coordinator must confirm that no equipment is needed. | **Done** |
| AC5 | The coordinator can add a note for the Safety Officer, optional, up to 2,000 characters. | **Done**. Whether it should be required is open (D13) |
| AC6 | On submission the status becomes Safety review, and the coordinator, the date and time and the note are recorded in the status history (SCRUM-318). | **Done** |
| AC7 | While the event is in Safety review its equipment lines cannot be changed (SCRUM-21 AC10, reworded). A change to the event's date, time or attendance is a significant change and returns the event to Approved (SCRUM-395). | **Partial**: the equipment lock is done (052's guard). Returning the event to Approved after a date, time or attendance change waits on SCRUM-395, because `process_change_request` does not check the status (D10). AC7-02 cannot be written |
| AC8 | Every Safety Officer is notified when an event is submitted. The organiser sees the event as "Safety check" (SCRUM-173). | **Done** |

**Tally:** 7 done, 1 partial (AC7), 0 deferred. AC7 becomes Done when SCRUM-395
returns an event in Safety review to Approved on a significant change, with no
change here.

**Test cases:** 62; 61 proved; 1 cannot be written as specified: AC7-02 (D10).

### Evidence for each criterion

| AC | Code (file, function) | Proved by |
|---|---|---|
| AC1 | `coordinatorOnly` on `POST /:id/safety-review` (`backend/src/routes/eventRequests.js`); the holder and status checks in `submit_event_for_safety_review` (064); `isAssignedCoordinator && status === "approved"` around the panel (`CoordinatorRequestDetail.jsx`) | `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written` (another coordinator, a Lead, the organiser, a Safety Officer, a null caller), `SCRUM489_AC1_an_event_that_is_%s_is_refused_naming_its_status`, `SCRUM489_AC1_a_second_submission_is_refused_as_safety_review` (PGlite); `SCRUM489_AC1_%s_is_refused_the_submission_with_403_and_queries_nothing`, `SCRUM489_AC1_the_caller_is_the_tokens_user_not_the_bodys` (route); `SCRUM489_AC1_%s_is_not_offered_it`, `SCRUM489_AC1_an_event_that_is_%s_offers_no_submission` (screen) |
| AC2 | `event_readiness` (064) | `SCRUM489_AC2_an_approved_covering_booking_no_equipment_and_a_future_start_is_ready`, `SCRUM489_AC2_a_%s_booking_is_outstanding`, `SCRUM489_AC2_an_approved_booking_that_no_longer_covers_the_event_is_outstanding`, `SCRUM489_AC2_an_equipment_request_%s_is_met_only_when_arranged`, `SCRUM489_AC2_the_date_is_outstanding_when_%s` (PGlite); `SCRUM489_AC2_a_request_scrum300_arranged_by_reserving_in_full_reads_as_met`, `SCRUM489_AC2_a_flagged_reservation_makes_equipment_outstanding` (PGlite, SCRUM-300 loaded) |
| AC3 | The PT409 `EVENT_NOT_READY` refusal (064); `translateError`'s branch for it (`eventRequestService.js`); `GET /:id/readiness`; the panel's table | `SCRUM489_AC3_three_outstanding_items_are_all_listed_in_the_refusal`, `SCRUM489_AC3_the_readiness_read_changes_nothing_and_lists_what_the_refusal_lists` (PGlite); `SCRUM489_AC3_not_ready_is_a_409_with_every_outstanding_line` (service); `SCRUM489_AC3_the_checklist_is_a_table_with_item_status_and_detail`, `SCRUM489_AC3_submit_is_disabled_while_anything_is_outstanding` (screen) |
| AC4 | The `no_equipment_confirmation` line (064, D5); the panel's checkbox, which reads the checklist again with `noEquipmentConfirmed` | `SCRUM489_AC4_requirements_with_no_active_request_need_a_confirmation_and_unconfirmed_are_refused`, `SCRUM489_AC4_confirmed_it_submits_and_the_acknowledgement_is_recorded` (PGlite); `SCRUM489_AC4_ticking_reads_again_with_no_equipment_confirmed_and_shows_the_servers_answer` (screen) |
| AC5 | The note's limit in the service (`SAFETY_NOTE_MAX`), the SQL (22023) and the table's check; the panel's counter of the trimmed note | `SCRUM489_AC5_a_note_over_2000_characters_is_refused_with_22023` (PGlite); `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc` (service); `SCRUM489_AC5_a_note_of_2001_characters_blocks_submit_with_a_message`, `SCRUM489_AC5_a_whitespace_only_note_sends_no_note` (screen) |
| AC6 | `change_event_request_status` called by argument name with the note as the reason (D8); the `safety_review_submissions` row and its trigger (D7) | `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once`, `SCRUM489_AC6_a_submission_row_cannot_be_changed_or_deleted` (PGlite); `SCRUM489_AC6_the_page_shows_safety_check_at_once_with_no_submission_panel` (screen) |
| AC7 | No new code: 052's `assert_equipment_editable` refuses every equipment change in `safety_review` | `SCRUM489_AC7_%s_in_safety_review_is_refused_as_a_significant_change_and_nothing_changes` (PGlite, from a real submission); SCRUM-21's `SCRUM21_AC10_a_confirmed_event_gets_409_with_the_significant_change_message` for the 409 over HTTP |
| AC8 | The notification insert over `profiles.role = 'safety_officer'` (064, D11); `describeNotification`'s branch; the card on `SafetyOfficerDashboard.jsx`; SCRUM-488's "Safety check" label | `SCRUM489_AC8_with_no_safety_officer_it_still_submits_and_notifies_nobody`, `SCRUM489_AC8_the_type_list_keeps_every_earlier_type_and_adds_this_storys`, `SCRUM489_AC8_a_submitted_event_reads_to_its_organiser_as_safety_check` (PGlite); `SCRUM489_AC8_names_the_event_the_coordinator_and_the_start` (display); `SCRUM489_AC8_the_safety_officer_dashboard_reads_only_its_notifications`, `SCRUM489_AC8_a_safety_officer_reads_a_submission_notice_on_the_dashboard_in_words` (screen) |

---

## 2. Traceability: the submit, end to end

The submit is the criterion that crosses every layer, so it is the one walked
here. Take the assigned coordinator of an Approved event clicking Submit.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `SafetyCheckSubmissionPanel.jsx` | Shown only to the holder while Approved. Submit is enabled only once the server's checklist says ready, the note is 2,000 characters or fewer after trimming, and nothing is loading or sending. It sends the trimmed note (none if blank) and the confirmation | `SCRUM489_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_it`, `SCRUM489_AC3_submit_is_enabled_once_every_item_is_met`, `SCRUM489_AC3_a_form_submitted_while_not_ready_sends_nothing`, `SCRUM489_AC5_the_note_is_sent_trimmed` |
| Frontend service | `submitForSafetyReview(id, { note, noEquipmentConfirmed })` | `POST /event-requests/:id/safety-review`; a refusal reaches the panel unchanged | `SCRUM489_AC6_submitting_posts_the_note_and_the_confirmation_and_returns_the_event`, `SCRUM489_AC3_a_refusal_reaches_the_caller_unchanged` |
| Route | `POST /:id/safety-review`, `coordinatorOnly` | Every other role is a 403 with no query; the caller is the token's user, never the body's | `SCRUM489_AC1_%s_is_refused_the_submission_with_403_and_queries_nothing`, `SCRUM489_AC1_the_caller_is_the_tokens_user_not_the_bodys`, `SCRUM489_AC1_the_submission_answers_401_without_a_token` |
| Service | `submitForSafetyReview` | Validates the id, the note and the confirmation before any query (400 with `details` naming the field); one rpc | `SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc`, `SCRUM489_AC6_a_submission_is_one_rpc_with_the_caller_the_trimmed_note_and_the_confirmation` |
| Translator | `translateError` | 42501 → 403, P0002 → 404, 55000 and 40001 → 409, 22023 → 400, PT409 `EVENT_NOT_READY` → 409 with `code` and `conflicts`; a DETAIL that will not parse is `conflicts: []`, never a 500 | `SCRUM489_AC1_the_functions_%s_arrives_as_its_status`, `SCRUM489_AC3_not_ready_is_a_409_with_every_outstanding_line`, `SCRUM489_AC3_a_detail_that_is_%s_is_still_a_409_with_no_conflicts`; over HTTP `SCRUM489_AC3_not_ready_arrives_as_a_409_with_its_code_and_every_outstanding_line` |
| SQL: checks | `submit_event_for_safety_review` (064) | Locks the event; refuses a null or non-holder caller (42501), any status but Approved, naming it (55000), a note over 2,000 (22023) | `SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written`, `SCRUM489_AC1_an_event_that_is_%s_is_refused_naming_its_status`, `SCRUM489_AC5_a_note_over_2000_characters_is_refused_with_22023` |
| SQL: locks and readiness | the same | Locks the live bookings, then the equipment requests, `for share`, in SCRUM-363's order; runs `event_readiness`; not ready is PT409 with the outstanding lines | `SCRUM489_AC3_three_outstanding_items_are_all_listed_in_the_refusal`, `SCRUM489_AC2_a_flagged_reservation_makes_equipment_outstanding`. The race itself cannot be tested on PGlite (section 4) |
| SQL: writes | the same | `change_event_request_status` (approved → safety_review, the note as the reason), one `safety_review_submissions` row, one notice per Safety Officer | `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once`, `SCRUM489_AC4_confirmed_it_submits_and_the_acknowledgement_is_recorded` |
| The page | `CoordinatorRequestDetail.jsx` | Shows the returned event at once ("Safety check", no panel) and refreshes the parent's list | `SCRUM489_AC6_the_page_shows_safety_check_at_once_with_no_submission_panel` |

**What each refusal becomes on screen**, keyed on the status, the code and the
details, never the server's text:

| Response | The panel says | Proved by |
|---|---|---|
| 403 | "You are no longer this event's coordinator, so you cannot submit it." | `SCRUM489_AC1_a_%s%s_shows_its_own_message` |
| 409 `EVENT_NOT_READY` | "This event is not ready for the safety check." and a "Still outstanding" table of the returned lines; the checklist is read again | `SCRUM489_AC3_a_409_event_not_ready_shows_every_returned_line_and_reads_the_checklist_again` |
| Other 409 | "This event is no longer Approved, so it cannot be submitted…", and the page refreshes | `SCRUM489_AC1_a_%s%s_shows_its_own_message`, `SCRUM489_AC6_a_status_that_moved_under_the_coordinator_refreshes_the_page` |
| 400 whose `details` name the note | "The note could not be sent. It must be 2,000 characters or fewer." | `SCRUM489_AC5_a_400_about_the_note_shows_the_note_message` |
| Any other 400 | "The submission was refused and nothing was changed. Please try again, or tell the team if it keeps happening." | `SCRUM489_AC1_a_400_%s_shows_the_other_message_not_the_note_message` |
| Anything else | "The event could not be submitted for the safety check. No changes have been made; try again." | `SCRUM489_AC1_a_request_that_never_reached_the_server_shows_the_generic_message` |

**Manual walkthrough.** Run by Calven in the browser on 15 October 2026, on the
SCRUM-489 branch before the merge of dev, against the shared Supabase project
after 064 was applied. Every check passed: 9 of 9.

| Check | What it proves | Result |
|---|---|---|
| A | The checklist shows Met or Outstanding in words with its detail; Submit is disabled while anything is outstanding | Passed (15 October) |
| B | Approving the venue booking the real way turns the Venue row Met | Passed (15 October) |
| C | The counter is out of 2,000; Submit moves the event to "Safety check" and the panel goes | Passed on a retry (15 October). The first run was refused with a 400; see below |
| D | The history shows Approved → Safety review with the note; one `safety_review_submissions` row | Passed (15 October) |
| E | An equipment change is refused as a significant change | Passed (15 October) |
| F | No submit section once the event is not Approved | Passed (15 October) |
| G | The Safety Officer's notifications card shows "Event submitted for safety check" with the event, the coordinator and the start | Passed (15 October) |
| H | The organiser sees "Safety check", never the raw status | Passed (15 October) |
| I | The Lead sees no submit section | Passed (15 October) |

**Check C's first run.** The submit of a ready event with a 38-character note was
refused with a 400, and the panel said the note was too long. Two things were
wrong, one on each side:

- *The live database.* The live `notifications_type_known` constraint did not
  include `event_submitted_for_safety_review` (a query for it returned false), so
  the insert of the Safety Officer's notice hit 23514, which `translateError`
  turns into a 400. Appending our type to the live list fixed the submit, and the
  retry passed. **The likely way the type was lost** is a re-run of Rae's 058
  (SCRUM-490) after 064: 058 restates the whole list without our type. That is
  not confirmed unless Rae confirms it.
- *The panel.* It mapped every 400 to the note's message. It now names the note
  only when the response's `details` name the note field (`adc91d1`).

The failure is evidence that the whole-list hazard in AGENTS.md is real, not a
one-off (section 4).

---

## 3. Design decisions

Each is argued in full, with the alternatives rejected, in
`docs/test-cases/SCRUM-489.md` ("Design decisions"). The summaries below point
there.

### D1. The readiness check is one SQL function, shared with SCRUM-363

`event_readiness` returns the whole checklist; the screen's read and the submit
call the same function, so they cannot disagree, and SCRUM-363's confirm can call
it under its own locks. It takes no locks itself. Owned here; SCRUM-363 to reuse
it (section 5).

### D2. "Every venue booking the event relies on" is every live booking

Pending, approved or flagged for review, one line each, named by venue; no live
booking is one outstanding line. A hold is not a booking.

### D3. "Covers" is per booking

`starts_at <= proposed_start` and `ends_at >= proposed_end`, each booking on its
own, as AGENTS.md checks each booking on its own.

### D4. Equipment: every request that is not Cancelled must be Arranged

One line per request, worded by 038's `equipment_request_status_words`. After
the merge of dev, "Arranged" is SCRUM-300's (053: every line fully reserved,
nothing flagged), and readiness follows it unchanged (AC2-14, AC2-15).

### D5. The no-equipment acknowledgement is a checklist line

Present only when the organiser's requirements are not blank and no active
request exists; met only when confirmed; recorded on the submission.

### D6. Not ready is a 409 with every outstanding line

PT409, hint `EVENT_NOT_READY`, the lines as JSON in DETAIL (051's convention),
returned as `{ error, code, conflicts }`.

### D7. Each submission is recorded in an immutable `safety_review_submissions` row

The event, the coordinator, the note, the acknowledgement and the time, beside
the history row; a trigger refuses update and delete. SCRUM-490 can read the
note from it.

### D8. The status moves through `change_event_request_status`

Called by argument name, so it works against 022's version and 058's; this story
does not restate it.

### D9. A submission cannot be withdrawn

The ticket's decision; the way back is the Safety Officer's response (SCRUM-490)
or a significant change (SCRUM-395). Team to confirm.

### D10. AC7's second half belongs to SCRUM-395

`process_change_request` applies a change whatever the status; returning the
event to Approved is SCRUM-395's. AC7 is partial until then.

### D11. Every Safety Officer is notified

An insert from a select over `profiles.role = 'safety_officer'`, as 052 notifies
every Lead; with none, the submit still succeeds.

### D12. Equipment is locked during Safety review — **open team question**

AC7 rewords SCRUM-21 AC10 on purpose, against `docs/requirements.md` §9's "lines
can be added or removed any time before confirmation" [C4]: the Safety Officer
reviews the arranged equipment, and a line changed under review would make the
approval cover equipment nobody checked. Already enforced by 052's guard. The
team has not confirmed the departure from §9.

### D13. The note is optional — **open team question**

As AC5 says, although Week 7 #6 asks about crowd movement and equipment
placement, and SCRUM-490 AC3 says the note is where they are described.

### D14. An event in Safety review cannot be cancelled yet — **owned by SCRUM-561**

`cancel_event_request` and both `CANCELLABLE_STATUSES` lists leave out the safety
statuses. Nothing is changed here.

### D15. Built on SCRUM-488's working assumptions — **owned by SCRUM-488**

Two statuses, the gate before Confirmed, the send-back to Approved, the labels.
If the team moves the gate, only the from-status and the readiness call change.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC7-02 | A date, time or attendance change to an event in Safety review does not return it to Approved: `process_change_request` does not check the status (D10) | SCRUM-395 (Rae) |
| Cancel in the safety statuses | The coordinator loses Cancel once the event is in Safety review (D14) | SCRUM-561 |
| `notifications_type_known` on the live database | Rae's 058 restates the whole list without `event_submitted_for_safety_review`. Re-running it drops our type, and every submit then fails with a 400 while any Safety Officer exists. In the click-through the live list lacked our type, and the likely cause is such a re-run (section 2; not confirmed unless Rae confirms it). Fixed live by appending our type. Rae must add our type to 058 before SCRUM-490 merges. This is AGENTS.md's whole-list hazard in practice | Rae, with the team |
| Merge conflict ahead | Rae's SCRUM-490 rewrites `SafetyOfficerDashboard.jsx`. Ours is one import, one element and two reworded header lines; keep the notifications card when resolving | Whoever merges second |
| Reservations frozen in the safety statuses | 053's `equipment_reservable_event_statuses()` (053:97) returns `approved` and `confirmed` only; its own comment (053:88) says to add `safety_review` and `safety_approved` once SCRUM-488 adds them, and nobody has. 061's `flag_equipment_reservations` (061:405) still sends an arranged request back to `pending_review` in any status. So in Safety review a flagged reservation (a type marked unusable, say) cannot be reserved again (053:139 refuses, 55000) and the request stays `pending_review` until the event leaves Safety review. Readiness reads it correctly (AC2-15); SCRUM-363 must re-check readiness before confirming | SCRUM-300 or SCRUM-488 for the list; SCRUM-363 for the re-check |
| No live script covers the submit | No `backend/scripts` check exercises `POST /:id/safety-review`; the click-through and PGlite are the evidence | Optional |
| The flag-versus-submit race | A booking flagged during a submit waits on the submit's `for share` lock. PGlite is one connection, so two transactions never overlap and this is untested | — |

### Technical debt, left

- **`event_readiness` has no caller argument**, a deliberate exception to
  `backend/db/migrations/AGENTS.md`'s "caller and role checks belong inside the
  function too". It is read-only, its execute is revoked from public, anon and
  authenticated, and the route gates it (`coordinatorOrLead`, then
  `getEventRequestForCoordinator`, so a draft is a 404). A caller argument would
  have to be ignored by SCRUM-363's confirm, which calls it inside its own checks.
- **22004 for a null event id is unmapped.** `translateError` has no branch for
  it, so it would be a 500. The API cannot send one: the service checks the id
  before any rpc.
- **The services sit in `eventRequestService.js`**, beside `toEventRequest` and
  `translateError`, which are not exported; a file of their own would need both
  exported.
- **The readiness route makes two reads**: the event first, so a draft answers
  404 like the other coordinator reads, then the checklist.
- **The date line is written `now() < v_event.proposed_start`** so SCRUM-484's
  single-source overlap scan does not read a clock check as a copy of the overlap
  rule. The scan was left alone.
- **The panel's checklist read catches what it throws**, so a missing mock in
  another story's test file shows the panel's error state rather than taking the
  page down. Eighteen existing files mock `eventRequestService` without the two
  new calls, and render the panel in that state.
- **`Dashboard.test.jsx` is SCRUM-485's file**, and now holds this story's two
  dashboard tests, where the moved row's successor belongs.

### Process notes

- **Test-first:** SCRUM-554's 56 cases were written before any code, and each later
  subtask marked the cases it proved. The document grew to 62 cases in the open:
  AC1-10, AC6-06, AC8-06 and AC8-07 for the screen, AC2-14 and AC2-15 for the seam
  with SCRUM-300.
- **Teeth checks:** every new test was checked by reverting the line it proves,
  watching it fail, and restoring it: the holder check removed from the SQL, the
  coverage condition dropped, the DETAIL narrowed, the acknowledgement forced met,
  the limit raised, the reason nulled, the notices sent to Leads, the panel's gate
  and refresh removed, the card unmounted, `safety_review` let through 052's guard,
  every 400 sent to the note's message, and `pending_review` counted as Arranged.
- **Briefs corrected by the code:** the revoke form is 051's, not 052's (052
  revokes nothing); SCRUM-485's no-service test pinned the Safety Officer
  dashboard, so mounting the card was held until Calven moved that row; the panel
  mapped every 400 to the note, which only the click-through found; the page reads
  "Safety check" after a submit, not "Safety review", because the coordinator and
  the organiser share one label set; and the merge of dev the sweep first expected
  had not yet been made.
- **One folder, one branch:** no worktree; nothing on Rae's SCRUM-490 branch was
  used or copied.

---

## 5. Open questions for the team

1. **Equipment locked during Safety review (D12).** Departs from requirements §9
   [C4]. **Open.**
2. **Should the note be required (D13)?** AC5 says optional; Week 7 #6 and
   SCRUM-490 AC3 suggest the Safety Officer needs it. **Open.**
3. **One role per account, or several?** AGENTS.md says a user may hold several
   roles; the code reads one `profiles.role`. Not SCRUM-489's to settle, but it
   decides who "every Safety Officer" is: today, every profile whose one role is
   `safety_officer`. **Open.**
4. **Is `event_readiness` the check SCRUM-363 reuses?** Built to be shared (D1),
   and to be called under SCRUM-363's locks. **Open**: David to confirm.
5. **A submission cannot be withdrawn (D9).** The ticket's decision. **Open**, team
   to confirm.
6. **Cancelling in Safety review (D14).** **Owned** by SCRUM-561.

---

## Before the examination

- **Be ready for "why can't the coordinator submit while a venue booking is
  pending?"** D2: a pending request is a venue nobody has agreed to, so the Safety
  Officer would approve arrangements that may not happen. Withdraw the request or
  get it approved (`SCRUM489_AC2_a_%s_booking_is_outstanding`).
- **Be ready for "how do you know every Safety Officer is told?"** D11: one insert
  from a select over every Safety Officer's profile, in the same transaction as the
  status change; `SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once`
  checks one notice each for two Safety Officers and none for anyone else, and
  `SCRUM489_AC8_a_safety_officer_reads_a_submission_notice_on_the_dashboard_in_words`
  shows one on the card.
- **Be ready for "why is AC7 partial?"** D10 in two sentences: the lock is done,
  by 052's guard; returning the event to Approved on a date change is SCRUM-395's,
  because `process_change_request` ignores the status today.
- **Be ready for "what stops two submits?"** The submit locks the event row
  `for update` and refuses anything but Approved, so a second submit waits, then
  finds Safety review and is a 409 naming it
  (`SCRUM489_AC1_a_second_submission_is_refused_as_safety_review`).
  `change_event_request_status`'s `p_expected_status` check refuses a stale status
  again, with 55000, as a second guard.
