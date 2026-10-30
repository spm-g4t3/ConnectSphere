# SCRUM-402 — Process an Event Change Request (Event Coordinator)

**Story:** Process an Event Change Request (E3) — Event Coordinator
**Closing subtask:** SCRUM-410 (this document)
**Status as of 30 October 2026:** built and tested; all twelve criteria done (section 1). The click-through passed in full, as reported by Calven on 30 October 2026, after the two incidents recorded under Verification.

This document is the record of what SCRUM-402 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC5.

The case-by-case mapping is `docs/test-cases/SCRUM-402.md`: 90 cases, 58 backend
and 32 on the screen, each naming the tests that prove it. This document cites it
rather than repeating it.

**The short version, for anyone asked "what changed?":**

- One change request can now cover several fields. The Organiser's form takes up
  to nine changes and an optional note, and the request is accepted or declined as
  a whole. "Cancel the event" stands alone.
- Only the coordinator assigned to the event can process a request, and only while
  the event is Under review, Pending clarification, Approved, Safety review, Safety
  approved or Confirmed. A Submitted event asks for its review to be started first.
- Accepting applies each field the way its status allows. In review, everything
  goes through SCRUM-387's edit. In planning and the safety statuses, ordinary
  fields are applied directly and significant ones go through SCRUM-395, which flags
  what they affect and returns the event to Approved. A Confirmed event returns to
  Approved first.
- A cancellation request cancels the event through `cancel_event_request`, with the
  Organiser's own words as the reason unless the coordinator edits them. An
  equipment change hands the coordinator to the equipment lines.
- Every applied field is recorded in the change history as `change_request`, linked
  to the request. The Organiser is told the outcome, and the coordinator is told
  when a significant change arrives.
- It closes a bug: before 402, an approved change request moved an Approved or
  Safety review event's date with no flags and no history row (SCRUM-489 AC7-02).

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-403 | Migration 035: the `cancellation` change field, on its own. Migration 036: request groups and their trigger, `event_change_history.change_request_id` and its link check, `edit_event_request_details` taking its source from a setting, `change_request_targets()` and `change_request_field_class()`, `create_change_request_group`, `change_request_group_plan`, `change_request_gate`, `preview_change_request`, `process_change_request` restated in place, and the two notice types appended to the live list. The Organiser's note (`organiser_note`). Migration 039: the notice types restored after later restates, 347's rejected-event refusal under the lock, and the trigger that closes a rejected event's open requests | `c01ea68`, `9ea59f9`, `2a77a24` |
| SCRUM-404 | The coordinator's list: `GET /:id/change-requests/review` oldest first with `requestGroupId`, `currentValue` and `organiserNote`; `ChangeRequestReviewPanel.jsx`'s cards, one per submission; My events' `openChangeRequestCount`, counted by group, and its badge | `c01ea68`, `7b74515` |
| SCRUM-405 | The preview: `preview_change_request` (036) and `GET /change-requests/:id/preview`; the panel's review, with each field's class, invalid values, the revert warning and 395's impact; the check that a preview carries what the review needs | `c01ea68`, `7b74515`, `ea6d510` |
| SCRUM-406 | Accept: `process_change_request`'s routing by status, `expectedImpact` passed to 395, the cancellation and equipment paths, and the panel's Accept, cancellation confirmation and equipment hand-off | `c01ea68`, `7b74515`, `ea6d510` |
| SCRUM-407 | Decline: a reason of 1 to 2,000 characters, recorded on every row of the group; the panel's Decline | `c01ea68`, `7b74515` |
| SCRUM-408 | The screens: the review panel in place of the old inline list on `CoordinatorRequestDetail.jsx`; the Organiser's multi-field `ChangeRequestForm.jsx` and grouped `ChangeRequestStatusList.jsx`; the two notices' wording; errors shown in the card being reviewed; the `SCRUM402_FILES` gate | `7b74515`, `ea6d510` |
| SCRUM-409 | The case document and every `SCRUM402_ACn_…` test; the teeth checks in each round | every commit above |
| SCRUM-410 | This document; the sweep for 034's `event_completed` outcome | this commit |
| Merge of dev | SCRUM-347, SCRUM-173 and SCRUM-460 (024, 025, 027, 029, 032, 037) | `0b7acba` |
| Merge of dev | SCRUM-379 and SCRUM-571 (033, 034, 038), with the outcome labels reconciled (below) | Calven's merge commit |

### The merge of 30 October 2026

The second merge of dev brought in SCRUM-379's completion (033, 034) and SCRUM-571's
freed venues (038). Six files conflicted, and each kept both stories:

- **The routes.** 402's create route keeps its rejected-event check and gains
  SCRUM-382's `guardOwnEvent`; the decision route gains `guardChangeRequest`; the
  preview route is unchanged (`eventRequests.js:1159`, `:1184`, `:1196`).
- **My events.** `/mine` selects SCRUM-384's closing notes and 402's change-request
  embed (`eventRequestService.js:2106`), and its select test expects both.
- **The outcome words.** SCRUM-379 added `changeRequestOutcome.js`, in SCRUM-347's
  words ("Closed, event completed"), to the Organiser's list and the coordinator's
  old inline list. 402 had replaced both screens, with its own words
  ("Closed: the event was completed"). The screens keep 402's words, from
  `changeRequestDisplay.js`, which gains `event_completed`; the list keeps 379's
  styles. Three 379 tests on those screens, six cases, are renamed
  `SCRUM402_AC10_…` and assert 402's words (AC10-06, AC10-07).
  `changeRequestOutcome.js` is now used only by its own unit test (section 4).
- **A test fixture.** `scrum379CoordinatorReadsClosingNotesDatabase.test.js`
  translates the PostgREST embeds its path selects, and refuses any other on
  purpose. It now translates 402's `event_change_requests` embed too.

### Verification as of 30 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | At `cabab50`, before the story: 8,488 passing and 2 todo across 192 files (run on 30 October 2026 from a worktree of that commit). After this merge: 9,599 passing, 12 skipped and 2 todo across 221 files, 1 file skipped (`waitingListConcurrency.realdb.test.js`, which runs only against a real Postgres URL). Through the story: 8,599 across 195 files after brief 1; 8,609 after the note; 8,610 after the screens; 8,853 across 208 after the first merge and 039; 8,856 after the cancellation fix-up |
| Frontend suite (`npm run test:coverage` in `frontend`) | At `cabab50`: 4,131 passing across 174 files, run the same way. After this merge: 4,526 passing across 191 files. Through the story: 4,225 across 179 after the screens; 4,304 across 183 after the first merge and 039; 4,317 after the cancellation fix-up. `npm run lint` 0 errors and 24 warnings (23 pre-existing; the 24th is in SCRUM-379's new `CoordinatorAttentionList.jsx`); `npm run build` passes |
| SCRUM-402's gate | `SCRUM402_FILES` in `frontend/vite.config.js` (`:245`): `ChangeRequestReviewPanel.jsx` and `changeRequestDisplay.js` at 100% statements, branches, functions and lines |
| Gates that held | `notificationDisplay.js` at 100% in SCRUM-17's gate and `notificationLink.js` in SCRUM-172's. `ChangeRequestStatusList.jsx` is at 100% but ungated. The backend's `eventChangeRequestService.js` is ungated, at 79% of lines (section 4) |
| SCRUM-402's own tests | 252 titles once parametrised cases are expanded, every one named `SCRUM402_ACn_…` or `SCRUM347_AC6_create…`. Backend 135: 71 in `scrum402ProcessChangeRequestDatabase.test.js`, 49 in `scrum402ChangeRequestRoutes.test.js`, 5 in `scrum402ChangeRequestValidation.test.js`, 4 in `eventRequests.test.js`, 3 in `scrum489SafetyReviewSubmissionDatabase.test.js`, 2 in `eventChangeField.test.js`, 1 in `eventRequestService.test.js`. Frontend 117: 56 in `scrum402ChangeRequestReviewPanel.test.jsx`, 22 in `scrum402OrganiserChangeRequests.test.jsx`, 16 in `scrum402ChangeRequestDisplay.test.js`, 10 in `scrum402NotificationDisplay.test.js`, 5 in `scrum379CoordinatorCompletion.test.jsx`, 4 in `scrum347RejectApprovedEvent.test.jsx`, 3 in `scrum402CoordinatorScreens.test.jsx`, 1 in `notificationDisplay.test.js` |
| PGlite | `scrum402ProcessChangeRequestDatabase.test.js` runs on the full schema (`createSchemaDb()`: the baseline, then every migration, 010 to 039 with 033, 034 and 038 now among them). Statuses are reached through the real workflow functions; only Completed is seeded |
| Live database | 035 and 036 applied by Calven on 27 October 2026; both checks passed. 039 applied on 29 October 2026; its check returned `true | true | true`. The first paste had evidently not run, and a re-run fixed it. No live script was run by us; the cancellation incident below was read with read-only calls |
| Test-case document | 90 cases (58 backend, 32 UI): **90 proved**, 0 not yet implemented, 0 that cannot be written as specified. 22 are traps, 5 of them on the screen |
| Click-through | Passed in full, as reported by Calven on 30 October 2026. The first run (29 October) stopped at the significant-change step: 024, 032 and 037 had restated the notice list whole after 036 ran on live and dropped 402's two types, so every insert of either notice failed; 039 fixed it. On the second run, accepting a cancellation did nothing the first time; live reads, PGlite and a screen replay with the live data all worked, the cause was never reproduced, and after both servers were restarted it worked, so most likely a server was running stale code. `ea6d510` makes any such failure visible in the card |

**Teeth checks**: each test was checked by breaking the line it proves, watching
it fail, and restoring the file from an in-memory copy (never `git checkout`).
72 in all: 24 for brief 1 (SCRUM-403 to SCRUM-407), 9 for the Organiser's note,
25 for the screens (SCRUM-404 and SCRUM-408), 5 for 039 and its two follow-ups,
8 for the cancellation fix-up and 1 for this sweep. Each row names the file broken;
section 2 gives the lines.

| AC | What was broken | What failed | Round |
|---|---|---|---|
| AC1 | Each row given its own group (036) | AC1-01, AC10-01, AC12-01 | Brief 1 |
| AC1 | A cancellation mixed with other fields allowed (036) | AC1-03 | Brief 1 |
| AC1 | The note not stored (036) | `SCRUM402_AC1_a_groups_note_is_stored_on_every_row_and_previewed` | Note |
| AC1 | A blank note not turned into null (036) | That test, and the blank case of `SCRUM402_AC1_a_group_with_%s_stores_null` | Note |
| AC1 | The function's note-length check removed (036) | `…_a_note_over_2000_characters_is_refused_by_the_function_and_by_the_table` (it got the table's 23514, not 22023) | Note |
| AC1 | The table's note check removed (036) | The same test (the direct insert succeeded) | Note |
| AC1 | The preview without the note (036) | `…_a_groups_note_is_stored_on_every_row_and_previewed` | Note |
| AC1 | The validator's note-length check removed (`eventChangeRequestValidation.js`) | `…_a_groups_note_is_trimmed_optional_and_at_most_2000_characters` | Note |
| AC1 | The service not sending `p_note` (`eventChangeRequestService.js`) | `…_the_organisers_note_goes_with_the_group_and_comes_back_on_each_row` | Note |
| AC1 | The service not mapping `organiserNote` | That test, and `…_the_coordinators_list_carries_the_organisers_note` | Note |
| AC1 | The form allowing a duplicate "Something else" (`ChangeRequestForm.jsx`) | 2 form tests | Screens |
| AC1 | The form not sending the note | 1 form test | Screens |
| AC1 | A 400's faults not put beside their rows | 1 form test | Screens |
| AC1 | The form showing the server's text | 5 form tests | Screens |
| AC1 | The requested value not through the shared formatter (panel) | 2 panel tests | Screens |
| AC1 | No count badge on My events (`MyAssignedEvents.jsx`) | 1 screen test | Screens |
| AC1 | `/mine` counting rows, not groups (`eventRequestService.js`) | 1 route test | Screens |
| AC2 | The gate's caller check removed (036) | 5 PGlite tests | Brief 1 |
| AC2 | Submitted not asked to start the review (036) | AC2-02 | Brief 1 |
| AC2 | Rejected allowed (036) | AC2-03 | Brief 1 |
| AC2 | The panel's buttons shown to anyone | 1 panel test | Screens |
| AC2 | A status AC2 refuses still offering Review | 4 panel tests | Screens |
| AC2 | No "start the review" line on a Submitted event | 1 panel test | Screens |
| AC2 | 039's rejected-event refusal removed (`039:49–52`) | `SCRUM347_AC6_create_change_request_group_refuses_a_rejected_event` | 039, follow-up 1 |
| AC3 | A decline accepted with no reason (036) | 2 PGlite tests | Brief 1 |
| AC3 | The panel's decline sent with no reason | 1 panel test | Screens |
| AC4 | The preview without the impact (036) | 3 PGlite tests | Brief 1 |
| AC4 | The previewed impact not passed to 395 (036) | AC4-04 | Brief 1 |
| AC4 | The panel's accept not sending the impact | 1 panel test | Screens |
| AC4 | A changed impact not previewed again | 2 panel tests | Screens |
| AC4 | The review showing none of its own lines | 16 panel tests (every in-review error test) | Cancellation |
| AC4 | A failure shown in every card, not its own | `SCRUM402_AC4_a_failed_preview_says_so_in_its_own_card_beside_review` | Cancellation |
| AC4 | A preview missing its fields opened anyway | 6 panel tests | Cancellation |
| AC4 | A missing preview read as if it had rows | `SCRUM402_AC4_no_preview_at_all_says_it_could_not_be_reviewed` | Cancellation |
| AC4 | A re-read preview missing its fields left open | `SCRUM402_AC4_a_re_read_preview_without_its_fields_closes_the_review_and_says_so` | Cancellation |
| AC4 | An outcome shown in every card | `SCRUM402_AC4_an_outcome_is_told_in_the_card_it_belongs_to` | Cancellation |
| AC5 | 387 run before 395 (036) | AC5-04, AC5-05 | Brief 1 |
| AC5 | Confirmed not returned to Approved (036) | AC5-05 | Brief 1 |
| AC5 | A value equal to the stored one counted as a change (036) | AC5-09 | Brief 1 |
| AC5 | Venue treated as ordinary (036) | AC5-07 | Brief 1 |
| AC5 | Faults not refused (036) | AC5-08 | Brief 1 |
| AC5 | Invalid values not disabling Accept (panel) | 1 panel test | Screens |
| AC5 | The event not read again after a decision (panel) | 4 panel tests | Screens |
| AC6 | The history source not set (036) | 3 PGlite tests | Brief 1 |
| AC6 | The settings not reset after the accept (036) | AC6-03 | Brief 1 |
| AC7 | The event cancelled before the group is marked (036) | Both AC7 PGlite tests | Brief 1 |
| AC7 | The wrong initiator (036) | Both AC7 PGlite tests | Brief 1 |
| AC7 | The cancellation reason from the request's text only (036) | `SCRUM402_AC7_a_cancellations_reason_is_prefilled_from_the_organisers_note` | Note |
| AC7 | A cancellation not standing alone on the form | 1 form test | Screens |
| AC7 | The cancellation reason not pre-filled (panel) | 1 panel test | Screens |
| AC7 | A cancellation never opening its confirmation (panel) | 4 panel tests | Cancellation |
| AC7 | A cancellation impact that is not an object used anyway (panel) | Both `SCRUM402_AC7_a_cancellation_impact_with_%s_says_so_in_the_card` | Cancellation |
| AC8 | Equipment not recorded in planning (036) | 2 PGlite tests | Brief 1 |
| AC8 | No equipment hand-off (panel) | 3 panel tests | Screens |
| AC8 | The equipment section not focused (`CoordinatorRequestDetail.jsx`) | 1 screen test | Screens |
| AC9 | "Something else" accepted with no note (panel) | 1 panel test | Screens |
| AC10 | The processed check removed (036) | AC10-01 | Brief 1 |
| AC10 | The Organiser's list not grouped (`ChangeRequestStatusList.jsx`) | 28 list tests | Screens |
| AC10 | `event_rejected` unlabelled | 1 list test | Screens |
| AC10 | 039's rejection trigger not created (`039:150–154`) | 3 PGlite tests: AC10-05 and the two AC2 cases the rejection now closes | 039, follow-up 2 |
| AC10 | `event_completed`'s label removed (`changeRequestDisplay.js:42`) | 4 tests: the display test, the list's `event_completed` case, the never-declined test and the coordinator panel's | This sweep |
| AC11 | The outcome notice not sent (036) | AC11-01 | Brief 1 |
| AC11 | The notice not naming a cancellation as one (`notificationDisplay.js`) | 1 notice test | Screens |
| AC11 | 036's appended types ignored by the frontend's type list | 2 tests, `SCRUM172_AC6_every_known_type_has_wording` one of them | Screens |
| AC11 | 039 deleted (backend) | 40 of 71 PGlite tests: every accept and every significant submission, the click-through's failures exactly | 039 |
| AC11 | The two 402 fixtures removed (frontend) | `SCRUM172_AC6_every_known_type_has_wording` | 039 |
| AC11 | 039 deleted (frontend's type list) | `SCRUM402_AC11_the_known_types_include_what_036_appends_to_the_live_list`, `SCRUM172_AC6_every_known_type_has_wording` | 039 |
| AC12 | The significant notice not sent (036) | AC12-01 | Brief 1 |
| AC12 | The significant notice naming no fields (`notificationDisplay.js`) | 1 notice test | Screens |
| SC-01 | The notice list rebuilt without the live types (036) | SC-01 | Brief 1 |
| Route | The PT409 code dropped (`eventChangeRequestService.js`) | 8 route tests | Brief 1 |
| Route | The expected impact not sent | 1 route test | Brief 1 |

Two checks changed the code before they passed. In brief 1, the "mark processed"
updates were unguarded: run after the cancel, they would have overwritten its
close, so they now update only open rows and refuse if they find none
(`036:761–770`). The cancel-ordering check first survived because the teeth
script's second replacement removed what the first had inserted; it was fixed and
rerun.

---

## 1. Acceptance criteria

| AC | Criterion (in substance) | Status |
|---|---|---|
| AC1 | The assigned coordinator sees every open change request for their events, oldest first. One request may cover several fields; each shows the fields with their current and requested values, the Organiser's note and the date submitted. | **Done** |
| AC2 | Only the assigned coordinator can accept or decline, and only while the event is Under review, Pending clarification, Approved, Safety review, Safety approved or Confirmed. A Submitted event asks for the review to be started. Anyone else is refused. | **Done** |
| AC3 | A request is accepted or declined as a whole. Declining needs a reason. | **Done** |
| AC4 | Before accepting, the coordinator sees which fields are ordinary and which significant, and 395's impact for the significant ones. | **Done** |
| AC5 | Accepting applies the values by status (review: as 387; planning and safety: ordinary directly, significant through 395 and back to Approved; Confirmed: back to Approved first). A venue request is a change to the venue requirements. SCRUM-10's rules apply; an invalid value is refused with reasons, and the coordinator can decline instead. | **Done**; the safety statuses and Confirmed proved in PGlite, not clicked (section 4) |
| AC6 | Applied changes appear in the change history as "change request", linked to it. | **Done** |
| AC7 | A cancellation request cancels the event through `cancel_event_request`, initiator "the organiser's request", with the Organiser's note pre-filled as the reason and editable. | **Done** |
| AC8 | An equipment change opens the equipment lines with the Organiser's text; on a Confirmed event it first returns the event to Approved through 395. | **Done** |
| AC9 | "Something else" records the coordinator's note and changes no field. | **Done** |
| AC10 | Processed once only. The outcome, coordinator, reason or note and time are recorded, and the Organiser sees them. | **Done** |
| AC11 | The Organiser is told the outcome, by 402's function. | **Done** |
| AC12 | When the Organiser requests a significant change, the assigned coordinator is told. | **Done** |

**Tally:** 12 done, 0 partial, 0 deferred.

**Test cases:** 90 (58 backend, 32 UI); 90 proved.

### Evidence for each criterion

The click-through script is not in the repo, and the run was reported as a whole;
each row names what the step showed, with its number where the briefs give one.

| AC | Proved by | Click-through |
|---|---|---|
| AC1 | `SCRUM402_AC1_one_submission_is_one_group_of_rows_named_by_the_first` (PGlite); `SCRUM402_AC1_one_card_per_submission_with_current_and_requested_values_the_note_and_the_date` (panel) | Step 4: the Organiser's form with several changes; the coordinator's cards |
| AC2 | `SCRUM402_AC2_%s_is_refused_with_42501`, `SCRUM402_AC2_a_submitted_event_asks_for_its_review_to_be_started_first` (PGlite) | Review offered to the holder only |
| AC3 | `SCRUM402_AC3_a_decline_records_the_reason_on_every_row_and_changes_nothing_else` (PGlite) | A decline with a reason |
| AC4 | `SCRUM402_AC4_the_preview_classes_each_row_with_its_current_and_requested_values`, `SCRUM402_AC4_an_impact_that_changed_since_the_preview_refuses_the_accept` (PGlite); `SCRUM402_AC4_tags_each_field_and_shows_the_impact_in_395s_style` (panel) | Review on an Approved event: the tags and the impact |
| AC5 | `SCRUM402_AC5_while_%s_a_significant_field_goes_through_395_and_the_event_is_approved`, `SCRUM402_AC5_a_confirmed_event_with_ordinary_fields_only_returns_to_approved_first` (PGlite) | An ordinary field plus a date accepted on an Approved event |
| AC6 | `SCRUM402_AC6_387s_rows_are_labelled_change_request_and_linked`, `SCRUM402_AC6_395s_rows_are_labelled_the_same_way_without_395_restated` (PGlite) | The change history after the accept |
| AC7 | `SCRUM402_AC7_accepting_cancels_with_the_organisers_request_and_the_coordinators_reason`, `SCRUM402_AC7_an_under_review_event_is_cancelled_with_the_reason_the_panel_sends` (PGlite); `SCRUM402_AC7_an_under_review_cancellation_opens_the_confirmation_and_sends_the_prefilled_reason` (panel) | Steps 22 to 24 |
| AC8 | `SCRUM402_AC8_in_planning_395_records_it_for_the_equipment_lines` (PGlite); `SCRUM402_AC8_an_accepted_equipment_change_moves_to_the_equipment_section_with_the_organisers_text` (screen) | An equipment change on an Approved event |
| AC9 | `SCRUM402_AC9_something_else_records_the_note_and_changes_no_field` (PGlite) | — |
| AC10 | `SCRUM402_AC10_a_group_is_processed_once_only` (PGlite); `SCRUM402_AC10_the_outcome_%s_reads_as_%s_with_the_coordinators_words_and_date` (list) | The Organiser's list after each decision |
| AC11 | `SCRUM402_AC11_the_organiser_is_told_the_outcome_on_accept_and_on_decline`, `SCRUM402_AC11_the_outcome_notice_type_survives_every_later_restate` (PGlite) | Step 9: the Organiser's notice |
| AC12 | `SCRUM402_AC12_a_significant_request_tells_the_holder` (PGlite); `SCRUM402_AC12_names_the_event_and_the_fields` (notice) | The coordinator's notice for an attendance change |

---

## 2. Traceability: AC5, end to end

**User story** → **AC5** → **test cases** AC5-01 to AC5-11
(`docs/test-cases/SCRUM-402.md`) → **test classes**
`scrum402ProcessChangeRequestDatabase.test.js`, `scrum402ChangeRequestRoutes.test.js`,
`scrum402ChangeRequestReviewPanel.test.jsx`, `scrum402ChangeRequestDisplay.test.js`,
and the renamed cases in `scrum489SafetyReviewSubmissionDatabase.test.js` and
`eventChangeField.test.js` → **code**. AC5 is where the story meets 387 and 395:
the same request does different things in different statuses. Take the assigned
coordinator accepting a description and a later start on an Approved event.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen: the tags | `ChangeRow` (`ChangeRequestReviewPanel.jsx:105–110`), `changeClassLabel` (`changeRequestDisplay.js:52–60`) | The description reads "Applied directly", the start "Re-checks bookings"; the class is the preview's, never guessed on the screen | `SCRUM402_AC4_tags_each_field_and_shows_the_impact_in_395s_style`; (display) `SCRUM402_AC4_the_class_%s_reads_as_%s` |
| Screen: Accept | `decide` (`ChangeRequestReviewPanel.jsx:187`), the impact sent only when the preview has one (`:195`) | The preview's impact goes back as `expectedImpact`; after the decision the list and the event are read again (`:215–216`) | `SCRUM402_AC4_accept_sends_the_previews_impact_then_rereads_the_list_and_the_event` |
| Frontend service | `previewCoordinatorChangeRequest` and `processCoordinatorChangeRequest` (`frontend/src/services/eventRequestService.js:157`, `:149`) | `GET /event-requests/change-requests/:id/preview`; `POST …/decision` with `{ decision, decisionNotes, expectedImpact }` | The panel suite, through its mocks |
| Route | `GET /change-requests/:changeRequestId/preview` (`backend/src/routes/eventRequests.js:1184`); `POST …/decision` (`:1196`), `coordinatorOnly` and SCRUM-382's `guardChangeRequest` | Any role but a coordinator is 403; a Completed or Cancelled event is 409 `EVENT_FINAL` before the function runs | `SCRUM402_AC4_the_preview_is_asked_for_by_the_tokens_coordinator_and_returned_as_is` |
| Service | `processChangeRequest` (`eventChangeRequestService.js:470`), the rpc (`:489`), `p_expected_impact` only when given (`:494`); PT409 hints become the 409's `code` (`:117`) | `validateProcessChangeRequest` checks the body; one rpc; `translateError` | `SCRUM402_AC4_the_previewed_impact_is_passed_to_the_function`, `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` |
| SQL: who, then status | `change_request_gate` (`036:598`): the caller (`:622`), Submitted (`:627`), the six statuses (`:630–633`), processed once (`:639`) | A stranger is 42501 before any status is read | `SCRUM402_AC2_%s_is_refused_with_42501` |
| SQL: the plan | `change_request_group_plan` (`036:485`); each field's class (`036:346`, venue significant at `:354`); its target (`036:326`, venue to `venueRequirements` at `:339`) | Each row classed and checked against SCRUM-10's rules; a value equal to the stored one dropped | `SCRUM402_AC5_a_venue_request_becomes_the_venue_requirements`, `SCRUM402_AC5_a_value_equal_to_the_stored_one_is_dropped` |
| SQL: accept | `process_change_request` (`036:703`): faults refused (`:755`); the group marked first (`:761–770`); the history settings (`:773`) | Nothing is applied if any value is refused; the settings label every history row written below | `SCRUM402_AC5_%s_is_refused_naming_the_field_and_the_group_stays_open` |
| SQL: by status | Cancellation (`036:781`); Under review and Pending clarification through 387 (`:784–792`); planning, safety and Confirmed: the significant part through 395 (`:801`), the Confirmed revert for ordinary-only (`:803`), then the ordinary part through 387 (`:806`) | Here: the start goes through `apply_significant_event_change`, which flags the booking and keeps the event Approved; the description through `edit_event_request_details` | `SCRUM402_AC5_while_%s_a_significant_field_goes_through_395_and_the_event_is_approved`, `SCRUM402_AC5_with_both_parts_395_goes_first_then_387`, `SCRUM402_AC5_a_confirmed_event_with_ordinary_fields_only_returns_to_approved_first` |
| SQL: history and notice | 387's insert takes its source from the setting (`036:295`); the settings cleared (`:817`); the outcome notice (`:835–847`) | Both fields' rows read `change_request`, linked to the group | `SCRUM402_AC6_387s_rows_are_labelled_change_request_and_linked`, `SCRUM402_AC11_the_organiser_is_told_the_outcome_on_accept_and_on_decline` |

**What each refusal becomes on screen**, keyed on the status and `code`, never the
server's text (`ChangeRequestReviewPanel.jsx:44–66`), and shown in the card being
reviewed, beside its buttons (D17):

| Response | The panel says | Why it happens |
|---|---|---|
| 400 | "This change request can't be applied as it stands. Review it again to see which values are refused, or decline it." | A value refused at accept time (AC5) |
| 401 | "Your session has expired. Please sign in again." | — |
| 403 | "You're no longer the coordinator for this event." | Handed over while the review was open (AC2) |
| 404 | "This change request no longer exists." | — |
| 409 `REVIEW_NOT_STARTED` | "Start the review of this event before processing its change requests." | A Submitted event (AC2) |
| 409 `EVENT_STATUS_NOT_ALLOWED` | "This event's status no longer allows its change requests to be processed. Go back to see where it stands." | Rejected, cancelled or completed meanwhile (AC2) |
| 409 `CHANGE_REQUEST_ALREADY_PROCESSED` | "This change request has already been processed. The list has been refreshed." The review closes and the list is read again | AC10 |
| 409 `SIGNIFICANT_CHANGE_IMPACT_CHANGED` | "The arrangements this change affects have changed since you reviewed it. The preview has been refreshed; check it and accept again." The preview is read again; nothing is retried | 395 compared the impact (AC4) |
| 409 `EVENT_HOLDS_ARRANGEMENTS` | "This request still holds bookings, holds or equipment from before it was reopened, so its date, time, attendance or requirements can't change yet. Release them, or decline the change request." | 387's D4, passed through |
| 409 `EVENT_FINAL`, `EVENT_CHANGED_SINCE_OPENED`, `SIGNIFICANT_CHANGE_REQUIRED`, `EVENT_CONFIRMED`, or no code (55000, 40001) | "This event or change request has changed. Go back to see where it stands." | SCRUM-382's guard; 387's three codes, which 036 cannot reach in practice (it passes the values it just read under the lock, sends 387 no significant field in planning, and reverts a Confirmed event first); a concurrent decision |
| A preview without the fields the review needs | "This change request could not be reviewed. Please try again." | `isReviewable` (`:38`) |
| Anything else | "The change request could not be processed. Please try again." (or "…reviewed…" for the preview) | — |

Each of these is pinned by `SCRUM402_AC2_%s_is_said_in_the_panels_own_words`, whose
every refusal carries server text the panel must not show.

---

## 3. Design decisions

D1 to D9 were set in brief 1, each with the alternative it rejects; the code
comments carry them. D10 to D17 are this document's.

### D1. `process_change_request` restated in place

One function gates, routes, records and notifies in one transaction (`036:703`),
under the same name the route and screen already used. *Rejected: three new
functions and routes*, which would have changed working screens for nothing.

### D2. A request group, `request_group_id` — **decided with Calven, 26 October 2026**

One Organiser submission is one group of rows, one per field, accepted or declined
as a whole (`036:31–52`). D10 says why it is a column. *Rejected: one field per
request*, which contradicts C4.

### D3. The history's source and link come from transaction settings

`process_change_request` sets `connectsphere.change_history_source` and
`connectsphere.change_request_id` with `set_config(…, true)` (`036:773`), and
`event_change_history.source` and the new `change_request_id` default to them
(`036:78–84`). 395's insert is labelled correctly without restating 395, and
nothing updates the append-only history. A check makes the link and the source
agree (`036:86–89`). *Rejected: restating `apply_significant_event_change`* (large
and risky), or a new parameter on it.

### D4. `edit_event_request_details` restated once, for its source

Restated from 022, its latest definition, with one change: its history insert
takes the source from the setting, falling back to `direct_edit` (`036:295`).
*Rejected: a new parameter*, which changes the signature and every caller.

### D5. A status gate, safety statuses included

`change_request_gate` admits the six statuses of AC2 (`036:630–633`). *Rejected:
no gate*, today's behaviour, under which a date moved on a Safety review event with
no re-check (SCRUM-489 AC7-02).

### D6. Venue is the venue requirements; equipment is 395's `equipmentChange`

A venue request becomes `venueRequirements`, significant (`036:339`, `:354`). An
equipment change goes to 395 as `equipmentChange: true` in planning, the safety
statuses and Confirmed (`036:798–799`), and to `equipmentRequirements` through
387 in review. *Rejected: treating venue and equipment as notes*, which skips the
re-check.

### D7. Confirmed returns to Approved first — **decided with Calven, 26 October 2026**

With ordinary fields only, the event moves Confirmed → Approved through
`change_event_request_status`, an allowed transition, then the fields go through
387 (`036:802–806`). With significant fields, 395 does the revert. *Rejected:
refusing*, which contradicts AC5.

### D8. A cancellation stands alone

A group mixing a cancellation with field changes is refused at creation
(`039:81`, as in 036), and the form keeps only the cancellation's row. Accept
marks the group before calling `cancel_event_request` (`036:761–781`), because the
cancel closes every open request of the event as `event_cancelled`. *Rejected:
mixing them*: what "accept" means for "cancel, and also move the date" is undefined.

### D9. 402's function writes both notices

`change_request_decided` to the Organiser on accept and decline (`036:835`), and
`change_request_significant_submitted` to the assigned coordinator at creation
(`039:109`, as in 036). Nobody is told when nobody is assigned: the Lead's queue
already shows the request. *Rejected: leaving AC11 to SCRUM-175*: the function that
acts writes the notice (SCRUM-486's D7).

### D10. Requests are grouped by a column, not a parent table

C4: "one request may cover several fields" (`docs/requirements.md:124`).
`request_group_id` is the first row's id, filled by a trigger for a row inserted
without one (`036:38–52`), so a row written before 036 is its own group and every
SCRUM-11 read keeps working. *Rejected: a parent table*, which means a join in
every read and a rewrite of every SCRUM-11 query.

### D11. The notice types are appended to the live list, never restated whole

036 reads `notifications_type_known` back from `pg_constraint` and adds only what it
lacks (`036:855–888`). That was not enough: 024, 032 and 037 restated the list
whole after 036 had run on live, and dropped the two types, so every insert of
either notice failed the check. 039 re-appends them with the same block
(`039:157–196`). *Rejected: restating the list whole*, which is what
`migrations/AGENTS.md` still advises and what broke 402 on live (section 5).

### D12. A rejected event is refused under the lock, and rejection closes its requests

`create_change_request_group`, restated from 036 in 039, refuses a rejected event
after the draft check (`039:49–52`). A trigger on every path to Rejected closes the
event's open requests as `event_rejected` (`039:131–154`), so a rejection from
Under review (`decide_event_request`, 032) closes them as SCRUM-347's
`reject_approved_event` already did. `decide_event_request` is not restated.
347's route check stays (`eventRequests.js:1165`): its route test stubs the
database with a success row, so without the check it would see a 500.
*Rejected: restating `decide_event_request`*, Terence's, latest in 032.

### D13. One note per submission, on every row

`organiser_note` (`036:61–66`) holds the Organiser's note, 1 to 2,000 characters
after trimming, stored on every row of the group so any row answers for it. For a
cancellation it is the reason the coordinator sees pre-filled (`036:558`).
*Rejected: a note column on a parent row*, which D10 does not have.

### D14. Migrations 035, 036 and 039

035 adds only the `cancellation` enum value: Postgres cannot use a value in the
transaction that adds it. 036 is everything else. 030 to 034 were taken when 402
started (030 and 040 on SCRUM-478's branch, 032 Terence's, 033 and 034 SCRUM-379's),
and 037 (David's) and 038 (Terence's SCRUM-571) were taken by the time 039 was
needed. 040 and 041 are on teammates' branches. *Rejected: editing 036 after it
ran on live*; 039 is a new file.

### D15. The Organiser gets two notices when fields are applied

`change_request_decided` (402), and 387's `event_details_changed` or 395's
`event_significant_change`. *Rejected: suppressing one*, which meant restating
395 or changing 387 beyond its source.

### D16. AC12 fires for significant and equipment changes, not for a cancellation

`039:97`, as in 036 (`036:451`). A cancellation is not a change for the coordinator to
re-check; it is the Organiser asking to stop. *Rejected: telling the coordinator of
every submission*, which is the Lead's queue's job.

### D17. Errors show in the card being reviewed

Every failure of the preview, the cancellation impact or the decision is shown in
the card it belongs to, beside its buttons (`cardLines`,
`ChangeRequestReviewPanel.jsx:264`), and a preview without the fields the review
needs says so rather than opening an empty card (`:38`). *Rejected: one line at the
top of the panel*, which can sit off-screen: it is how the cancellation incident
went unseen.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| The cancellation incident's cause | Not reproduced: every read the flow makes succeeded on live with complete data, the screen replayed with that data worked, and the decision worked on PGlite. It worked after both servers were restarted, so a stale server is the likely explanation. `ea6d510` makes any such failure visible | Accepted (reason above) |
| The trigger's `processed_by` | 039's trigger records the reviewing coordinator, falling back to the assigned one, not whoever rejected (`039:141`). The two are the same in every current flow | Accepted (reason above) |
| Server text on two screens outside 402 | Closing a clarification (`CoordinatorRequestDetail.jsx:436`) and SCRUM-355's reopen (`MyEventRequests.jsx:247`) still show the server's text | Their stories |
| `getChangeRequestById` | Called by no route and no real test (one test checks only that it is exported); the live check script `check-event-change-request-service.js` uses it. It is most of `eventChangeRequestService.js`'s uncovered 21% | Optional |
| `changeRequestOutcome.js` | SCRUM-379's outcome helper is now used only by its own unit test; the screens use `changeRequestDisplay.js` (the merge of 30 October). Delete it, or point it at `outcomeLabel` | SCRUM-379 |
| `migrations/AGENTS.md` | Still tells authors to restate `notifications_type_known` whole, the hazard that broke 402 on live (D11) | The team's call |
| The safety statuses and Confirmed | Proved in PGlite, not clicked: reaching Safety review or Confirmed by hand takes a full safety flow | Accepted (reason above) |
| SCRUM-489's case document | `docs/test-cases/SCRUM-489.md:318` still marks AC7-02 "cannot be tested as written"; 402's `SCRUM402_AC5_while_%s_a_significant_field_goes_through_395_and_the_event_is_approved` now proves it | Done in this PR |

### Technical debt, left

- **`backend/src/routes/eventRequests.js` and `eventChangeRequestService.js` stay
  ungated**, as they always were.
- **The backend has no lint script.** The frontend's 24 warnings are not 402's.
- **Restate from 039:** `create_change_request_group` is now defined in 039, so
  anyone who changes it must restate it from 039, not 036.

### Process notes

- **Existing tests touched,** each renamed `SCRUM402_…` where behaviour changed by
  design: brief 1's SCRUM-363 Confirmed cases, four SCRUM-32 route tests and
  SCRUM-37's field test; SCRUM-333's `/mine` select test; SCRUM-347's closed-outcome
  test; two AC2 cases re-stated when 039's trigger closed their group; and the three
  SCRUM-379 tests of the merge of 30 October.
- **Case document order:** `docs/test-cases/SCRUM-402.md` was written before the
  tests and the code; each later round added its cases and a Marked line.

---

## 5. For the team

- **`notifications_type_known`.** Any later migration that restates it whole must
  keep `change_request_decided` and `change_request_significant_submitted`, or
  better, append to the live list as 036 and 039 do. 033, 034 and 038 do not touch
  it (checked 30 October 2026); 037 was the last whole restate.
- **`create_change_request_group`.** Any restate must start from 039, which adds
  the rejected-event refusal to 036's.

---

## Before the examination

- **Be ready for "why can a request hold several fields?"** C4 says one request may
  cover several fields (`docs/requirements.md:124`); D10 groups them by a column, so
  they are accepted or declined together. Evidence:
  `SCRUM402_AC1_one_submission_is_one_group_of_rows_named_by_the_first` and
  `SCRUM402_AC1_one_card_per_submission_with_current_and_requested_values_the_note_and_the_date`.
- **Be ready for "what happens to a date change on a Confirmed event?"** AC5, D7:
  it goes through 395, which flags what it affects and returns the event to Approved;
  ordinary fields alone revert it first. Evidence:
  `SCRUM402_AC5_a_confirmed_events_significant_field_goes_through_395` and
  `SCRUM402_AC5_a_confirmed_event_with_ordinary_fields_only_returns_to_approved_first`.
- **Be ready for "how does the history know a row came from a change request?"**
  D3, AC6: 402 sets two transaction settings, and the history's columns default to
  them, so 387's and 395's inserts are labelled without restating 395; a check makes
  the source and the link agree. Evidence:
  `SCRUM402_AC6_387s_rows_are_labelled_change_request_and_linked`,
  `SCRUM402_AC6_395s_rows_are_labelled_the_same_way_without_395_restated` and
  `SCRUM402_AC6_%s_is_refused_by_the_check`.
- **Be ready for "why did the notices break, and how do you know they won't
  again?"** D11: three later migrations restated the list whole on live and dropped
  402's types. 039 re-appends them to whatever is live; the full-chain test proves
  they survive every restate in the repo, and the frontend's type test fails if a
  later migration drops them. Evidence:
  `SCRUM402_AC11_the_outcome_notice_type_survives_every_later_restate`,
  `SCRUM402_AC11_039_restores_what_a_whole_restate_dropped_and_a_second_run_changes_nothing`
  and `SCRUM172_AC6_every_known_type_has_wording`.
- **Be ready for "what if the Organiser asks to cancel?"** AC7, D8: the request
  stands alone; accept marks it before cancelling, so the cancel's closing of the
  event's other requests leaves this one accepted. Evidence:
  `SCRUM402_AC1_a_cancellation_must_be_alone_in_its_group`,
  `SCRUM402_AC7_accepting_cancels_with_the_organisers_request_and_the_coordinators_reason`
  and `SCRUM402_AC7_an_under_review_event_is_cancelled_with_the_reason_the_panel_sends`.
- **Be ready for "why is a request processed only once?"** AC10: the gate refuses a
  processed group (`036:639`), and each update touches only open rows and refuses if
  none are left, so two coordinators racing cannot both apply it. Evidence:
  `SCRUM402_AC10_a_group_is_processed_once_only` and
  `SCRUM402_AC10_an_already_processed_group_closes_the_review_and_rereads_the_list`.
