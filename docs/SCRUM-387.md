# SCRUM-387 — Edit Event Information (Event Coordinator)

**Story:** Edit Event Information (E3) — Event Coordinator
**Closing subtask:** SCRUM-394 (this document)
**Status as of 25 October 2026:** built and tested; all nine criteria done (section 1). The click-through passed: every step worked as expected, as reported by Calven on 25 October 2026.

This document is the record of what SCRUM-387 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC3.

The case-by-case mapping is `docs/test-cases/SCRUM-387.md`: 82 cases, 48 backend
and 34 on the screen, each naming the tests that prove it. It also holds the
design decisions D1 to D13 in full, with the alternatives rejected. This document
cites it rather than repeating it.

**The short version, for anyone asked "what changed?":**

- The coordinator assigned to an event can now edit its information directly, from
  an Edit event information page on their event screen. Nobody else can: not the
  Lead, not another coordinator, not the Organiser.
- Under review and Pending clarification, any of the nine fields. Approved, Safety
  review and Safety approved, only the name, purpose and description. Confirmed and
  every other status, nothing.
- Every changed field is recorded with its old and new value, who, when and a
  required reason, in an append-only change history. The Organiser, the assigned
  coordinator and the Lead can read it.
- The Organiser is told with one notice per save, naming the fields and the reason.
  Safety Officers are not told.
- A save is refused if any field it changes no longer holds what the form showed
  when it was opened, so an Organiser's amendment is never silently overwritten.
- Once an event is approved, its date, time, attendance, requirements and equipment
  still change only through Revise event details (SCRUM-395).

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-388 | Migration 022: `edit_event_request_details`, `event_detail_value`, `event_change_history`'s new field names, its `source` column and append-only trigger, and `event_details_changed` added to `notifications_type_known` | `37b530c` |
| SCRUM-389 | The field and status lists: `backend/src/domain/eventDetailField.js`, with its schema test and the PGlite case that sends every field (D2); and its frontend mirror `frontend/src/services/eventDetailFields.js`, tested against the backend file read as text | `37b530c`, `07644a5` |
| SCRUM-390 | `PATCH /:id/details` and `GET /:id/change-history`; `editEventRequestDetails`, `getEventChangeHistory` and the shared `requireHistoryReader` in the service; `validateEventDetailsEdit`; the route, validation and PGlite suites | `37b530c` |
| SCRUM-391 | `EventDetailsEditPanel.jsx`, the Edit event information button and page on `CoordinatorRequestDetail.jsx`, `updateEventRequestDetails`, the `event_details_changed` wording, the `SCRUM387_FILES` gate | `07644a5` |
| SCRUM-392 | `EventChangeHistory.jsx`, placed on the coordinator's detail after the past decisions and on the Organiser's row as a Change history disclosure; `getEventChangeHistory` | `07644a5` |
| SCRUM-393 | The case document, backend cases in `37b530c` and UI cases in `07644a5`; the sweeps: every test named `SCRUM387_ACn_…`, the teeth checks in both commits | `37b530c`, `07644a5` |
| SCRUM-394 | This document | `c3ec269` |
| Merge of dev | SCRUM-27 (PR #82): its migrations 017 and 018, before ours; neither touches 022's objects or restates `notifications_type_known` | `0dfbd9b` |
| PR #84 review | The fix-ups below: the period checked on the screen, a malformed id refused with 400, one save's history rows in a stable order, three tidy-ups | this commit |

Dev had not moved when the story was built (`c1c3573`, checked 25 October 2026).
It moved before the review, and Calven merged it (`0dfbd9b`, SCRUM-27's PR #82).

### PR #84 review, 25 October 2026

A teammate's review raised eight points. Five were fixed; two are recorded as gaps
(section 4); none needed a migration, as 022 is live.

1. **An expired hold still refuses a date edit.** Recorded as a gap (section 4,
   "Expired holds").
2. **The screen did not name the field when a period would end before it starts.**
   Fixed: the panel checks the period the save would leave, an unaltered side taken
   from the snapshot, and shows the fault beside Proposed end, sending nothing
   (`EventDetailsEditPanel.jsx:150–159`, AC6-15). Looking for other ways the server
   could answer "No changes" to a save the form thought was a change found one:
   attendance was compared as text, so "100.0" over a stored 100 was sent as 100 and
   refused. It is now compared as the number sent (`:83–90`, AC9-10). Text already
   agreed with the server, and dates compare as the device's datetime-local text,
   one instant per minute. 022's own checks stay as the backstop.
3. **A malformed id was a 500.** Fixed: `editEventRequestDetails` and
   `getEventChangeHistory` refuse it with 400 before any query
   (`eventRequestService.js:2789`, `:2821`; AC6-16, AC7-15). Both routes answered 500
   before: Postgres's 22P02 from the uuid cast is not one `translateError` maps.
4. **Other write paths leave no history.** Recorded as a gap (section 4, "Other
   write paths").
5. **One save's rows came back in a random order.** Fixed: the history is ordered by
   `changed_at` desc, then `field_name`, then `id` (`eventRequestService.js:2833–2835`),
   since one save's rows share `changed_at` and a uuid tie-break is random (AC7-14).
6. **`STATUSES_ALLOWING_ANY_EDIT` and `STATUSES_ALLOWING_ORDINARY_EDITS` in
   `backend/src/domain/eventDetailField.js` were used by nothing but tests.** Removed;
   the status matrix is 022's alone. The frontend's own lists, which the screen uses,
   are now pinned as literals to D3's matrix rather than to the backend file (AC3-07).
7. **The panel wrote "4,000" by hand.** Its counter and its error are now built from
   `REASON_MAX_LENGTH` (`EventDetailsEditPanel.jsx:30–31`). The backend and 022 are
   unchanged.
8. **`TIMESTAMP_FIELDS` was declared twice.** Now exported once from
   `eventDetailFields.js` (`:26`) and imported by both components.

### Verification as of 25 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | 7742 passing and 2 todo across 181 files, after the PR #84 fix-ups and the merge of dev (SCRUM-27). 7640 and 2 todo across 178 at `07644a5`. At `c1c3573` before the story: 7533 passing and 2 todo across 174 files (run on 25 October 2026 from a `git archive` of that commit) |
| Frontend suite (`npm run test:coverage` in `frontend`) | 3899 passing across 169 files, after the fix-ups and the merge; every coverage gate met. 3849 across 168 at `07644a5`. At `c1c3573`: 3765 passing across 162 files, run the same way. `npm run lint` 0 errors (23 warnings, all pre-existing: the one in `MyEventRequests.jsx` is at HEAD too); `npm run build` passes |
| SCRUM-387's gate | `SCRUM387_FILES` in `frontend/vite.config.js` (`:240`): `EventDetailsEditPanel.jsx`, `EventChangeHistory.jsx` and `eventDetailFields.js` at 100% statements, branches, functions and lines |
| Gates that held | `notificationDisplay.js` stays at 100% in SCRUM-17's gate and `notificationLink.js` in SCRUM-172's. `CoordinatorRequestDetail.jsx`, `MyEventRequests.jsx` and `eventRequestService.js` stay ungated, as before |
| SCRUM-387's own tests | 199 titles once parametrised cases are expanded, every one named `SCRUM387_ACn_…`. Backend 109: 62 in `scrum387EditEventDetailsDatabase.test.js`, 32 in `scrum387EditEventDetailsRoutes.test.js`, 4 in `eventDetailField.test.js`, 11 in `eventDetailsEditValidation.test.js`. Frontend 90: 38 in `scrum387EventDetailsEditPanel.test.jsx`, 25 in `scrum387CoordinatorEditEvent.test.jsx`, 9 in `scrum387EventChangeHistory.test.jsx`, 12 in `scrum387EventDetailFields.test.js`, 4 in `scrum387NotificationDisplay.test.js`, 2 in `scrum387EventRequestService.test.js` |
| PGlite | `scrum387EditEventDetailsDatabase.test.js` runs 022 on the full schema (`createSchemaDb()`: the baseline, then every migration, 010 to 018 and 022), with statuses reached through the real workflow functions where they exist |
| Live database | 022 applied by Calven to the shared Supabase project on 24 October 2026. Both checks matched: the live notification list before, and the four-part check after. No live script was run by us |
| Test-case document | 82 cases (48 backend, 34 UI): **82 proved**, 0 not yet implemented, 0 that cannot be written as specified. 21 are traps, 11 of them on the screen. Five were added and three amended after the PR #84 review |
| Click-through | Passed: every step worked as expected, as reported by Calven on 25 October 2026. The final SQL check returned no rows the first time because it filtered on the event's exact name; a name-free query was given as a re-check, and its result is not yet recorded here |

**Teeth checks**: each test was checked by breaking the line it proves, watching
it fail, and restoring the file from an in-memory copy (never `git checkout`).
49 in all: 22 for the backend (SCRUM-388 to SCRUM-390), 19 for the screen
(SCRUM-391, SCRUM-392) and 8 for the PR #84 fix-ups, the last eight rows. Line
numbers are the files as they now stand.

| AC | What was broken | What failed |
|---|---|---|
| AC1 | 022's caller check made a no-op (`022:143`) | 8 PGlite tests: the five strangers (another coordinator, the Lead, the Organiser, another Organiser, a null caller), the coordinator reassigned away, and a stranger on Confirmed and on Draft |
| AC1 | `coordinatorOnly` dropped from `PATCH /:id/details` (`eventRequests.js:1053`) | 7 route tests: every other role reaching the function |
| AC1 | The caller taken from the body, not the token (`eventRequests.js:1054`) | `SCRUM387_AC1_the_caller_is_the_tokens_user_and_the_body_is_sent_normalised` |
| AC1 | The button shown to any coordinator (`CoordinatorRequestDetail.jsx:273`) | `SCRUM387_AC1_a_coordinator_it_is_not_assigned_to_never_sees_it` |
| AC1 | The button's role check dropped (`CoordinatorRequestDetail.jsx:272`) | `SCRUM387_AC1_a_lead_whose_id_is_the_holders_never_sees_it` |
| AC2 | Review statuses treated as planning (`022:218`) | 15 PGlite tests: every significant field in review |
| AC2 | D4's leftover-arrangements refusal removed (`022:248`) | Both `SCRUM387_AC2_a_reopened_request_with_%s_refuses_a_significant_edit_and_names_it` |
| AC2 | Venue holds not counted (`022:236`) | The leftover-hold case of the same test |
| AC2 | Review statuses shown only the ordinary fields (`eventDetailFields.js:55`) | 7 frontend tests across the panel, screens and fields files |
| AC3 | The planning refusal removed (`022:219`) | 4 PGlite tests: each planning status and the mixed save |
| AC3 | The safety statuses refused outright (`022:178`) | 4 PGlite tests |
| AC3 | Planning statuses shown all nine fields (`eventDetailFields.js:56`) | 4 frontend tests |
| AC4 | The Confirmed check removed (`022:174–177`) | `SCRUM387_AC4_a_confirmed_event_refuses_even_an_ordinary_field` (it became `EVENT_STATUS_NOT_ALLOWED`) |
| AC4/AC5 | The button on every status but draft (`CoordinatorRequestDetail.jsx:273`) | 6 screens tests: confirmed and the four other statuses, and the refetch to confirmed |
| AC4 | The button's status read from the event as first opened (`CoordinatorRequestDetail.jsx:273`) | `SCRUM387_AC4_it_goes_when_a_refetch_brings_the_event_to_confirmed` |
| AC5 | Cancelled added to the allowed statuses (`022:178`) | The cancelled case of `SCRUM387_AC5_an_event_that_is_%s_is_refused_naming_its_status` |
| AC6 | The validator never throws (`eventRequestValidation.js:560`) | 8 validation and route tests |
| AC6 | 022's reason check removed (`022:148`) | The three PGlite reason cases |
| AC6 | 022's no-change check removed (`022:205`) | `SCRUM387_AC6_a_save_with_no_real_change_is_refused_with_22023` |
| AC6 | The panel's server faults not shown beside fields (`EventDetailsEditPanel.jsx:177`) | `SCRUM387_AC6_every_fault_is_shown_beside_its_field_at_once_with_a_summary` |
| AC6 | The panel's blank-reason check removed (`EventDetailsEditPanel.jsx:146`) | `SCRUM387_AC6_a_blank_reason_is_shown_beside_the_box_and_nothing_is_sent` |
| AC6 | A cleared box sent as `""`, not null (`EventDetailsEditPanel.jsx:95`) | Both cleared-box tests |
| AC6/AC9 | The server's text shown instead of the panel's own (`EventDetailsEditPanel.jsx:181`) | 11 of the 12 `SCRUM387_AC1_AC3_AC4_AC5_AC9_%s_is_said_in_the_screens_own_words` cases (the network failure has no server text) |
| AC7 | History rows written as `significant_change` (`022:283`) | `SCRUM387_AC7_one_row_per_changed_field_with_old_new_who_why_and_source` |
| AC7 | The append-only trigger not created (`022:49–52`) | Both `SCRUM387_AC7_a_history_row_cannot_be_%s` |
| AC7 | The history read oldest first (`eventRequestService.js:2833`) | `SCRUM387_AC7_the_organiser_reads_the_history_newest_first_with_names` |
| AC7 | Any coordinator may read the history (`eventRequestService.js:1716`) | `SCRUM387_AC7_a_coordinator_it_is_not_assigned_to_gets_a_404`, and SCRUM-355's own 404 case (the rule is shared) |
| AC7 | The history re-sorted on the screen (`EventChangeHistory.jsx:69`) | 2 history tests, `SCRUM387_AC7_keeps_the_servers_newest_first_order` among them |
| AC7 | The history shown to any coordinator (`CoordinatorRequestDetail.jsx:1008`) | `SCRUM387_AC7_a_coordinator_it_is_not_assigned_to_does_not_read_it` |
| AC7 | The history section removed from its place (`CoordinatorRequestDetail.jsx:1008–1013`) | 4 screens tests, the placement test among them |
| AC7 | The history's `updatedAt` key dropped (`CoordinatorRequestDetail.jsx:1011`) | `SCRUM387_AC7_a_refetch_that_moves_updatedAt_rereads_it_and_one_that_does_not_leaves_it`. This one survived at first: the save and the significant change both swap the detail for a page and back, so the history remounted anyway. The test was added for a refetch while the detail stays open |
| AC7 | The Organiser's history read on load (`MyEventRequests.jsx:92`) | `SCRUM387_AC7_each_non_draft_row_has_one_and_nothing_is_read_until_it_is_opened` |
| AC8 | The notice sent to the coordinator (`022:289`) | `SCRUM387_AC8_one_notice_to_the_organiser_per_save_with_the_fields_and_reason` |
| AC8 | Raw field names in the wording (`notificationDisplay.js:663`) | 2 notice tests |
| AC9 | The stale check removed (`022:191`) | Both stale-value PGlite tests |
| AC9 | Values compared as text, not typed (`022:186–187`) | `SCRUM387_AC9_the_same_instant_in_another_zone_is_not_stale` |
| AC9 | `expected` read from the latest prop (`EventDetailsEditPanel.jsx:172`) | `SCRUM387_AC9_the_snapshot_is_taken_when_the_form_opens_not_from_a_later_prop` |
| AC9 | Every shown field sent (`EventDetailsEditPanel.jsx:171`) | 2 panel tests, the only-altered test among them |
| AC9 | A date compared with the stored string, not the form's own (`EventDetailsEditPanel.jsx:138`) | 7 panel tests: every save that left the start alone sent it |
| D2 | 022's field list loses `equipmentRequirements` (`022:105`) | 3 PGlite tests |
| D2 | The domain list moves a field (`eventDetailField.js:19`) | 3 domain and PGlite tests |
| AC6 (review 2) | The panel's period check made a no-op (`EventDetailsEditPanel.jsx:156`) | Both `SCRUM387_AC6_moving_only_the_%s` period tests |
| AC9 (review 2) | Attendance compared as text again (`EventDetailsEditPanel.jsx:89`) | Both attendance cases of `SCRUM387_AC9_%s_is_nothing_to_save_and_calls_nothing`. It survived at first: user-event normalises what it types into a number box, so the cases set the value directly, as a browser keeps it |
| AC6 (review 3) | The edit's id check removed (`eventRequestService.js:2789`) | `SCRUM387_AC6_a_malformed_id_is_refused_with_400_before_the_database` |
| AC7 (review 3) | The history's id check removed (`eventRequestService.js:2821`) | `SCRUM387_AC7_a_malformed_id_is_refused_with_400_before_the_database` |
| AC7 (review 5) | The `field_name` tie-break removed (`eventRequestService.js:2834`) | `SCRUM387_AC7_one_saves_rows_always_come_back_in_field_name_order` (PGlite, through the service) and the route's order assertion |
| AC3 (review 6) | `safety_approved` dropped from the frontend's matrix (`eventDetailFields.js:45–50`) | `SCRUM387_AC3_the_status_lists_are_the_case_documents_matrix` |
| AC6 (review 7) | `REASON_MAX_LENGTH` moved to 3999 (`EventDetailsEditPanel.jsx:30`) | `SCRUM387_AC6_the_counter_counts_characters_as_the_server_does_and_4000_is_the_limit`: the counter and the limit both moved with it |
| AC6, AC9 (review 8) | `TIMESTAMP_FIELDS` loses `proposedEnd` (`eventDetailFields.js:26`) | 4 tests in the panel and fields files, both components reading the one list |

---

## 1. Acceptance criteria

| AC | Criterion (in substance) | Status |
|---|---|---|
| AC1 | Only the coordinator assigned to the event can edit it. | **Done** |
| AC2 | Under review and Pending clarification, any field can be edited. A request reopened with leftover arrangements has its significant fields refused, with a message saying what it holds. | **Done**; the reopened case is proved in PGlite, not by hand (section 4) |
| AC3 | Approved, Safety review and Safety approved allow the ordinary fields only (name, purpose, description). A significant field is refused, pointing to the significant change process (SCRUM-395). | **Done**; the safety statuses are proved in PGlite, not by hand |
| AC4 | A Confirmed event refuses every edit. | **Done** |
| AC5 | Every other status is refused, with a message naming the status. | **Done**; a Draft is refused as a stranger's call, 403 (D15) |
| AC6 | The values are held to SCRUM-10's rules, and every fault is listed together. | **Done** |
| AC7 | Each changed field is recorded (field, old, new, coordinator, time, reason), readable newest first by the Organiser, the assigned coordinator and the Lead. | **Done** |
| AC8 | The Organiser is notified. | **Done** |
| AC9 | A value that changed since the form was opened is refused. | **Done** |

**Tally:** 9 done, 0 partial, 0 deferred.

**Test cases:** 82 (48 backend, 34 UI); 82 proved.

### Evidence for each criterion

The click-through was reported as a whole ("every step worked as expected"), so
each row's click-through column names the step the criterion rests on, not a
separate result.

| AC | Code (file, line) | Proved by | Click-through |
|---|---|---|---|
| AC1 | 022's caller check (`022:137–145`); `coordinatorOnly` (`eventRequests.js:1053`); `canEditDetails` (`CoordinatorRequestDetail.jsx:272`) | `SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message` (PGlite); `SCRUM387_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing` (route); `SCRUM387_AC1_%s_never_sees_it` (screen) | The button shows for the holder only |
| AC2 | The status matrix (`022:172–181`); D4 (`022:223–253`); `editableDetailFields` (`eventDetailFields.js:54`) | `SCRUM387_AC2_%s_is_editable_under_review`, `SCRUM387_AC2_a_reopened_request_with_%s_refuses_a_significant_edit_and_names_it` (PGlite); `SCRUM387_AC2_a_save_returns_to_the_updated_event_names_the_fields_and_rereads_the_history` (screen) | An edit under review, saved and shown |
| AC3 | `022:218–221`; the panel's field set and pointer (`EventDetailsEditPanel.jsx:110`, `:225`) | `SCRUM387_AC3_a_significant_edit_is_refused_while_%s`, `SCRUM387_AC3_a_mixed_save_in_planning_is_refused_whole` (PGlite); `SCRUM387_AC3_an_event_that_is_%s_shows_only_name_purpose_and_description` (panel) | An Approved event shows three fields |
| AC4 | `022:174–177`; the button's status list (`CoordinatorRequestDetail.jsx:273`) | `SCRUM387_AC4_a_confirmed_event_refuses_even_an_ordinary_field` (PGlite); `SCRUM387_AC4_it_goes_when_a_refetch_brings_the_event_to_confirmed` (screen) | No button on a Confirmed event |
| AC5 | `022:178–181` | `SCRUM387_AC5_an_event_that_is_%s_is_refused_naming_its_status` (PGlite); `SCRUM387_AC4_AC5_it_is_not_offered_while_%s` (screen) | — |
| AC6 | `validateEventDetailsEdit` (`eventRequestValidation.js:514`); 022's own checks (`022:147–169`, `:204–212`, `:255–261`); the panel's field errors (`EventDetailsEditPanel.jsx:177`) | `SCRUM387_AC6_lists_every_fault_together` (validation); `SCRUM387_AC6_every_fault_is_listed_in_one_400_and_nothing_is_queried` (route); `SCRUM387_AC6_every_fault_is_shown_beside_its_field_at_once_with_a_summary` (panel) | — |
| AC7 | The history insert (`022:276–284`); the trigger (`022:37–52`); `GET /:id/change-history` (`eventRequests.js:542`); `requireHistoryReader` (`eventRequestService.js:1710`); `EventChangeHistory.jsx`; its two placements (`CoordinatorRequestDetail.jsx:1008`, `MyEventRequests.jsx:81`) | `SCRUM387_AC7_one_row_per_changed_field_with_old_new_who_why_and_source`, `SCRUM387_AC7_a_history_row_cannot_be_%s` (PGlite); `SCRUM387_AC7_the_organiser_reads_the_history_newest_first_with_names` (route); `SCRUM387_AC7_each_non_draft_row_has_one_and_nothing_is_read_until_it_is_opened` (screen) | The history on both screens after a save |
| AC8 | The notice (`022:286–300`); its wording (`notificationDisplay.js:661`) | `SCRUM387_AC8_one_notice_to_the_organiser_per_save_with_the_fields_and_reason`, `SCRUM387_AC8_an_edit_in_safety_review_tells_no_safety_officer` (PGlite); `SCRUM387_AC8_names_the_event_the_fields_by_their_labels_and_the_reason` (notice) | The Organiser's inbox shows the notice |
| AC9 | Compare-and-set (`022:183–195`), typed by `event_detail_value` (`022:67`); the panel's snapshot (`EventDetailsEditPanel.jsx:109`) and the body it sends (`:171–172`) | `SCRUM387_AC9_an_organisers_amendment_after_the_form_opened_makes_the_save_stale` (PGlite); `SCRUM387_AC9_the_snapshot_is_taken_when_the_form_opens_not_from_a_later_prop` (panel) | The two-window stale edit is refused |

---

## 2. Traceability: AC3, end to end

**User story** → **AC3** → **test cases** AC3-01 to AC3-07
(`docs/test-cases/SCRUM-387.md`) → **test classes** (the files below) → **code**.
AC3 is the criterion the Week 7 change shaped: once an event is in planning,
the coordinator may still correct how it is described, but what it is (its date,
time, attendance, requirements and equipment) changes only through the
significant change process, which flags what is affected. Take the assigned
coordinator editing an Approved event.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen: the button | `CoordinatorRequestDetail.jsx:272–273` (`canEditDetails`), `:587` (the button), `:524` (the page in place of the detail) | Shown to the holder, with the coordinator role, in the five editable statuses, read from the latest event | `SCRUM387_AC1_the_assigned_coordinator_sees_it_while_%s`, `SCRUM387_AC3_in_approved_it_shows_the_ordinary_fields_and_points_to_revise_event_details` |
| Screen: the fields | `editableDetailFields` (`eventDetailFields.js:54–57`), taken once when the panel opens (`EventDetailsEditPanel.jsx:109–117`) | Approved, Safety review and Safety approved get name, purpose and description; the significant fields are left out, not shown disabled | `SCRUM387_AC3_an_event_that_is_%s_shows_only_name_purpose_and_description` |
| Screen: the pointer | `EventDetailsEditPanel.jsx:225–229` | "The date, time, attendance, requirements and equipment are changed through Revise event details." Revise event details stays on the detail, unchanged, for Approved, Confirmed and the safety statuses | The same test; SCRUM-395's own suites, unmodified |
| Screen: the save | `handleSave` (`EventDetailsEditPanel.jsx:133`), the changed fields only (`:137`), the body (`:171–172`) | Only the fields the coordinator altered are sent, each with the value the form opened with | `SCRUM387_AC9_sends_only_the_altered_field_with_the_value_the_form_opened_with` |
| Frontend service | `updateEventRequestDetails` (`frontend/src/services/eventRequestService.js:131`) | `PATCH /event-requests/:id/details` with `{ changes, expected, reason }` | `SCRUM387_AC9_the_edit_patches_the_details_endpoint_with_changes_expected_and_reason` |
| Route | `PATCH /:id/details` (`backend/src/routes/eventRequests.js:1053`), `coordinatorOnly` (`:203`) | Any role but a coordinator is 403 with no query; the caller is the token's | `SCRUM387_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing` |
| Service | `editEventRequestDetails` (`backend/src/services/eventRequestService.js:2786`); the 409 codes (`:164`, mapped at `:280`) | SCRUM-10's rules (`validateEventDetailsEdit`, `eventRequestValidation.js:514`), one rpc, `translateError` | `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` |
| SQL: who, then status | `022:137–145` (the caller), `022:172–181` (Confirmed, then the five statuses) | A stranger is 42501 before any status is read; Approved and the safety statuses pass on to the field check | `SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message` |
| SQL: the matrix | `c_significant` (`022:107–110`), `v_significant` (`022:216`), the raise (`022:218–221`) | A save that changes any significant field in planning is refused whole with `SIGNIFICANT_CHANGE_REQUIRED`, ordinary keys included | `SCRUM387_AC3_a_significant_edit_is_refused_while_%s`, `SCRUM387_AC3_a_mixed_save_in_planning_is_refused_whole` |
| SQL: the write | `022:263–300` | The fields, one history row each with `source = 'direct_edit'`, one notice to the Organiser | `SCRUM387_AC3_an_ordinary_edit_is_allowed_while_%s` |

**What each refusal becomes on screen**, keyed on the status and `code`, never the
server's text (`EventDetailsEditPanel.jsx:46–67`):

| Response | The panel says | Why it happens |
|---|---|---|
| 400 with faults on shown fields | Each fault beside its field, all at once, and "Some details need correcting. Nothing has been saved." | SCRUM-10's rules (AC6) |
| 400 naming no shown field | "These changes could not be saved as written. Check each field and the reason, then try again." | A fault on `changes` or `expected`, or 022's own 22023 |
| 403 | "You're no longer the coordinator for this event." | Handed over while the form was open (AC1) |
| 404 | "This event can't be found. It may have been removed." | — |
| 409 `SIGNIFICANT_CHANGE_REQUIRED` | "This event has been approved since you opened the form, so its date, time, attendance, requirements and equipment can no longer be edited here. Go back and use Revise event details." | Approved while a review-time form was open (AC3) |
| 409 `EVENT_CONFIRMED` | "This event has been confirmed since you opened the form, so it can no longer be edited here. Go back and use Revise event details." | AC4 |
| 409 `EVENT_STATUS_NOT_ALLOWED` | "This event's status has changed since you opened the form, and it can no longer be edited. Go back to see where it stands." | Cancelled, rejected or otherwise moved on (AC5) |
| 409 `EVENT_HOLDS_ARRANGEMENTS` | "This request still holds venue bookings, holds or equipment from before it was reopened. Release them, or approve the request and use Revise event details, before changing the date, time, attendance, requirements or equipment. The name, purpose and description can still be saved on their own." | D4 (AC2) |
| 409 `EVENT_CHANGED_SINCE_OPENED` | "Someone changed this event after you opened the form. Go back to see the current details, then make your change again." What was typed stays until Back | AC9 |
| Any other 409 | "This event has changed since you opened the form. Go back to see the current details, then try again." | A code this build does not know |
| 401 | "Your session has expired. Please sign in again." | — |
| Anything else | "Your changes could not be saved. Please try again." | — |

Each of these is pinned by `SCRUM387_AC1_AC3_AC4_AC5_AC9_%s_is_said_in_the_screens_own_words`,
whose every refusal carries server text the screen must not show.

**Click-through.** Run by Calven in the browser against the shared Supabase
project after 022 was applied. Every step worked as expected, as reported by
Calven on 25 October 2026; the results were reported as a whole, not step by step.
The final SQL check returned no rows the first time because it filtered on the
event's exact name, which the click-through had just edited; a name-free query was
given as a re-check, and its result is not yet recorded here.

---

## 3. Design decisions

D1 to D13 are argued in full, with the alternative rejected, in
`docs/test-cases/SCRUM-387.md` ("Design decisions"). The summaries below point
there. D14 to D16 are this document's.

### D1. One function does the whole save

`edit_event_request_details` (022:84) locks the row, checks the caller, the
status and the expected values, and writes the fields, the history and the notice
in one transaction. *Rejected: checks in Express, then an UPDATE and an insert*:
another save could change the row between the check and the write, and a failed
insert would leave fields changed with no history.

### D2. One field list, kept in step by a test

`eventDetailField.js` names the nine fields, and 022 holds the same nine
(`022:96–106`). A PGlite case sends every field the module names, and one it does
not; the frontend's copy is compared with the backend file read as text.
*Rejected: reading the list from the database at run time*, one more query per
save for a list that only changes with a migration.

### D3. The status matrix — **answered by the requirements**

Any field in Under review and Pending clarification, the ordinary three in
Approved, Safety review and Safety approved, nothing otherwise. The safety
statuses allow ordinary edits, since a name or description does not change what
the Safety Officer reviews. Answered by the Week 9 Q&A, row 8, asked "In what
statuses of the event request can the Coordinator edit the information?" and
answered "once an event is Confirmed, information fields cannot be changed
directly. The co-ordinator can make changes before the final confirmed status."
The quote is from the course's Week 9 Q&A document, which is not in the repo.
*Rejected: no edits once approved*, which would send a typo in the name through
the significant change process.

### D4. Leftover arrangements refuse significant edits

A request rejected after arrangements were made, reopened (015 releases nothing)
and resubmitted can be under review while still holding them; moving its date
would leave them describing another event. *Rejected: releasing them*: changes
flag and notify and never un-book (AGENTS.md). D16 says what is counted.

### D5. A reason on every save, 1 to 4,000 characters — **confirmed by Calven, 24 October 2026**

Checked in the validator and again in 022 (`022:147–151`), counted in characters,
and copied onto every history row the save writes. *Rejected: a reason only for
significant fields*, which would leave a name change in the history with no why.

### D6. Reuse `event_change_history`

SCRUM-395's table, widened to the ordinary field names (`022:19–25`). *Rejected: a
second history table*: the Organiser would read two histories for one event.

### D7. The history's read rule is `getEventDecisionHistory`'s

The Organiser, and once past draft a Lead or the assigned coordinator; anyone else
404, as a missing id. Both reads share `requireHistoryReader`
(`eventRequestService.js:1710`). *Rejected: any coordinator*, which the decision
history already refuses.

### D8. One notice per save

`event_details_changed`, to the Organiser, naming every field the save changed
(`022:286–300`). *Rejected: one per field*: a five-field save would be five notices.

### D9. Confirmed refuses even ordinary fields — **answered by the requirements**

A confirmed event is what has been announced; any change goes through SCRUM-395,
which returns it to Approved. The Week 4 clarifications say that once an event is
confirmed, its information fields should not be changed ("After Confirmed: fields
lock", `docs/requirements.md:67`, [C4]). *Rejected: ordinary edits after
confirmation*. Open question 1.

### D10. No Safety Officer notice — **confirmed by Calven, 24 October 2026**

Ordinary fields are all a safety status allows, and they do not change what is
reviewed (`022:286`). *Rejected: re-notifying the Safety Officer*, a notice with
nothing for them to do.

### D11. A new route, `PATCH /:id/details`, coordinatorOnly

Not a branch of the Organiser's `PATCH /:id`, so each owner's rules sit on their
own URL (`eventRequests.js:1053`). 022 checks the caller again under the lock.
*Rejected: one PATCH that branches on the caller's role*.

### D12. Compare-and-set, refused with 409

The form sends the value it showed for each field it changes; 022 compares them
under the lock, typed through `event_detail_value` (instants as instants,
attendance as a number, text trimmed and blank as null), and names each stale
field (`022:183–195`). *Rejected: last write wins*, which would silently overwrite
an Organiser's clarification amendment.

### D13. Append-only history, with a source

A trigger refuses UPDATE and DELETE on `event_change_history` (`022:37–52`). A
`source` column says which path wrote each row: `significant_change` (the default,
so 395's insert is unchanged), `direct_edit`, and `change_request`, reserved for
SCRUM-402 (`022:27–34`). *Rejected: trusting every writer not to edit history*.

### D14. The migration is 022

017 to 019 are on SCRUM-27's branch (David), and 020 and 021 were left for others.
Calven claimed 022 in the group chat on 24 October 2026. 022 restates
`notifications_type_known` from 016, the latest on dev, adding one type
(`022:308–351`). No branch's 017 to 021 restates it: checked on 24 October 2026,
and again across every remote branch on 25 October 2026. *Rejected: taking the
next free number on dev* (017), which SCRUM-27's branch already uses.

### D15. A Draft gets 403, not a status message

A draft never has a coordinator (015's reopen clears it), so 022's caller check,
which runs first so a stranger learns nothing, always refuses it with 42501
(`022:135–145`). AC5 is proved for Submitted, Rejected, Cancelled and Completed;
the Draft case is `SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message`.
*Rejected: checking the status first*, which would tell any caller an event's status.

### D16. D4 counts five kinds of arrangement, not two

Approved or flagged bookings, pending or conflicting booking requests, active
holds, equipment requests not cancelled, and equipment reservations not released
(`022:227–243`): the same five that 013's `event_cancellation_impact_preview`
counts as still held, so "still holds" means one thing across the codebase. With
equipment counted, a review-time date change cannot set off 06's
`equipment_notify_event_period_changed`. *Rejected: bookings and holds only*.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| D4 and the safety statuses were proved in PGlite, not by hand | Reaching a reopened request with leftover arrangements, or Safety review, by clicking takes a full reopen or safety flow; PGlite drives the real functions instead | — |
| The Organiser cannot see a reopened draft's change history | The disclosure is limited to non-draft rows (brief 2's choice), though the server would let the Organiser read it | Optional |
| SCRUM-402 writes ordinary fields with no history row | `process_change_request` still writes them without one. 402 should call `edit_event_request_details`, or write `source = 'change_request'` rows itself, restating `event_change_history`'s checks from 022, not the baseline | SCRUM-402 (Calven) |
| The click-through's re-check | The name-free SQL query's result is not yet recorded (section 2) | Calven |
| Expired holds (PR #84 review, point 1) | D4's count follows 013's "active" rule (`022:234–236`) and does not check `expires_at`, so a hold past its expiry can refuse a date edit until the expiry job, which runs every 60 seconds (`venueHoldExpiryScheduler.js`, `DEFAULT_INTERVAL_MS`), marks it expired. Left as it is: fixing it needs a new migration restating the whole of `edit_event_request_details`, and 022 is live | A later migration |
| Other write paths (PR #84 review, point 4) | Change requests are SCRUM-402's to record, with `source = 'change_request'`. Clarification amendments (`reply_to_event_clarification_with_amendments`) are recorded nowhere yet. A trigger on `event_requests` was rejected: it cannot know who made a change or why, and it would write a second row for every change 395 and 387 already record | SCRUM-402 (Calven); amendments unowned |

### Technical debt, left

- **`backend/src/routes/eventRequests.js` stays ungated**, as it always was. Its
  94.6% statements comes from SCRUM-395's significant-change route, not this
  story's: both of 387's routes are covered.
- **The backend has no lint script.** The frontend's 23 lint warnings are
  pre-existing.
- **`event_change_history` is now append-only.** Anyone who later needs to correct
  a row must add a new row, not edit one; the trigger refuses UPDATE and DELETE for
  every role, the service role included.

### Process notes

- **Case document order:** `docs/test-cases/SCRUM-387.md` was written after the
  backend was drafted and before its tests; its header says so. The UI cases were
  written with their tests.
- **Existing tests touched:** seven frontend test files gained one
  `getEventChangeHistory` line in their strict `vi.mock` factories, as SCRUM-355
  did for `getEventDecisionHistory`; `notificationDisplay.test.js` gained one
  `FIXTURES` entry so `SCRUM172_AC6_every_known_type_has_wording` passes. No test
  body changed; SCRUM-395's two panel suites are untouched.
- **After the PR #84 review:** one backend test went with the lists it pinned
  (`SCRUM387_AC3_the_status_lists_are_real_statuses_with_review_inside_planning`),
  and the shared `tests/fixtures/pgliteSupabaseClient.js` gained `order`, `in` and
  awaited list reads, so AC7-14 reads the history through the real service on
  PGlite. Its single-row reads, which three other suites use, are unchanged.
- **SCRUM-484's invariant:** it reserves `&&` in SQL function bodies for the
  occupied-period rule, so 022 tests "touches a significant field" with `= any`
  (`022:214–216`).

---

## 5. Open questions for the team

1. **Should a coordinator be able to fix a typo in a Confirmed event's name (D9)?**
   Built as no, following Week 4.
2. **Should SCRUM-402 reuse `edit_event_request_details`?** Recommended: its
   history, compare-and-set and notice would then hold for change requests too.

---

## Before the examination

- **Be ready for "why can't the coordinator edit the date after approval?"** AC3,
  D3: once approved, venues, holds and equipment are arranged for that date, so a
  change must flag them, which is SCRUM-395's significant change process. Revise
  event details stays beside the button. Evidence:
  `SCRUM387_AC3_a_significant_edit_is_refused_while_%s` and
  `SCRUM387_AC3_an_event_that_is_%s_shows_only_name_purpose_and_description`.
- **Be ready for "why one function and not an UPDATE plus an insert?"** D1: the
  checks, the write, the history and the notice share one transaction under the row
  lock, so nothing can change between check and write, and nothing is written
  half. Evidence: every refusal in
  `scrum387EditEventDetailsDatabase.test.js` asserts the row, history and
  notifications unchanged, and `SCRUM387_AC3_a_mixed_save_in_planning_is_refused_whole`.
- **Be ready for "what if the Organiser changed it at the same time?"** AC9, D12:
  the form sends what it showed; 022 compares it under the lock and refuses a stale
  field with 409, and the panel keeps what was typed. The click-through's two-window
  step showed it. Evidence:
  `SCRUM387_AC9_an_organisers_amendment_after_the_form_opened_makes_the_save_stale`
  and `SCRUM387_AC9_the_snapshot_is_taken_when_the_form_opens_not_from_a_later_prop`.
- **Be ready for "why does a resubmitted request refuse a date change?"** D4, D16:
  a request reopened after rejection keeps its bookings, holds and equipment (015
  releases nothing), so a new date would leave them describing another event.
  Ordinary fields still save. Evidence:
  `SCRUM387_AC2_a_reopened_request_with_%s_refuses_a_significant_edit_and_names_it`
  and `SCRUM387_AC2_a_reopened_request_still_takes_an_ordinary_edit`.
- **Be ready for "how do you know the history can't be tampered with?"** D13: a
  trigger refuses UPDATE and DELETE on `event_change_history` for everyone, and
  the functions are closed to the client roles. Evidence:
  `SCRUM387_AC7_a_history_row_cannot_be_%s` and
  `SCRUM387_AC1_the_functions_stay_closed_to_the_client_roles`.
- **Be ready for "why is the reason required for a name fix?"** D5, Calven's
  decision of 24 October 2026: every row in the history says why, so the Organiser
  reading it never meets an unexplained change. Evidence:
  `SCRUM387_AC6_%s_is_refused_with_22023` (the three reasons) and
  `SCRUM387_AC6_a_blank_reason_is_shown_beside_the_box_and_nothing_is_sent`.
