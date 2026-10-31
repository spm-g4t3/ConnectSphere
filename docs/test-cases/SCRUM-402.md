# SCRUM-402 — Test Cases

**Story:** Process an Event Change Request (E3) — Event Coordinator
**Subtask:** SCRUM-409 (this document); the backend halves of SCRUM-403 to SCRUM-407
**Schema:** `035_change_request_cancellation_type.sql` and `036_process_change_requests.sql` (SCRUM-403), with `039_change_request_notice_types_restored.sql` putting back 036's notice types after later restates and `050_change_request_role_checks.sql` checking the caller's role inside the gate and the create, on top of 022's `edit_event_request_details`, 028's change-history source check, 013's `cancel_event_request` and the baseline's `apply_significant_event_change`.
**Written:** 27 October 2026, before the tests and the code.
**Marked:** 27 October 2026, SCRUM-403 to SCRUM-407 (backend): every case proved. AC5-04 moved from Safety approved to Confirmed, where the order it tests matters (387 allows a name in Safety approved, so the old case could not fail).
**Marked:** 28 October 2026, SCRUM-404's screen half and SCRUM-408 (brief 2): the screens' cases, each marked **(UI)**, after the backend's in every table, and AC1-11 for My events' count. Every one proved.
**Marked:** 29 October 2026, migration 039: SC-03 to SC-06 (SC-06 is SCRUM-347's rejected-event rule, moved under the lock), after 024, 032 and 037 restated the notification list whole and dropped 036's two types on live; AC10-05 for 039's rejection trigger, which also re-states AC2-03's rejected case and AC2-04 as groups the rejection closed. Every one proved.
**Marked:** 27 October 2026, the brief 1 fix-up: the Organiser's note (`organiser_note`, in 036 before it ran anywhere). AC1-08 to AC1-10 and AC7-04 added; AC7-03 reworded as the fallback it now is.
**Marked:** 30 October 2026, click-through step 23 (a cancellation on an Under review event did nothing visible): AC4-08 to AC4-12 for every review failure shown in its card, AC7-07 to AC7-10 for the cancellation with the live data. AC4-05's `…_with_no_rows_or_impact_still_opens` renamed `…_with_no_invalid_list_or_impact_still_opens`, since a preview with no rows now says it could not be reviewed (AC4-09). Every one proved.
**Marked:** 30 October 2026, the merge of dev with SCRUM-379 (033, 034) and SCRUM-571 (038): AC10-06 and AC10-07 for 034's `event_completed` on both screens, in 402's words. Three SCRUM-379 tests on those screens (six cases) renamed `SCRUM402_AC10_…`, since the screens are 402's. AC10-01's route test cited by its current name. Every one proved.
**Marked:** 31 October 2026, migration 050 (review on #95): AC1-18 and AC2-09, the caller's role checked inside `create_change_request_group` and `change_request_gate`. Every one proved.
**Marked:** 1 November 2026, the second review of #95: AC1-18 and AC2-09 now run over every other `user_role` value; AC1-19 keeps those lists complete, and AC1-20 pins a null caller on create to 42501. Every one proved.

This document is the written layer between SCRUM-402's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**. The decisions D1 to D9 are the brief's; their
arguments go into `docs/SCRUM-402.md` (brief 3).

---

## How case IDs relate to test names

Each case has a short stable ID (`AC5-03`) and an **Implemented by** column naming
the test that proves it. New tests are named `SCRUM402_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum402ProcessChangeRequestDatabase.test.js` | What 035 and 036 do on the full schema, statuses reached through the real workflow functions |
| route | `backend/tests/routes/scrum402ChangeRequestRoutes.test.js` (fake client) | The gates, the caller from the token, malformed ids, the bodies sent, and each refusal's status and \`code\` |
| domain | `backend/tests/domain/eventChangeField.test.js` | The change-field vocabulary and its mapping onto 387's detail fields |
| validation | `backend/tests/validation/scrum402ChangeRequestValidation.test.js` | The single and group shapes, and the decision's reason |
| UI, panel | `frontend/tests/components/scrum402ChangeRequestReviewPanel.test.jsx` | The coordinator's review: the list, the preview, accept, decline, cancellation, equipment, every refusal's words |
| UI, organiser | `frontend/tests/components/scrum402OrganiserChangeRequests.test.jsx` | The Organiser's form (several fields, a note, a cancellation) and their status list |
| UI, screens | `frontend/tests/components/scrum402CoordinatorScreens.test.jsx` | The panel on the event screen, the equipment hand-off, My events' count |
| UI, notices | `frontend/tests/services/scrum402NotificationDisplay.test.js`, and two tests in `notificationDisplay.test.js` | The two notices' wording and links, and that the frontend knows the types 036 appends |
| UI, display | `frontend/tests/services/scrum402ChangeRequestDisplay.test.js` | Labels, outcomes, classes, one formatter for both values, grouping |
| existing | the change-request suites listed in the report | Unchanged behaviour stays unchanged; by-design changes are renamed `SCRUM402_…` |

---

## The story

> As an Event Coordinator, I want to review and process change requests from the
> Event Organiser, so that agreed changes are applied and the affected
> arrangements are rechecked.

### Acceptance criteria (Jira, as edited 26 October 2026, in substance)

1. The assigned coordinator sees every open change request for their events, oldest
   first. One request may cover several fields (C4); each shows the fields with
   their current and requested values, the organiser's note and when it was sent.
2. Only the assigned coordinator can accept or decline, and only while the event is
   Under review, Pending clarification, Approved, Safety review, Safety approved or
   Confirmed. A Submitted event asks the coordinator to start the review first.
   Anyone else is refused.
3. A request is accepted or declined as a whole. Declining needs a reason.
4. Before accepting, the coordinator sees which fields are ordinary and which are
   significant, and for significant ones, 395's impact preview.
5. Accepting applies the values by status: in review directly (387); in planning
   and the safety statuses, ordinary directly and significant through 395, back to
   Approved; Confirmed back to Approved, significant through 395, ordinary directly.
   A venue request is a change to the venue requirements. SCRUM-10's validation
   applies; an invalid value is refused with the reasons.
6. Applied changes appear in the change history with the source "change request",
   linked to the request.
7. A cancellation request: accepting cancels the event through `cancel_event_request`
   with "the organiser's request" as the initiator; the reason is pre-filled with
   the organiser's note and the coordinator can edit it.
8. An equipment change: in planning or the safety statuses, accepting records it for
   the equipment lines; on a Confirmed event it first returns the event to Approved
   through 395.
9. "Something else": accepting records the coordinator's note; no field changes.
10. Processed once only; the outcome, coordinator, reason or note and time are
    recorded, and the organiser sees them.
11. The Organiser is notified of the outcome, by 402's function.
12. When the organiser requests a significant change, the assigned coordinator is
    notified (W1 §6).

---

## Case tables

Every refusal in the pglite file goes through a snapshot of the event row, its
change requests, its change history and its notifications, compared before and
after: a refusal changes nothing (the rollback cases).

### AC1 — requests arrive as groups, and the coordinator sees them

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | Approved, held | The organiser submits three fields in one go (`create_change_request_group`) | Three rows, one `request_group_id`, which is the first row's id | Proved (pglite): `SCRUM402_AC1_one_submission_is_one_group_of_rows_named_by_the_first` |
| AC1-02 | The same | An empty list; ten rows; a field twice; a field outside the vocabulary; a blank value | 22023 each; nothing written | Proved (pglite): `SCRUM402_AC1_a_group_with_%s_is_refused_with_22023` (five); (route) `SCRUM402_AC1_a_group_with_%s_is_a_400_before_the_function`; (validation) `SCRUM402_AC1_every_fault_in_a_group_is_named_by_its_row` |
| AC1-03 **(trap)** | The same | A cancellation with another field (D8) | 22023; nothing written. A cancellation alone is accepted | Proved (pglite): `SCRUM402_AC1_a_cancellation_must_be_alone_in_its_group`; (route) `SCRUM402_AC1_a_group_with_%s_is_a_400_before_the_function` (a_cancellation_with_another_field) |
| AC1-04 | A draft; another organiser's event; no such event | Submit | 22023 for the draft and the foreign event (SCRUM-11's rule, unchanged), P0002 for no event | Proved (pglite): `SCRUM402_AC1_only_the_organiser_and_never_on_a_draft`; (route, renamed) `SCRUM402_AC1_returns_400_for_a_change_requested_against_a_draft` |
| AC1-05 **(trap)** | A row inserted directly, as before 036 | Read it back | Its `request_group_id` is its own id (the trigger) | Proved (pglite): `SCRUM402_AC1_a_row_written_as_before_036_is_its_own_group` |
| AC1-06 | Through the API | The coordinator's list | Oldest first, each row with `requestGroupId` and its current value | Proved (route): `SCRUM402_AC1_oldest_first_with_each_rows_group_and_current_value_in_one_query`, `SCRUM402_AC1_a_failed_read_is_a_500_not_an_empty_list`, `SCRUM402_AC1_a_malformed_event_id_is_a_400_before_the_database`; the existing SCRUM-46 read, unmodified |
| AC1-07 | Through the API | The organiser's old single shape; the new `{ changes: [...] }` | Both reach `create_change_request_group`; the old shape still answers one row | Proved (route): `SCRUM402_AC1_several_fields_go_to_the_group_function_in_one_call`, `SCRUM402_AC1_a_submission_the_function_answers_with_no_rows_is_still_a_201`; (route, renamed from SCRUM32_AC1_…) `SCRUM402_AC1_returns_201_and_the_change_request_the_group_function_created`, `SCRUM402_AC1_stamps_the_requester_from_the_token_not_the_body`, `SCRUM402_AC1_does_not_label_a_change_request_with_the_event_status_vocabulary`; (validation) `SCRUM402_AC1_a_group_comes_back_normalised_and_the_single_shape_as_it_always_did` |
| AC1-08 | Approved | Submit two fields with the note "  Our sponsor asked for both  " | The trimmed note on both rows, each row's value unchanged; the preview and the coordinator's list return `organiserNote`; the service sends `p_note` | Proved (pglite): `SCRUM402_AC1_a_groups_note_is_stored_on_every_row_and_previewed`; (route) `SCRUM402_AC1_the_organisers_note_goes_with_the_group_and_comes_back_on_each_row`, `SCRUM402_AC1_the_coordinators_list_carries_the_organisers_note`; (validation) `SCRUM402_AC1_a_groups_note_is_trimmed_optional_and_at_most_2000_characters` |
| AC1-09 | Approved | Submit with no note; with a blank one | `organiser_note` null; no `p_note` sent | Proved (pglite): `SCRUM402_AC1_a_group_with_%s_stores_null` (two); (route) `SCRUM402_AC1_a_group_with_%s_sends_no_p_note` (two) |
| AC1-10 **(trap)** | Approved | A note of 2,001 characters, through the function; through a direct insert; a blank note inserted directly | 22023 from the function; 23514 from the table's check for both inserts; 2,000 characters accepted | Proved (pglite): `SCRUM402_AC1_a_note_over_2000_characters_is_refused_by_the_function_and_by_the_table`; (validation) `SCRUM402_AC1_a_groups_note_is_trimmed_optional_and_at_most_2000_characters` |
| AC1-11 | Through the API | The coordinator's `GET /mine` | Each event carries `openChangeRequestCount`, its open submissions counted by group, read in the same query | Proved (route): `SCRUM402_AC1_each_event_carries_how_many_submissions_wait_counted_by_group`; (service, renamed) `SCRUM402_AC1_selects_every_other_reads_columns_plus_the_change_request_count` |
| AC1-18 | Approved; the owner's profile role changed to each role but `event_organiser` | The owner submits a group | 42501 from the role check (050), before the owner check; nothing written | Proved (pglite): `SCRUM402_AC1_create_refuses_an_owner_whose_role_is_%s` (seven) |
| AC1-19 | — | Read every `user_role` value | AC1-18's roles are every value but `event_organiser`, and AC2-09's every value but `event_coordinator`: a role added later fails until it is listed | Proved (pglite): `SCRUM402_AC1_the_role_lists_cover_every_other_user_role` |
| AC1-20 **(trap)** | Approved | `create_change_request_group` called with no caller (`p_organiser_id` null) | 42501 from the role check (050), not the owner check's 22023; nothing written | Proved (pglite): `SCRUM402_AC1_create_refuses_a_null_caller_with_42501` |
| AC1-12 **(UI)** | The Organiser's form | Three fields, a date among them, and a note; remove a row; add to nine | One group sent, the date as an ISO instant, the note trimmed; a removed row is not sent; "Add another change" stops at nine | Proved (UI, organiser): `SCRUM402_AC1_several_fields_and_a_note_go_as_one_group`, `SCRUM402_AC1_no_note_sends_none_and_a_row_can_be_removed`, `SCRUM402_AC1_at_most_nine_changes` |
| AC1-13 **(UI)** **(trap)** | The same | Accessibility with "Something else" (both `other`); the same field twice | Refused beside the second row, nothing sent: no 22023 from the server | Proved (UI, organiser): `SCRUM402_AC1_%s_is_refused_in_the_form` (two), `SCRUM402_AC1_accessibility_says_it_travels_as_something_else` |
| AC1-14 **(UI)** | The same | A blank row; a note over 2,000 characters; a 400 with details; 400, 401, 403, 404, 500 without | Refused before sending; a fault on `changes[i]` beside row i and the rest in a list; otherwise a line keyed on the status, never the server's text | Proved (UI, organiser): `SCRUM402_AC1_a_blank_row_and_a_long_note_are_refused_before_sending`, `SCRUM402_AC1_a_400s_faults_go_beside_their_rows_and_the_rest_in_a_list`, `SCRUM402_AC1_%s_is_said_in_the_forms_own_words` (five) |
| AC1-15 **(UI)** | The coordinator's event | Load the panel | One card per submission, open first; each field's current and requested values through one formatter, "Not set" for empty; the note and the submitted date; a row from before 036 its own card; loading, empty and failed reads said | Proved (UI, panel): `SCRUM402_AC1_one_card_per_submission_with_current_and_requested_values_the_note_and_the_date`, `SCRUM402_AC1_open_submissions_come_before_processed_ones_and_processed_ones_show_their_outcome`, `SCRUM402_AC1_a_row_from_before_the_groups_is_its_own_card_shown_by_its_text`, `SCRUM402_AC1_says_loading_then_when_there_are_none_and_when_the_read_fails`, `SCRUM402_AC1_a_list_read_that_lands_after_unmounting_is_ignored`, `SCRUM402_AC9_a_something_else_row_from_before_the_groups_shows_its_text`; (UI, display) `SCRUM402_AC1_rows_become_submissions_open_first_each_in_the_order_sent`, `SCRUM402_AC1_current_and_requested_go_through_one_formatter`, `SCRUM402_AC1_labels_every_enum_member_and_reads_an_unknown_one` |
| AC1-16 **(UI)** | My events | Events with 2, 1, 0 and no count | "2 change requests", "1 change request", nothing for the others | Proved (UI, screens): `SCRUM402_AC1_each_event_says_how_many_change_requests_wait` |
| AC1-17 **(UI)** | The coordinator's event | Open it | The panel where the old inline list was; no Approve or Reject on a single row | Proved (UI, screens): `SCRUM402_AC1_the_panel_sits_where_the_old_list_was_with_no_approve_or_reject`; the Lead's read-only test (`scrum487LeadReadOnly.test.jsx`), unmodified |

### AC2 — who may process, and in which status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | Approved, held | Another coordinator; the Lead; the organiser; a null caller accept | 42501; nothing changes | Proved (pglite): `SCRUM402_AC2_%s_is_refused_with_42501` (four; accept and preview) |
| AC2-02 **(trap)** | Submitted and assigned, review not started | The holder accepts | PT409 `REVIEW_NOT_STARTED`; nothing changes | Proved (pglite): `SCRUM402_AC2_a_submitted_event_asks_for_its_review_to_be_started_first` (accept, decline, preview); (route) `SCRUM402_AC2_the_previews_%s_is_a_409_with_its_code`, `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` |
| AC2-03 | Cancelled; Completed, held. Rejected: since 039 no group can be open on a rejected event (creation refused, the rejection closes it), so the case is the group the rejection closed | The holder accepts | PT409 `EVENT_STATUS_NOT_ALLOWED`, naming the status; on Rejected the group is already processed as `event_rejected` | Proved (pglite): `SCRUM402_AC2_an_event_that_is_%s_is_refused_naming_its_status` (two; accept and preview), `SCRUM402_AC2_a_rejected_events_group_is_closed_by_the_rejection` |
| AC2-04 | A draft (no coordinator), reopened after a rejection; its group was closed by the rejection, as no group can be open on a draft | Anyone accepts | The group is processed as `event_rejected`; 42501: the caller is checked first, as 387's D15 | Proved (pglite): `SCRUM402_AC2_a_reopened_drafts_group_is_closed_by_the_rejection` |
| AC2-05 | As AC2-01 to AC2-03 | Preview | The same refusals | Proved (pglite): the AC2-01 to AC2-03 tests above, each of which previews too |
| AC2-06 | Through the API | Any role but a coordinator; no token; a malformed id | 403, 401, 400; nothing queried | Proved (route): `SCRUM402_AC2_%s_is_refused_the_preview_with_403_and_queries_nothing`, `SCRUM402_AC2_%s_is_refused_the_decision_with_403_and_queries_nothing`, `SCRUM402_AC2_the_preview_answers_401_without_a_token_and_400_for_a_malformed_id`, `SCRUM402_AC2_the_functions_%s_is_a_%s`, `SCRUM402_AC3_%s_is_a_400_before_the_database` (a_malformed_id) |
| AC2-09 **(trap)** | Approved, held; the holder's profile role changed to each role but `event_coordinator` | Preview; accept; decline | 42501 each time from the gate's role check (050): decline and the preview reach no other one. The group stays outstanding; the event, the history and the notifications are unchanged | Proved (pglite): `SCRUM402_AC2_the_gate_refuses_a_holder_whose_role_is_%s` (seven) |
| AC2-07 **(UI)** | The panel | The Lead or another coordinator; the holder on a Submitted, Cancelled, Rejected or Completed event | No buttons; no Review; on Submitted, "Start the review to process change requests." | Proved (UI, panel): `SCRUM402_AC2_the_lead_and_other_coordinators_read_it_with_no_buttons`, `SCRUM402_AC2_an_event_that_is_%s_offers_no_review` (four) |
| AC2-08 **(UI)** | The panel | Each refusal: the three 402 codes, `EVENT_HOLDS_ARRANGEMENTS`, an unknown 409, 400, 401, 403, 404, 500; a preview refused | Each in the panel's words, keyed on status and code; the server's text never shown | Proved (UI, panel): `SCRUM402_AC2_%s_is_said_in_the_panels_own_words` (nine), `SCRUM402_AC4_a_preview_that_fails_says_so_in_the_panels_words` |

### AC3 — decline, as a whole

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | A two-field group | Decline with no reason; a blank one; 2,001 characters | 22023; the group stays open | Proved (pglite): `SCRUM402_AC3_a_decline_with_%s_is_refused_and_the_group_stays_open`; (validation) `SCRUM402_AC3_a_note_is_at_most_2000_characters_counted_as_the_database_counts`; (route) `SCRUM402_AC3_%s_is_a_400_before_the_database`; the existing SCRUM-47 "requires a rejection reason", unmodified |
| AC3-02 | The same | Decline with "  Not this term  " | Both rows processed, `rejected`, the trimmed reason on each, the coordinator and time recorded; the event and its history unchanged | Proved (pglite): `SCRUM402_AC3_a_decline_records_the_reason_on_every_row_and_changes_nothing_else` |
| AC3-03 **(UI)** | The panel | Decline with no reason; with 2,001 characters; with "  Not this term  "; an accept note over 2,000 | Confirm disabled until a reason of at most 2,000; sent trimmed; "Change request declined"; an over-long note disables Accept | Proved (UI, panel): `SCRUM402_AC3_decline_needs_a_reason_of_at_most_2000_characters`, `SCRUM402_AC3_a_note_over_2000_characters_disables_accept` |

### AC4 — the preview

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | Approved; a group of a name, a start and a venue | Preview | Each row with its class (ordinary, significant), its current and requested values; changes nothing | Proved (pglite): `SCRUM402_AC4_the_preview_classes_each_row_with_its_current_and_requested_values`; (route) `SCRUM402_AC4_the_preview_is_asked_for_by_the_tokens_coordinator_and_returned_as_is` |
| AC4-02 | Confirmed; a start change | Preview | 395's impact and `revertsEvent` true | Proved (pglite): `SCRUM402_AC4_a_confirmed_events_preview_says_it_reverts_with_395s_impact` |
| AC4-03 | Approved; an end before the start, a past start, attendance 0 | Preview | `invalid` lists each fault by field; no impact | Proved (pglite): `SCRUM402_AC4_the_preview_lists_each_invalid_value_by_field_and_shows_no_impact` |
| AC4-04 **(trap)** | Approved; the preview taken, then a booking appears | Accept with the preview's impact | PT409 `SIGNIFICANT_CHANGE_IMPACT_CHANGED` from 395; the group stays open, the event unchanged | Proved (pglite): `SCRUM402_AC4_an_impact_that_changed_since_the_preview_refuses_the_accept`; (route) `SCRUM402_AC4_the_previewed_impact_is_passed_to_the_function`, `SCRUM402_AC4_a_decision_without_an_impact_sends_the_four_arguments_it_always_did`; (validation) `SCRUM402_AC4_the_expected_impact_is_passed_only_when_it_is_an_object` |
| AC4-05 **(UI)** | The panel, an Approved event | Review a group of a name and a date | Each field tagged "Applied directly" or "Re-checks bookings"; the impact's counts and lists in 395's style; a returning event warned of; Close review returns to the card | Proved (UI, panel): `SCRUM402_AC4_tags_each_field_and_shows_the_impact_in_395s_style`, `SCRUM402_AC4_an_impact_with_nothing_listed_shows_only_its_counts_and_bookings_without_a_name_read`, `SCRUM402_AC4_an_impact_with_no_lists_shows_zero_counts`, `SCRUM402_AC4_a_preview_with_no_invalid_list_or_impact_still_opens`, `SCRUM402_AC4_a_returning_event_is_warned_of`, `SCRUM402_AC4_close_review_returns_to_the_card`; (UI, display) `SCRUM402_AC4_the_class_%s_reads_as_%s` |
| AC4-06 **(UI)** **(trap)** | The same | Accept, refused `SIGNIFICANT_CHANGE_IMPACT_CHANGED` | The preview read again and shown, with a line saying so; no second accept sent. If that read fails, it says so | Proved (UI, panel): `SCRUM402_AC4_a_changed_impact_reloads_the_preview_and_says_so_rather_than_retrying`, `SCRUM402_AC4_a_reload_that_fails_after_a_changed_impact_says_so` |
| AC4-07 **(UI)** | The same | Accept with a note; accept an ordinary-only group | The preview's impact sent as `expectedImpact`, the note trimmed; none sent when there is no impact; the list and the event read again | Proved (UI, panel): `SCRUM402_AC4_accept_sends_the_previews_impact_then_rereads_the_list_and_the_event`, `SCRUM402_AC5_an_ordinary_only_accept_sends_no_impact_and_no_empty_note` |
| AC4-08 **(UI)** **(trap)** | The panel, two submissions | Review the second; its preview fails (500) | The panel's line in the second card, beside its Review button; none in the first, none above the list (click-through step 23's line sat at the top, off-screen) | Proved (UI, panel): `SCRUM402_AC4_a_failed_preview_says_so_in_its_own_card_beside_review` |
| AC4-09 **(UI)** | The panel | Review; the preview has no rows, an empty list, a row with no class, an `invalid` that is not a list, or no body at all | "This change request could not be reviewed. Please try again." in the card; no empty review opens | Proved (UI, panel): `SCRUM402_AC4_a_preview_with_%s_says_it_could_not_be_reviewed` (four), `SCRUM402_AC4_no_preview_at_all_says_it_could_not_be_reviewed` |
| AC4-10 **(UI)** | The panel, a review open | Accept; the decision fails (500) | The panel's line inside the review, beside its buttons | Proved (UI, panel): `SCRUM402_AC4_a_failed_decision_says_so_in_the_review_beside_its_buttons` |
| AC4-11 **(UI)** | The panel, a review open | Accept, refused `SIGNIFICANT_CHANGE_IMPACT_CHANGED`; the re-read preview has no rows | The review closes; "could not be reviewed" in the card | Proved (UI, panel): `SCRUM402_AC4_a_re_read_preview_without_its_fields_closes_the_review_and_says_so` |
| AC4-12 **(UI)** | The panel, two submissions | Accept the second | "Change request accepted." in the second card only | Proved (UI, panel): `SCRUM402_AC4_an_outcome_is_told_in_the_card_it_belongs_to` |

### AC5 — accept applies by status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | Under review; Pending clarification | Accept a name and an attendance | Both applied through 387, the status unchanged | Proved (pglite): `SCRUM402_AC5_while_%s_every_field_goes_through_387` (two) |
| AC5-02 | Approved; Safety review; Safety approved | Accept a description | Applied directly; the status unchanged | Proved (pglite): `SCRUM402_AC5_while_%s_an_ordinary_field_is_applied_directly` (three); the existing SCRUM-486 AC7-05 handover case, unmodified |
| AC5-03 | The same, with an approved booking | Accept a later start | Through 395: the booking flagged, the event back to Approved | Proved (pglite): `SCRUM402_AC5_while_%s_a_significant_field_goes_through_395_and_the_event_is_approved` (three); the existing SCRUM363_AC8 date and attendance cases in `scrum489EquipmentArrangedDatabase.test.js`, unmodified |
| AC5-04 **(trap)** | Confirmed | Accept a name and an attendance | 395 first (back to Approved), then the name through 387, which refuses a Confirmed event | Proved (pglite): `SCRUM402_AC5_with_both_parts_395_goes_first_then_387` |
| AC5-05 **(trap)** | Confirmed | Accept a purpose only | Confirmed → Approved by `change_event_request_status`, then the purpose through 387 (D7) | Proved (pglite): `SCRUM402_AC5_a_confirmed_event_with_ordinary_fields_only_returns_to_approved_first`; (pglite, renamed from SCRUM363_AC8_…) `SCRUM402_AC5_an_accepted_change_request_returns_a_confirmed_event_to_approved_and_applies_ordinary_%s` |
| AC5-06 | Confirmed | Accept an attendance | Through 395, back to Approved | Proved (pglite): `SCRUM402_AC5_a_confirmed_events_significant_field_goes_through_395` |
| AC5-07 | Approved | Accept a venue request | It becomes the venue requirements, through 395 (D6) | Proved (pglite): `SCRUM402_AC5_a_venue_request_becomes_the_venue_requirements`; (domain) `SCRUM402_AC5_every_change_field_targets_the_detail_field_and_column_036_applies`, `SCRUM402_AC5_a_venue_request_is_a_change_to_the_venue_requirements_and_other_and_cancellation_write_nothing` |
| AC5-08 | Approved | Accept an end before the stored start; a past start; attendance "0" | 22023 naming the field; the group stays open, the event unchanged | Proved (pglite): `SCRUM402_AC5_%s_is_refused_naming_the_field_and_the_group_stays_open` (three); the existing SCRUM363_AC8 unusable-value case, unmodified |
| AC5-09 **(trap)** | Approved | Accept a value equal to the stored one, alone; with a changed one | Alone: accepted with no history and no field change. With another: only the other is applied | Proved (pglite): `SCRUM402_AC5_a_value_equal_to_the_stored_one_is_dropped` |
| AC5-10 **(trap)** | Under review, reopened with a leftover booking | Accept a start | 387's `EVENT_HOLDS_ARRANGEMENTS` propagates; the group stays open | Proved (pglite): `SCRUM402_AC5_387s_leftover_arrangement_refusal_propagates`; (route) `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` (EVENT_HOLDS_ARRANGEMENTS) |
| AC5-11 **(UI)** | The panel | Review a group the preview finds invalid | Each fault by field; Accept disabled; a line saying the coordinator can decline instead | Proved (UI, panel): `SCRUM402_AC5_invalid_values_disable_accept_and_point_to_decline` |

### AC6 — the history names the change request

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | Under review | Accept a name | 387's row has `source = 'change_request'` and `change_request_id` the group's id | Proved (pglite): `SCRUM402_AC6_387s_rows_are_labelled_change_request_and_linked` |
| AC6-02 | Approved | Accept a start | 395's row is labelled the same way, without 395 restated (D3) | Proved (pglite): `SCRUM402_AC6_395s_rows_are_labelled_the_same_way_without_395_restated` |
| AC6-03 **(trap)** | One transaction | Accept a change request, then a direct 387 edit | The direct edit's row is `direct_edit` with no link: the settings were reset | Proved (pglite): `SCRUM402_AC6_a_direct_edit_after_a_change_request_in_one_transaction_is_its_own` |
| AC6-04 **(trap)** | — | Insert a `change_request` row without a link; a link with another source | Both refused by the check | Proved (pglite): `SCRUM402_AC6_%s_is_refused_by_the_check` (two) |

### AC7 — cancellation

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | Approved, a cancellation request "We lost our speaker" and another open request | Accept with the reason "  Speaker withdrew  " | The event cancelled, initiator `organiser_request`, the coordinator's reason | Proved (pglite): `SCRUM402_AC7_accepting_cancels_with_the_organisers_request_and_the_coordinators_reason` |
| AC7-02 **(trap)** | The same | — | This request ends `approved`; the other closed `event_cancelled` by the cancel (mark first, then cancel) | Proved (pglite): the same test |
| AC7-03 | The same, with no note | Accept with no reason | The request's own text is the cancellation reason (the fallback) | Proved (pglite): `SCRUM402_AC7_with_no_note_and_no_reason_the_requests_own_text_is_the_cancellation_reason` |
| AC7-04 | Approved, a cancellation with the note "We lost our speaker" | Preview; accept with no reason | The preview's `cancellationReason` and the event's `cancellation_reason` are the note, not the request's own text | Proved (pglite): `SCRUM402_AC7_a_cancellations_reason_is_prefilled_from_the_organisers_note` |
| AC7-07 **(trap)** | Under review, a cancellation request "We lost our speaker" with no note (click-through step 23) | Accept with the reason the panel pre-fills, "We lost our speaker" | The event cancelled, initiator `organiser_request`, that reason, by the coordinator; the request ends `approved`. Every other AC7 case is Approved | Proved (pglite): `SCRUM402_AC7_an_under_review_event_is_cancelled_with_the_reason_the_panel_sends` |
| AC7-05 **(UI)** | The Organiser's form | Choose "Cancel the event" with another row | The other rows go; "Why do you want to cancel?", required; sent as `cancellation` alone | Proved (UI, organiser): `SCRUM402_AC7_cancel_the_event_stands_alone_and_asks_why` |
| AC7-06 **(UI)** | The panel | Accept a cancellation | A confirmation with N08's impact (`getEventCancellationImpact`) and the reason pre-filled from `cancellationReason`, editable; Confirm sends it as the note; a blank reason cannot confirm; an impact that fails to load says so | Proved (UI, panel): `SCRUM402_AC7_accept_opens_a_confirmation_with_the_impact_and_the_prefilled_reason`, `SCRUM402_AC7_a_blank_reason_cannot_confirm_and_a_missing_prefill_starts_empty`, `SCRUM402_AC7_a_cancellation_impact_that_fails_to_load_says_so` |
| AC7-08 **(UI)** | The panel, the click-through's Under review event, with the JSON the live reads returned on 30 October | Review, Accept, Confirm cancellation | The confirmation with every count 0 and the reason "We lost our speaker"; sent as the note with no `expectedImpact` (the preview has none); the outcome told in the card | Proved (UI, panel): `SCRUM402_AC7_an_under_review_cancellation_opens_the_confirmation_and_sends_the_prefilled_reason` |
| AC7-09 **(UI)** | The same, at the confirmation | Confirm; refused with a 409 and no code | The panel's own line beside Confirm, never the server's text; the confirmation stays open | Proved (UI, panel): `SCRUM402_AC7_a_refused_cancellation_says_so_beside_confirm_and_keeps_the_confirmation_open` |
| AC7-10 **(UI)** | The same, in review | Accept; the cancellation impact comes back empty, or with no body | "The cancellation's impact could not be loaded. Please try again." in the card; no confirmation | Proved (UI, panel): `SCRUM402_AC7_a_cancellation_impact_with_%s_says_so_in_the_card` (two) |

### AC8 — equipment

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | Under review | Accept "Two more microphones" | Written to the equipment requirements through 387 | Proved (pglite): `SCRUM402_AC8_in_review_it_is_written_to_the_equipment_requirements` |
| AC8-02 | Approved | Accept the same | Through 395 with `equipmentChange`: an `equipment` history row; the status stays Approved | Proved (pglite): `SCRUM402_AC8_in_planning_395_records_it_for_the_equipment_lines` |
| AC8-03 | Confirmed | Accept the same | Through 395: back to Approved | Proved (pglite): `SCRUM402_AC8_on_a_confirmed_event_it_returns_the_event_to_approved` |
| AC8-04 **(UI)** **(trap)** | The event screen, Approved; and Under review | Accept an equipment change | Approved: the screen moves to the equipment section, focused, with the Organiser's text above it. Under review: a line that the lines open once the event is approved, no move | Proved (UI, screens): `SCRUM402_AC8_an_accepted_equipment_change_moves_to_the_equipment_section_with_the_organisers_text`; (UI, panel) `SCRUM402_AC8_in_planning_an_accepted_equipment_change_hands_off_to_the_equipment_section`, `SCRUM402_AC8_in_review_it_says_the_lines_open_once_approved_rather_than_moving`, `SCRUM402_AC8_an_equipment_row_from_before_the_groups_hands_off_its_text`, `SCRUM402_AC1_it_works_with_no_callbacks` |

### AC9, AC10 — something else, and once only

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC9-01 | Approved | Accept an "other" request with a note | Processed `approved` with the note; no field and no history changes | Proved (pglite): `SCRUM402_AC9_something_else_records_the_note_and_changes_no_field` |
| AC10-01 **(trap)** | A group accepted | Accept again; decline it | PT409 `CHANGE_REQUEST_ALREADY_PROCESSED` | Proved (pglite): `SCRUM402_AC10_a_group_is_processed_once_only`; (route) `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` (CHANGE_REQUEST_ALREADY_PROCESSED); (route) `SCRUM402_AC10_the_organisers_list_carries_each_rows_group_and_note` |
| AC10-02 | A legacy close with another outcome (`event_cancelled`) | Process with that decision | Recorded as given, nothing applied (the existing behaviour) | Proved (existing, unmodified): `eventCancellationFieldsMigration.test.js` "allows change requests to be closed with the event-cancelled outcome" |
| AC10-05 **(trap)** | Under review: an outstanding group, an in-progress group, a declined group; another event's open group | Reject through `decide_event_request` | 039's trigger closes the two open groups as `event_rejected`, by the reviewing coordinator; the declined group and the other event's are untouched | Proved (pglite): `SCRUM402_AC10_rejecting_from_under_review_closes_open_change_requests` |
| AC9-02 **(UI)** | The panel | Accept a "Something else" request | Accept disabled until a note is given | Proved (UI, panel): `SCRUM402_AC9_something_else_needs_a_note_to_accept` |
| AC10-03 **(UI)** | The Organiser's list | Rows of two submissions; each outcome | One card per submission with its fields and note; Accepted, Declined, "Closed: the event was cancelled", "Closed: the event was rejected", and "Closed" for a value a later story adds; the coordinator's reason or note and the processed date | Proved (UI, organiser): `SCRUM402_AC10_one_card_per_submission_with_its_fields_and_note`, `SCRUM402_AC10_the_outcome_%s_reads_as_%s_with_the_coordinators_words_and_date` (five), `SCRUM402_AC10_an_unknown_status_and_a_row_from_before_the_groups_still_read`, `SCRUM402_AC10_says_when_there_are_none_and_when_the_read_fails`; (UI, display) `SCRUM402_AC10_the_outcome_%s_reads_as_%s` |
| AC10-04 **(UI)** | The panel | Accept a group someone processed meanwhile | "Already processed"; the review closes and the list is read again | Proved (UI, panel): `SCRUM402_AC10_an_already_processed_group_closes_the_review_and_rereads_the_list` |
| AC10-06 **(UI)** | The Organiser's list; requests closed with the event: rejected (SCRUM-347), cancelled, completed (SCRUM-379, 034's `event_completed`) | Read the list | "Outcome: Closed: the event was rejected / cancelled / completed"; a completed event's request never reads as Rejected or Declined | Proved (UI, display): `SCRUM402_AC10_a_change_request_closed_by_completing_the_event_says_so`; (UI, list, in `scrum347RejectApprovedEvent.test.jsx`) `SCRUM402_AC10_a_change_request_closed_by_%s_says_why` (three), `SCRUM402_AC10_a_completed_events_change_request_is_never_called_rejected_or_declined` |
| AC10-07 **(UI)** | The coordinator's panel on a completed event (SCRUM-379) | Read its change requests | "Closed: the event was completed", never "Declined"; Accepted, Declined and the other two closures in the same words as the Organiser's list | Proved (UI, screen, in `scrum379CoordinatorCompletion.test.jsx`): `SCRUM402_AC10_the_coordinators_panel_says_closed_the_event_was_completed_not_declined`, `SCRUM402_AC10_the_coordinators_panel_still_words_%s_correctly` (four) |

### AC11, AC12 — notices

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC11-01 | Approved | Accept; decline | One `change_request_decided` to the organiser each time, naming the decision, the fields and the note | Proved (pglite): `SCRUM402_AC11_the_organiser_is_told_the_outcome_on_accept_and_on_decline` |
| AC12-01 | Approved, held | A group with a significant field | One `change_request_significant_submitted` to the holder | Proved (pglite): `SCRUM402_AC12_a_significant_request_tells_the_holder` |
| AC12-02 | The same; and submitted with nobody assigned | An ordinary-only group; a significant group | No notice for either | Proved (pglite): `SCRUM402_AC12_an_ordinary_request_or_one_nobody_holds_tells_no_one` |
| AC11-02 **(UI)** | The Organiser's inbox | `change_request_decided`: accepted, declined, closed another way, a cancellation, a sparse payload | Names the event, the outcome and the fields; the coordinator's note or reason; a cancellation as one; opens `/events` at the event | Proved (UI, notices): `SCRUM402_AC11_a_request_%s_names_the_event_the_fields_and_the_note` (three), `SCRUM402_AC11_a_cancellation_request_is_named_as_one`, `SCRUM402_AC11_a_sparse_payload_still_reads`, `SCRUM402_AC11_the_organiser_opens_it_on_their_events_list` |
| AC11-03 **(UI)** **(trap)** | The frontend's list of known types | 036 appends its two types instead of restating the list | The helper returns 022's whole list plus both; `SCRUM172_AC6_every_known_type_has_wording` went red without their fixtures and passes with them | Proved (UI, notices): `SCRUM402_AC11_the_known_types_include_what_036_appends_to_the_live_list`, `SCRUM402_AC11_036_appends_both_types_to_the_live_list_in_the_pattern_the_type_test_reads`; (existing) `SCRUM172_AC6_every_known_type_has_wording` |
| AC12-03 **(UI)** | The holder's inbox | `change_request_significant_submitted` | Names the event and the fields; opens the coordinator's event screen; a sparse payload still reads | Proved (UI, notices): `SCRUM402_AC12_names_the_event_and_the_fields`, `SCRUM402_AC12_with_no_fields_or_name_it_still_reads`, `SCRUM402_AC12_the_coordinator_opens_the_events_screen` |

### Schema

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| SC-01 **(trap)** | A notification type added to the live list after 022 | Run 036 again | The added type survives, both new types are present, and a second run changes nothing | Proved (pglite): `SCRUM402_AC11_a_notification_type_added_elsewhere_survives_036_and_a_second_run_changes_nothing` |
| SC-02 | — | The grants | The new functions are closed to anon and authenticated | Proved (pglite): `SCRUM402_AC11_the_new_functions_stay_closed_to_the_client_roles` |
| SC-03 **(trap)** | The whole chain, where 024, 032 and 037 restate the list whole after 036 | Read the check | Both new types are present, beside 037's `registration_promoted` | Proved (pglite): `SCRUM402_AC11_the_outcome_notice_type_survives_every_later_restate` |
| SC-04 | The whole chain | Insert a notification of each new type | Both inserts succeed | Proved (pglite): `SCRUM402_AC11_each_restored_type_can_be_inserted` |
| SC-05 | The list restated whole without the two types, as live stood after 037 | Run 039, then run it again | Both types are back, every other type stays, and the second run changes nothing | Proved (pglite): `SCRUM402_AC11_039_restores_what_a_whole_restate_dropped_and_a_second_run_changes_nothing` |
| SC-06 | An event rejected through `reject_approved_event` (SCRUM-347) | The Organiser submits a group | Refused with 22023 and 347's words, under the event lock; nothing is written | Proved (pglite): `SCRUM347_AC6_create_change_request_group_refuses_a_rejected_event` |

---

## Tally

94 cases, counted from the tables: **94 proved**; 0 not yet implemented; 0 that
cannot be written as specified. Twenty-four are traps, five of them on the screen.

| Section | Backend | UI | Cases |
|---|---|---|---|
| AC1 | 14 | 6 | 20 |
| AC2 | 7 | 2 | 9 |
| AC3 | 2 | 1 | 3 |
| AC4 | 4 | 8 | 12 |
| AC5 | 10 | 1 | 11 |
| AC6 | 4 | 0 | 4 |
| AC7 | 5 | 5 | 10 |
| AC8 | 3 | 1 | 4 |
| AC9, AC10 | 4 | 5 | 9 |
| AC11, AC12 | 3 | 3 | 6 |
| Schema | 6 | 0 | 6 |
| **Total** | **62** | **32** | **94** |
