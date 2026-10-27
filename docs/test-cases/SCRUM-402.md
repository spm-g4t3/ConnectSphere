# SCRUM-402 — Test Cases

**Story:** Process an Event Change Request (E3) — Event Coordinator
**Subtask:** SCRUM-409 (this document); the backend halves of SCRUM-403 to SCRUM-407
**Schema:** `035_change_request_cancellation_type.sql` and `036_process_change_requests.sql` (SCRUM-403), on top of 022's `edit_event_request_details`, 028's change-history source check, 013's `cancel_event_request` and the baseline's `apply_significant_event_change`.
**Written:** 27 October 2026, before the tests and the code.
**Marked:** 27 October 2026, SCRUM-403 to SCRUM-407 (backend): every case proved. AC5-04 moved from Safety approved to Confirmed, where the order it tests matters (387 allows a name in Safety approved, so the old case could not fail).
**Marked:** 27 October 2026, the brief 1 fix-up: the Organiser's note (`organiser_note`, in 036 before it ran anywhere). AC1-08 to AC1-10 and AC7-04 added; AC7-03 reworded as the fallback it now is.

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

### AC2 — who may process, and in which status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | Approved, held | Another coordinator; the Lead; the organiser; a null caller accept | 42501; nothing changes | Proved (pglite): `SCRUM402_AC2_%s_is_refused_with_42501` (four; accept and preview) |
| AC2-02 **(trap)** | Submitted and assigned, review not started | The holder accepts | PT409 `REVIEW_NOT_STARTED`; nothing changes | Proved (pglite): `SCRUM402_AC2_a_submitted_event_asks_for_its_review_to_be_started_first` (accept, decline, preview); (route) `SCRUM402_AC2_the_previews_%s_is_a_409_with_its_code`, `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` |
| AC2-03 | Rejected; Cancelled; Completed, held | The holder accepts | PT409 `EVENT_STATUS_NOT_ALLOWED`, naming the status | Proved (pglite): `SCRUM402_AC2_an_event_that_is_%s_is_refused_naming_its_status` (three; accept and preview) |
| AC2-04 | A draft (no coordinator) | Anyone accepts | 42501: the caller is checked first, as 387's D15 | Proved (pglite): `SCRUM402_AC2_a_draft_is_refused_as_a_strangers_call` |
| AC2-05 | As AC2-01 to AC2-03 | Preview | The same refusals | Proved (pglite): the AC2-01 to AC2-03 tests above, each of which previews too |
| AC2-06 | Through the API | Any role but a coordinator; no token; a malformed id | 403, 401, 400; nothing queried | Proved (route): `SCRUM402_AC2_%s_is_refused_the_preview_with_403_and_queries_nothing`, `SCRUM402_AC2_%s_is_refused_the_decision_with_403_and_queries_nothing`, `SCRUM402_AC2_the_preview_answers_401_without_a_token_and_400_for_a_malformed_id`, `SCRUM402_AC2_the_functions_%s_is_a_%s`, `SCRUM402_AC3_%s_is_a_400_before_the_database` (a_malformed_id) |

### AC3 — decline, as a whole

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | A two-field group | Decline with no reason; a blank one; 2,001 characters | 22023; the group stays open | Proved (pglite): `SCRUM402_AC3_a_decline_with_%s_is_refused_and_the_group_stays_open`; (validation) `SCRUM402_AC3_a_note_is_at_most_2000_characters_counted_as_the_database_counts`; (route) `SCRUM402_AC3_%s_is_a_400_before_the_database`; the existing SCRUM-47 "requires a rejection reason", unmodified |
| AC3-02 | The same | Decline with "  Not this term  " | Both rows processed, `rejected`, the trimmed reason on each, the coordinator and time recorded; the event and its history unchanged | Proved (pglite): `SCRUM402_AC3_a_decline_records_the_reason_on_every_row_and_changes_nothing_else` |

### AC4 — the preview

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 | Approved; a group of a name, a start and a venue | Preview | Each row with its class (ordinary, significant), its current and requested values; changes nothing | Proved (pglite): `SCRUM402_AC4_the_preview_classes_each_row_with_its_current_and_requested_values`; (route) `SCRUM402_AC4_the_preview_is_asked_for_by_the_tokens_coordinator_and_returned_as_is` |
| AC4-02 | Confirmed; a start change | Preview | 395's impact and `revertsEvent` true | Proved (pglite): `SCRUM402_AC4_a_confirmed_events_preview_says_it_reverts_with_395s_impact` |
| AC4-03 | Approved; an end before the start, a past start, attendance 0 | Preview | `invalid` lists each fault by field; no impact | Proved (pglite): `SCRUM402_AC4_the_preview_lists_each_invalid_value_by_field_and_shows_no_impact` |
| AC4-04 **(trap)** | Approved; the preview taken, then a booking appears | Accept with the preview's impact | PT409 `SIGNIFICANT_CHANGE_IMPACT_CHANGED` from 395; the group stays open, the event unchanged | Proved (pglite): `SCRUM402_AC4_an_impact_that_changed_since_the_preview_refuses_the_accept`; (route) `SCRUM402_AC4_the_previewed_impact_is_passed_to_the_function`, `SCRUM402_AC4_a_decision_without_an_impact_sends_the_four_arguments_it_always_did`; (validation) `SCRUM402_AC4_the_expected_impact_is_passed_only_when_it_is_an_object` |

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

### AC8 — equipment

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | Under review | Accept "Two more microphones" | Written to the equipment requirements through 387 | Proved (pglite): `SCRUM402_AC8_in_review_it_is_written_to_the_equipment_requirements` |
| AC8-02 | Approved | Accept the same | Through 395 with `equipmentChange`: an `equipment` history row; the status stays Approved | Proved (pglite): `SCRUM402_AC8_in_planning_395_records_it_for_the_equipment_lines` |
| AC8-03 | Confirmed | Accept the same | Through 395: back to Approved | Proved (pglite): `SCRUM402_AC8_on_a_confirmed_event_it_returns_the_event_to_approved` |

### AC9, AC10 — something else, and once only

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC9-01 | Approved | Accept an "other" request with a note | Processed `approved` with the note; no field and no history changes | Proved (pglite): `SCRUM402_AC9_something_else_records_the_note_and_changes_no_field` |
| AC10-01 **(trap)** | A group accepted | Accept again; decline it | PT409 `CHANGE_REQUEST_ALREADY_PROCESSED` | Proved (pglite): `SCRUM402_AC10_a_group_is_processed_once_only`; (route) `SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code` (CHANGE_REQUEST_ALREADY_PROCESSED); (route) `SCRUM402_AC10_the_organisers_list_carries_each_rows_group` |
| AC10-02 | A legacy close with another outcome (`event_cancelled`) | Process with that decision | Recorded as given, nothing applied (the existing behaviour) | Proved (existing, unmodified): `eventCancellationFieldsMigration.test.js` "allows change requests to be closed with the event-cancelled outcome" |

### AC11, AC12 — notices

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC11-01 | Approved | Accept; decline | One `change_request_decided` to the organiser each time, naming the decision, the fields and the note | Proved (pglite): `SCRUM402_AC11_the_organiser_is_told_the_outcome_on_accept_and_on_decline` |
| AC12-01 | Approved, held | A group with a significant field | One `change_request_significant_submitted` to the holder | Proved (pglite): `SCRUM402_AC12_a_significant_request_tells_the_holder` |
| AC12-02 | The same; and submitted with nobody assigned | An ordinary-only group; a significant group | No notice for either | Proved (pglite): `SCRUM402_AC12_an_ordinary_request_or_one_nobody_holds_tells_no_one` |

### Schema

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| SC-01 **(trap)** | A notification type added to the live list after 022 | Run 036 again | The added type survives, both new types are present, and a second run changes nothing | Proved (pglite): `SCRUM402_AC11_a_notification_type_added_elsewhere_survives_036_and_a_second_run_changes_nothing` |
| SC-02 | — | The grants | The new functions are closed to anon and authenticated | Proved (pglite): `SCRUM402_AC11_the_new_functions_stay_closed_to_the_client_roles` |

---

## Tally

51 cases, counted from the tables: **51 proved**; 0 not yet implemented; 0 that
cannot be written as specified. Fourteen are traps. The screens' cases (SCRUM-404's
list, SCRUM-408) come with brief 2.

| Section | Cases |
|---|---|
| AC1 | 10 |
| AC2 | 6 |
| AC3 | 2 |
| AC4 | 4 |
| AC5 | 10 |
| AC6 | 4 |
| AC7 | 4 |
| AC8 | 3 |
| AC9, AC10 | 3 |
| AC11, AC12 | 3 |
| Schema | 2 |
