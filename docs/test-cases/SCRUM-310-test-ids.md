# SCRUM-310: Test IDs by acceptance criterion

Every test whose name starts `SCRUM310_ACn_`, grouped by criterion and file. Generated from the test files on 25 October 2026 for SCRUM-317; the case each one proves is in `docs/test-cases/SCRUM-310.md`.

A name below is the full test name once `SCRUM310_` is put in front of it. A name marked **(supporting)** is not named under a case in the case tables: it checks a body, a wording rule or an error mapping around one. A name with `%s`, `%j` or `%i` is a parameterised test that runs once per value. `AC5_AC6_` tests prove both criteria and are listed under AC5.

| AC | Test titles | Files |
|---|---|---|
| AC1 | 91 | 5 |
| AC2 | 139 | 11 |
| AC3 | 29 | 4 |
| AC4 | 122 | 7 |
| AC5 | 64 | 6 |
| AC6 | 51 | 9 |
| AC7 | 30 | 10 |
| AC8 | 26 | 5 |
| **All** | **552** | |

## AC1

### `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` (27)

- `AC1_a_null_caller_is_refused_with_42501`
- `AC1_only_technical_support_staff_may_ask`
- `AC1_a_negative_or_missing_usable_quantity_is_refused_with_22023`
- `AC1_an_unknown_type_is_refused_with_P0002`
- `AC1_the_client_roles_cannot_execute_it_and_service_role_can`
- `AC1_the_function_is_declared_stable`
- `AC1_asking_changes_no_reservation_and_writes_no_history_or_notice`
- `AC1_a_type_with_no_reservations_has_nothing_affected`
- `AC1_reservations_that_have_ended_are_ignored`
- `AC1_released_reservations_are_ignored`
- `AC1_another_types_reservations_are_ignored`
- `AC1_a_usable_quantity_of_zero_affects_every_held_reservation`
- `AC1_a_reservation_already_under_way_still_counts`
- `AC1_a_reservation_on_a_%s_event_is_still_checked`
- `AC1_a_retired_type_still_answers_and_all_its_held_reservations_are_affected`
- `AC1_a_request_cancelled_after_the_reservation_no_longer_counts`
- `AC1_a_%s_is_refused_with_42501`
- `AC1_a_caller_with_no_profile_is_refused_with_42501`
- `AC1_a_missing_type_id_is_refused_with_P0002`
- `AC1_a_null_caller_and_other_roles_are_refused_with_42501`
- `AC1_a_change_that_takes_the_usable_quantity_below_zero_is_refused_with_22023`
- `AC1_%s_reports_the_usable_quantity_before_and_after`
- `AC1_quantities_left_out_stay_as_they_are`
- `AC1_a_change_that_lowers_the_usable_quantity_lists_the_same_reservations_as_the_check`
- `AC1_it_only_reads`
- `AC1_the_client_roles_cannot_execute_the_new_functions_and_service_role_can`
- `AC1_the_unchecked_calculation_refuses_a_negative_figure_and_an_unknown_type`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (2)

- `AC1_the_check_lists_the_unended_reservations_the_change_cannot_cover`
- `AC1_a_reservation_that_has_already_ended_is_not_listed`

### `backend/tests/routes/scrum312ChangePreviewRoutes.test.js` (20)

- `AC1_the_supabase_client_is_mocked_and_never_the_real_one` **(supporting)**
- `AC1_there_are_other_roles_to_test_and_the_list_has_the_ones_that_matter` **(supporting)**
- `AC1_refuses_%s_with_403_and_reads_nothing`
- `AC1_refuses_a_signed_out_caller_with_401_and_reads_nothing`
- `AC1_a_role_named_in_the_body_does_not_help_a_coordinator`
- `AC1_a_retirement_is_previewed_as_zero_usable`
- `AC1_the_acting_user_sent_to_the_database_is_the_signed_in_one`
- `AC1_a_malformed_id_is_a_400_with_no_query`
- `AC1_%s_is_a_400_with_no_query` **(supporting)**
- `AC1_a_missing_body_is_a_400_not_a_crash` **(supporting)**
- `AC1_a_body_that_is_not_json_is_refused_without_reading_anything` **(supporting)**
- `AC1_damaged_plus_under_maintenance_above_the_total_is_a_400_listing_the_field`
- `AC1_an_unknown_type_is_a_404`
- `AC1_retiring_a_retired_type_is_a_409_with_its_code` **(supporting)**
- `AC1_a_database_refusal_of_the_caller_is_a_403`
- `AC1_a_type_that_vanishes_before_the_function_runs_is_a_404`
- `AC1_an_unexpected_database_failure_is_a_500_that_does_not_leak_its_message`
- `AC1_%s_on_the_preview_path_is_not_a_preview`
- `AC1_editing_a_type_still_works_and_does_not_call_the_preview_function`
- `AC1_the_history_route_is_not_swallowed_by_the_new_one`

### `backend/tests/services/scrum312ChangePreviewService.test.js` (24)

- `AC1_the_supabase_client_is_mocked_and_never_the_real_one` **(supporting)**
- `AC1_sends_%s_as_it_was_given_and_leaves_the_rest_null`
- `AC1_the_database_decides_whether_a_change_can_affect_anything_so_it_is_always_asked`
- `AC1_the_usable_quantities_are_the_ones_the_database_answered`
- `AC1_a_retired_type_can_still_have_a_quantity_change_previewed`
- `AC1_the_caller_sent_is_the_one_passed_in_and_nothing_in_the_body_can_change_it`
- `AC1_a_usable_figure_in_the_body_is_never_sent`
- `AC1_a_bad_id_%j_is_a_400_with_no_query`
- `AC1_a_bad_body_%j_is_a_400_with_no_query` **(supporting)**
- `AC1_an_unknown_type_is_a_404_and_the_rpc_is_not_asked` **(supporting)**
- `AC1_retiring_a_retired_type_is_a_409_with_its_code_and_the_rpc_is_not_asked` **(supporting)**
- `AC1_%s_is_a_400_naming_%s_with_no_rpc`
- `AC1_damaged_plus_maintenance_exactly_equal_to_the_total_is_allowed`
- `AC1_a_retirement_ignores_the_quantity_rule_even_on_an_oddly_stored_type` **(supporting)**
- `AC1_a_name_that_is_already_taken_is_a_400_naming_name_and_the_rpc_is_not_asked`
- `AC1_a_bad_name_%j_is_a_400_with_no_query`
- `AC1_a_free_name_goes_through_and_is_never_sent_to_the_database_function`
- `AC1_a_retirement_with_an_edited_field_is_refused`
- `AC1_rpc_error_%s_becomes_%s` **(supporting)**
- `AC1_an_unlisted_rpc_error_stays_an_untyped_failure`
- `AC1_a_failed_read_of_the_type_is_not_swallowed_and_the_rpc_is_not_asked`
- `AC1_an_rpc_answer_that_is_not_a_list_(%j)_is_an_error_not_an_empty_result` **(supporting)**
- `AC1_the_argument_names_sent_are_the_parameter_names_of_the_real_function`
- `AC1_every_field_read_from_a_row_is_a_key_the_function_builds` **(supporting)**

### `backend/tests/validation/scrum312ChangePreviewValidation.test.js` (18)

- `AC1_accepts_%s` **(supporting)**
- `AC1_accepts_the_boundary_%s` **(supporting)**
- `AC1_ignores_fields_it_does_not_know_and_does_not_return_them` **(supporting)**
- `AC1_does_not_need_a_note` **(supporting)**
- `AC1_refuses_%s_as_a_body` **(supporting)**
- `AC1_refuses_an_empty_object`
- `AC1_refuses_a_body_with_only_unknown_fields`
- `AC1_refuses_a_bad_%s`
- `AC1_lists_every_invalid_field_together`
- `AC1_keeps_a_valid_field_even_when_another_is_invalid`
- `AC1_reads_the_name_and_the_optional_text_fields_trimmed`
- `AC1_refuses_the_name_%j`
- `AC1_refuses_a_%s_that_is_not_text`
- `AC1_a_name_alone_is_not_a_change_to_preview`
- `AC1_refuses_retire_together_with_%s`
- `AC1_refuses_retire_set_to_%j` **(supporting)**
- `AC1_refuses_retire_false_instead_of_reading_it_as_nothing` **(supporting)**
- `AC1_a_retire_with_a_bad_quantity_lists_both_problems` **(supporting)**

## AC2

### `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` (2)

- `AC2_each_affected_reservation_names_the_event_period_quantity_and_coordinator`
- `AC2_the_list_is_in_the_order_the_reservations_were_made`

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (16)

- `AC2_an_affecting_change_with_nothing_confirmed_writes_nothing_and_returns_the_list`
- `AC2_the_list_returned_is_the_one_the_preview_function_gives`
- `AC2_a_confirmed_list_missing_one_affected_reservation_is_refused`
- `AC2_a_confirmed_list_with_an_extra_reservation_is_refused`
- `AC2_a_confirmed_list_of_the_wrong_reservations_is_refused`
- `AC2_made_up_ids_are_refused`
- `AC2_the_confirmed_order_and_repeats_do_not_matter`
- `AC2_after_a_refusal_the_returned_list_confirms_and_saves`
- `AC2_a_reservation_made_after_the_preview_makes_the_old_confirmation_stale`
- `AC2_a_reservation_released_after_the_preview_is_not_flagged_and_the_save_goes_ahead`
- `AC2_a_reservation_that_ends_after_the_preview_does_not_make_the_confirmation_stale`
- `AC2_a_confirmed_id_that_is_still_held_and_not_affected_makes_the_confirmation_stale`
- `AC2_a_confirmed_id_from_another_type_makes_the_confirmation_stale_even_if_it_has_ended`
- `AC2_an_older_reservation_released_after_the_preview_changes_who_is_affected`
- `AC2_a_change_to_the_type_after_the_preview_that_changes_the_list_is_caught`
- `AC2_the_function_takes_the_row_lock_before_it_decides`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (1)

- `AC2_asking_without_confirming_saves_nothing_and_flags_nothing`

### `backend/tests/routes/scrum312ChangePreviewRoutes.test.js` (2)

- `AC2_answers_200_with_the_preview`
- `AC2_a_preview_makes_only_reads` **(supporting)**

### `backend/tests/routes/scrum313ConfirmedSaveRoutes.test.js` (1)

- `AC2_%s_answers_409_with_the_code_and_the_new_list`

### `backend/tests/services/scrum312ChangePreviewService.test.js` (6)

- `AC2_makes_one_select_on_the_type_and_one_rpc_and_nothing_else` **(supporting)**
- `AC2_%s_preview_calls_no_other_function` **(supporting)**
- `AC2_maps_a_row_to_the_api_shape_field_by_field`
- `AC2_keeps_the_order_the_database_gave_and_totals_the_units`
- `AC2_a_coordinator_with_no_name_comes_back_as_null_not_dropped`
- `AC2_returns_a_fresh_result_each_time` **(supporting)**

### `backend/tests/services/scrum313ConfirmedSaveService.test.js` (9)

- `AC2_a_total_edit_sends_the_total_the_fields_the_note_and_the_confirmed_list` **(supporting)**
- `AC2_%s_with_no_list_confirms_an_empty_one` **(supporting)**
- `AC2_%s_sends_the_list_without_repeats` **(supporting)**
- `AC2_%s_is_refused_with_409_and_the_new_list`
- `AC2_a_refusal_with_an_empty_new_list_is_still_a_refusal`
- `AC2_%s_does_not_return_a_type_when_refused`
- `AC2_the_message_tells_the_staff_member_to_review_again`
- `AC2_a_refusal_with_%s_is_an_error_not_an_empty_conflict` **(supporting)**
- `AC2_a_conflict_hint_becomes_the_conflicts_code`

### `backend/tests/validation/scrum313ConfirmedSaveValidation.test.js` (17)

- `AC2_leaves_the_list_out_of_the_result_when_it_is_not_sent` **(supporting)**
- `AC2_accepts_a_list_of_reservation_ids_and_returns_it`
- `AC2_accepts_an_empty_list_as_the_claim_that_nothing_is_affected`
- `AC2_accepts_a_single_id` **(supporting)**
- `AC2_accepts_upper_case_ids` **(supporting)**
- `AC2_drops_repeats_so_a_list_that_names_one_reservation_twice_is_the_same_list`
- `AC2_does_not_change_the_order_it_was_given` **(supporting)**
- `AC2_accepts_as_many_as_one_thousand`
- `AC2_refuses_more_than_one_thousand`
- `AC2_refuses_%s_in_place_of_a_list`
- `AC2_refuses_a_list_holding_%s`
- `AC2_reports_a_bad_list_once_whatever_else_is_wrong`
- `AC2_update_lists_a_bad_list_with_a_bad_total` **(supporting)**
- `AC2_condition_lists_a_bad_list_with_a_missing_note_and_a_bad_quantity` **(supporting)**
- `AC2_reads_the_confirmed_list_and_the_trimmed_note` **(supporting)**
- `AC2_lists_a_bad_note_and_a_bad_list_together` **(supporting)**
- `AC2_does_not_count_the_list_alone_as_a_change` **(supporting)**

### `frontend/tests/components/scrum314ConfirmationStep.test.jsx` (47)

- `AC2_asks_which_reservations_the_new_total_affects_before_saving`
- `AC2_sends_the_edited_name_with_the_total_so_a_taken_name_is_found_before_confirming`
- `AC2_a_name_the_preview_refuses_is_shown_on_the_form_and_no_list_is_offered`
- `AC2_shows_event_period_quantity_and_coordinator_for_each_affected_reservation`
- `AC2_keeps_the_order_the_backend_gave`
- `AC2_says_how_many_reservations_and_units_and_how_usable_changes`
- `AC2_says_what_confirming_does`
- `AC2_marks_a_reservation_that_was_already_flagged`
- `AC2_says_when_an_event_has_no_coordinator_or_no_name`
- `AC2_saves_nothing_while_the_list_is_on_screen`
- `AC2_going_back_saves_nothing_and_keeps_what_was_typed`
- `AC2_the_form_can_be_resubmitted_after_going_back` **(supporting)**
- `AC2_a_retirement_that_affects_reservations_lists_them_under_the_row_and_retires_nothing`
- `AC2_keeping_the_type_retires_nothing_and_closes_the_list`
- `AC2_after_keeping_the_type_it_can_be_retired_again_from_the_start` **(supporting)**
- `AC2_other_types_cannot_be_changed_while_a_list_is_waiting_for_a_decision` **(supporting)**
- `AC2_the_retire_button_shows_it_is_checking_while_the_preview_runs` **(supporting)**
- `AC2_only_the_row_being_retired_shows_a_list`
- `AC2_a_retired_type_has_no_retire_step_and_reinstating_is_not_previewed` **(supporting)**
- `AC2_an_edit_button_for_a_retired_type_still_works` **(supporting)**
- `AC2_a_refused_save_shows_the_new_list_with_a_notice_and_saves_nothing_more`
- `AC2_the_server_text_of_the_refusal_is_never_shown`
- `AC2_a_refusal_that_leaves_no_reservations_says_so_and_offers_a_plain_save` **(supporting)**
- `AC2_a_save_that_follows_an_empty_preview_but_is_refused_shows_the_list_for_a_decision` **(supporting)**
- `AC2_a_refusal_with_a_malformed_list_shows_no_reservations_that_were_not_sent` **(supporting)**
- `AC2_a_refused_damage_change_shows_the_new_list_and_confirms_it_with_the_same_note`
- `AC2_a_refused_retirement_shows_the_new_list_and_confirms_it`
- `AC2_a_refusal_does_not_refetch_the_catalogue`
- `AC2_a_failed_preview_on_an_edit_shows_a_message_and_leaves_the_form_usable`
- `AC2_a_failed_preview_can_be_retried_and_then_continues_as_normal`
- `AC2_a_failed_preview_on_a_damage_change_shows_the_backends_validation_messages` **(supporting)**
- `AC2_a_failed_preview_on_a_retirement_shows_a_message_under_the_row_and_retires_nothing`
- `AC2_a_retirement_preview_that_finds_the_type_gone_refreshes_the_list` **(supporting)**
- `AC2_a_preview_answer_of_%s_is_an_error_and_never_a_reason_to_save`
- `AC2_the_save_button_shows_it_is_checking_and_is_disabled_while_the_preview_runs` **(supporting)**
- `AC2_a_blank_note_is_refused_before_the_preview`
- `AC2_a_note_of_only_spaces_is_refused_before_the_preview` **(supporting)**
- `AC2_no_change_is_refused_before_the_preview`
- `AC2_a_cleared_quantity_is_sent_as_null_for_the_backend_to_judge` **(supporting)**
- `AC2_the_message_for_an_earlier_mistake_goes_away_when_the_next_try_works` **(supporting)**
- `AC2_leaving_the_form_while_it_is_checking_never_goes_on_to_save`
- `AC2_leaving_the_form_while_a_failed_check_is_on_its_way_shows_nothing_and_saves_nothing` **(supporting)**
- `AC2_the_damage_form_offers_a_plain_save_when_the_new_list_is_empty` **(supporting)**
- `AC2_a_retirement_offers_a_plain_retire_when_the_new_list_is_empty` **(supporting)**
- `AC2_a_list_that_arrives_after_the_user_left_is_dropped` **(supporting)**
- `AC2_a_failure_that_arrives_after_the_user_left_is_dropped` **(supporting)**
- `AC2_the_old_check_error_is_gone_once_a_change_that_needs_no_check_is_saved` **(supporting)**

### `frontend/tests/components/useConfirmedChange.test.jsx` (3)

- `AC2_a_late_list_after_cancel_is_dropped`
- `AC2_a_late_failure_after_cancel_shows_nothing`
- `AC2_a_new_check_after_cancel_works_and_the_old_answer_cannot_overwrite_it`

### `frontend/tests/services/scrum314ConfirmationService.test.js` (35)

- `AC2_previews_a_change_with_a_post_to_the_change_preview_path_and_returns_the_body`
- `AC2_sends_the_body_for_%s_as_it_was_given` **(supporting)**
- `AC2_a_preview_never_uses_patch_or_a_get`
- `AC2_retires_with_the_confirmed_reservations_in_the_body`
- `AC2_retires_with_an_empty_body_when_none_is_given` **(supporting)**
- `AC2_an_edit_and_a_condition_change_carry_the_confirmed_list_through_unchanged`
- `AC2_lets_a_failed_preview_through_for_the_caller_to_explain` **(supporting)**
- `AC2_explains_the_list_moved_refusal_and_says_nothing_was_saved` **(supporting)**
- `AC2_has_a_message_for_a_failed_preview_that_says_nothing_was_saved`
- `AC2_shows_every_validation_error_from_a_failed_preview` **(supporting)**
- `AC2_a_failed_preview_with_status_%s_uses_the_status_message` **(supporting)**
- `AC2_a_preview_of_a_type_that_is_already_retired_says_so` **(supporting)**
- `AC2_never_shows_the_servers_text_for_the_list_moved_refusal` **(supporting)**
- `AC2_is_true_for_a_409_with_that_code` **(supporting)**
- `AC2_is_false_for_%s` **(supporting)**
- `AC2_the_list_moved_refusal_is_not_a_stale_row_so_the_catalogue_is_not_refetched` **(supporting)**
- `AC2_returns_the_conflicts_in_order` **(supporting)**
- `AC2_an_empty_list_is_an_empty_list` **(supporting)**
- `AC2_reads_%s_as_an_empty_list` **(supporting)**
- `AC2_drops_entries_that_are_not_reservations` **(supporting)**
- `AC2_gives_event_period_quantity_and_coordinator`
- `AC2_writes_the_period_in_singapore_time`
- `AC2_says_one_unit_in_the_singular` **(supporting)**
- `AC2_calls_an_event_with_%s_untitled` **(supporting)**
- `AC2_says_so_when_there_is_%s` **(supporting)**
- `AC2_trims_names` **(supporting)**
- `AC2_reads_a_quantity_that_is_%s_as_zero_units` **(supporting)**
- `AC2_marks_a_reservation_that_was_already_flagged`
- `AC2_a_reservation_without_dates_gets_the_not_set_wording_and_does_not_throw` **(supporting)**
- `AC2_adds_up_reservations_and_units` **(supporting)**
- `AC2_ignores_a_quantity_that_is_not_a_number_in_the_sum` **(supporting)**
- `AC2_gives_the_usable_figures_and_the_counts`
- `AC2_uses_the_singular_for_one_reservation_of_one_unit` **(supporting)**
- `AC2_one_reservation_of_several_units` **(supporting)**
- `AC2_leaves_the_usable_figures_out_when_%s` **(supporting)**

## AC3

### `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` (17)

- `AC3_a_flagged_reservation_still_takes_part_in_the_pass`
- `AC3_everything_fits_when_the_usable_quantity_covers_the_peak`
- `AC3_of_two_overlapping_reservations_the_older_is_kept`
- `AC3_oldest_means_made_first_not_earliest_in_time`
- `AC3_reservations_that_do_not_overlap_are_all_kept`
- `AC3_one_ending_as_another_starts_does_not_overlap_it`
- `AC3_partly_overlapping_reservations_are_judged_at_each_moment`
- `AC3_a_peak_inside_a_long_reservation_is_found`
- `AC3_an_affected_reservation_does_not_take_up_room_for_later_ones`
- `AC3_one_reservation_larger_than_the_usable_quantity_is_affected`
- `AC3_a_peak_exactly_equal_to_the_usable_quantity_fits`
- `AC3_one_unit_below_that_peak_affects_the_newer_reservation`
- `AC3_a_usable_quantity_above_everything_held_affects_nothing`
- `AC3_reservations_held_together_add_up_and_the_one_that_tips_it_is_affected`
- `AC3_the_peak_is_the_most_held_at_once_not_the_sum_of_everything_that_touches`
- `AC3_reservations_made_at_the_same_instant_are_ordered_by_id`
- `AC3_seed_%i_matches_the_brute_force_answer_for_several_usable_quantities`

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (9)

- `AC3_units_already_under_maintenance_count_against_new_damage`
- `AC3_new_maintenance_counts_against_units_already_damaged`
- `AC3_the_newest_overlapping_reservation_loses_and_the_oldest_keep_their_equipment`
- `AC3_non_overlapping_reservations_are_all_kept`
- `AC3_only_the_reservations_that_do_not_fit_are_flagged_in_a_chain_of_partial_overlaps`
- `AC3_a_reservation_already_flagged_as_unavailable_takes_part_and_is_not_flagged_twice`
- `AC3_a_reservation_larger_than_everything_usable_is_affected_and_the_rest_stay`
- `AC3_retiring_affects_every_held_reservation_that_has_not_ended`
- `AC3_seed_%i_flags_exactly_the_reservations_the_plain_rule_picks_and_nothing_else`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (1)

- `AC3_the_newer_reservation_is_the_one_that_loses_its_units`

### `frontend/tests/components/scrum314ConfirmationStep.test.jsx` (2)

- `AC3_confirming_the_new_list_sends_the_new_ids_and_not_the_old_ones`
- `AC3_the_usable_figures_from_the_preview_stay_on_the_refreshed_list`

## AC4

### `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` (1)

- `AC4_a_retirement_lists_the_reservations_even_when_no_unit_was_usable`

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (40)

- `AC4_a_null_caller_is_refused_with_42501_and_nothing_changes`
- `AC4_a_%s_is_refused_with_42501_and_nothing_changes`
- `AC4_a_coordinator_is_refused_%s_even_though_no_reservation_check_runs`
- `AC4_a_caller_with_no_profile_or_a_made_up_one_is_refused_with_42501`
- `AC4_an_unknown_type_is_refused_with_P0002` **(supporting)**
- `AC4_a_missing_type_id_is_refused_with_P0002` **(supporting)**
- `AC4_the_client_roles_cannot_execute_the_new_functions_and_service_role_can`
- `AC4_a_null_confirmed_list_is_refused`
- `AC4_a_confirmed_list_with_a_null_in_it_is_refused`
- `AC4_%s_is_refused` **(supporting)**
- `AC4_nothing_to_change_is_refused`
- `AC4_retire_false_with_nothing_else_is_refused`
- `AC4_retiring_together_with_%s_is_refused`
- `AC4_fields_given_as_%s_are_refused`
- `AC4_damaged_plus_under_maintenance_above_the_total_is_refused`
- `AC4_a_smaller_total_than_the_units_already_out_is_refused`
- `AC4_damaged_plus_under_maintenance_exactly_the_total_is_allowed`
- `AC4_a_total_of_zero_is_allowed_when_nothing_is_out`
- `AC4_a_confirmed_change_saves_the_type_flags_the_reservation_and_returns_its_request_to_pending_review`
- `AC4_a_request_under_review_also_returns_to_pending_review`
- `AC4_a_reservation_is_flagged_never_released_or_cancelled`
- `AC4_the_saved_row_comes_back_in_the_answer_as_stored`
- `AC4_a_forced_failure_while_flagging_changes_nothing`
- `AC4_a_name_that_is_already_taken_fails_the_whole_save_and_flags_nothing`
- `AC4_an_edit_of_the_name_and_a_smaller_total_save_together`
- `AC4_only_the_fields_given_change_and_null_clears_a_field`
- `AC4_unknown_keys_in_fields_are_ignored`
- `AC4_changes_to_one_type_never_touch_another_types_reservations`
- `AC4_a_retirement_sets_retired_at_and_leaves_the_quantities`
- `AC4_retiring_a_retired_type_is_a_PT409_with_its_hint_and_changes_nothing`
- `AC4_a_retired_type_can_still_have_its_quantities_changed`
- `AC4_retiring_a_type_with_no_usable_units_still_flags_the_reservations_it_holds`
- `AC4_retiring_a_type_with_no_usable_units_leaves_a_reservation_already_flagged_as_unavailable_alone`
- `AC4_retiring_a_type_whose_reservations_have_all_ended_saves_directly`
- `AC4_the_trigger_and_its_function_no_longer_exist`
- `AC4_a_change_the_save_makes_is_flagged_once_not_again_by_the_backstop`
- `AC4_the_fixes_migration_can_be_run_again_and_the_save_still_works`
- `AC4_the_other_flagging_triggers_still_work`
- `AC4_a_plain_update_that_lowers_the_usable_quantity_flags_the_newest_reservations`
- `AC4_a_plain_retirement_flags_every_held_reservation_even_with_no_usable_units`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (2)

- `AC4_a_confirmed_save_changes_the_type_flags_the_listed_reservations_and_sends_their_requests_back`
- `AC4_a_confirmation_that_does_not_match_the_check_saves_nothing`

### `backend/tests/routes/scrum313ConfirmedSaveRoutes.test.js` (18)

- `AC4_refuses_%s_from_%s_with_403_and_reads_and_saves_nothing`
- `AC4_refuses_%s_when_signed_out_with_401`
- `AC4_%s_made_by_a_coordinator_cannot_be_unlocked_with_a_role_in_the_body`
- `AC4_a_total_edit_answers_200_with_the_type_and_what_was_flagged`
- `AC4_a_damage_change_answers_200_with_the_new_usable_figure`
- `AC4_a_retirement_answers_200_with_retired_at_and_what_was_flagged`
- `AC4_%s_cannot_add_parameters_the_function_does_not_take_through_the_body` **(supporting)**
- `AC4_a_409_for_a_retired_type_keeps_its_own_code`
- `AC4_a_retirement_that_loses_a_race_to_another_retirement_is_a_409_with_that_code`
- `AC4_%s_answers_400_and_never_reaches_the_function` **(supporting)**
- `AC4_a_retirement_with_a_list_as_its_body_answers_400` **(supporting)**
- `AC4_%s_answers_400_for_a_malformed_id_without_a_query` **(supporting)**
- `AC4_%s_answers_404_for_an_unknown_type`
- `AC4_%s_answers_404_when_the_type_goes_before_the_save` **(supporting)**
- `AC4_%s_answers_403_when_the_database_says_the_caller_may_not` **(supporting)**
- `AC4_%s_answers_400_when_the_database_refuses_the_input`
- `AC4_%s_answers_500_without_the_database_message_when_the_function_fails`
- `AC4_%s_answers_500_when_the_function_answers_something_unexpected` **(supporting)**

### `backend/tests/services/scrum313ConfirmedSaveService.test.js` (30)

- `AC4_the_supabase_client_is_mocked_and_never_the_real_one` **(supporting)**
- `AC4_a_total_edit_sends_only_the_fields_that_were_given`
- `AC4_a_total_edit_can_clear_a_text_field` **(supporting)**
- `AC4_a_total_edit_never_puts_the_total_note_or_list_inside_the_fields` **(supporting)**
- `AC4_a_total_of_zero_is_sent_as_zero` **(supporting)**
- `AC4_a_maintenance_change_sends_the_maintenance_figure`
- `AC4_a_retirement_sends_retire_true_and_no_quantities`
- `AC4_%s_makes_one_read_and_one_call_and_no_table_write`
- `AC4_an_edit_of_%s_is_a_plain_update_and_calls_nothing_else` **(supporting)**
- `AC4_a_list_and_a_note_with_no_total_are_not_written_to_any_column` **(supporting)**
- `AC4_a_plain_edit_still_translates_a_deadlock_into_try_again` **(supporting)**
- `AC4_reinstating_is_not_a_change_that_needs_confirming` **(supporting)**
- `AC4_%s_returns_the_saved_type_as_the_api_shapes_it` **(supporting)**
- `AC4_returns_how_many_were_flagged_and_which`
- `AC4_%s_as_the_answer_is_an_error` **(supporting)**
- `AC4_a_save_with_%s_is_an_error` **(supporting)**
- `AC4_%s_becomes_the_right_typed_error` **(supporting)**
- `AC4_a_deadlock_asks_the_staff_member_to_try_again`
- `AC4_an_error_the_service_does_not_know_stays_untyped` **(supporting)**
- `AC4_a_failed_call_is_not_retried_by_the_service` **(supporting)**
- `AC4_%s_is_refused_before_any_query` **(supporting)**
- `AC4_%s_is_refused_and_names_the_field` **(supporting)**
- `AC4_a_total_below_damaged_plus_maintenance_is_refused_before_the_call` **(supporting)**
- `AC4_a_name_already_used_is_refused_before_the_call` **(supporting)**
- `AC4_an_unknown_type_is_not_found_before_the_call` **(supporting)**
- `AC4_a_type_that_is_already_retired_is_a_409_before_the_call` **(supporting)**
- `AC4_a_failed_read_of_the_row_stops_before_the_call` **(supporting)**
- `AC4_the_migration_declares_nine_parameters`
- `AC4_%s_sends_exactly_the_declared_parameter_names`
- `AC4_the_rpc_name_is_the_function_the_migration_creates`

### `backend/tests/validation/scrum313ConfirmedSaveValidation.test.js` (4)

- `AC4_accepts_%s_and_confirms_nothing` **(supporting)**
- `AC4_ignores_fields_it_does_not_know_and_does_not_return_them` **(supporting)**
- `AC4_refuses_%s_as_a_body` **(supporting)**
- `AC4_does_not_change_the_input_it_was_given` **(supporting)**

### `frontend/tests/components/scrum314ConfirmationStep.test.jsx` (27)

- `AC4_confirming_saves_the_total_with_exactly_the_reservations_shown`
- `AC4_returns_to_a_refreshed_list_after_the_save`
- `AC4_sends_the_reason_with_the_confirmed_total_change`
- `AC4_the_other_edited_fields_are_previewed_with_the_total_and_saved_with_it` **(supporting)**
- `AC4_confirming_a_damage_change_saves_it_with_the_note_and_the_list`
- `AC4_a_maintenance_change_is_previewed_and_saved_the_same_way`
- `AC4_both_quantities_are_previewed_and_saved_together`
- `AC4_the_confirm_button_is_pressed_once_so_the_save_is_sent_once`
- `AC4_confirming_a_retirement_sends_the_list_that_was_shown_and_refreshes`
- `AC4_a_failed_save_keeps_the_list_on_screen_with_the_message_and_allows_another_try`
- `AC4_a_failed_damage_save_shows_the_conditions_message`
- `AC4_going_back_after_a_failed_save_returns_to_the_form_with_nothing_saved`
- `AC4_a_failed_retirement_after_the_list_stays_in_front_of_the_user`
- `AC4_a_retirement_that_finds_the_type_already_retired_closes_the_list_and_refreshes` **(supporting)**
- `AC4_a_direct_retirement_failure_after_an_empty_preview_closes_the_confirm_step_as_before` **(supporting)**
- `AC4_submitting_the_edit_form_twice_in_one_moment_asks_the_backend_once` **(supporting)**
- `AC4_submitting_the_edit_form_again_while_it_is_checking_does_nothing` **(supporting)**
- `AC4_submitting_the_damage_form_again_while_it_is_checking_does_nothing` **(supporting)**
- `AC4_pressing_confirm_twice_in_one_moment_saves_once`
- `AC4_the_list_stays_on_screen_while_the_confirmed_save_is_running` **(supporting)**
- `AC4_a_direct_save_after_an_empty_preview_shows_saving_on_the_form_button` **(supporting)**
- `AC4_a_save_already_on_its_way_still_refreshes_the_list_when_the_user_has_left`
- `AC4_a_save_that_fails_after_the_user_left_shows_nothing_and_does_not_crash`
- `AC4_a_reinstate_that_finds_the_type_not_retired_explains_it_and_refreshes` **(supporting)**
- `AC4_a_reinstate_that_fails_otherwise_says_so_and_does_not_refresh` **(supporting)**
- `AC4_the_reinstate_button_shows_it_is_working` **(supporting)**
- `AC4_a_refresh_that_fails_after_a_change_shows_the_load_message` **(supporting)**

## AC5

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (5)

- `AC5_the_coordinator_of_each_affected_event_gets_one_notice_with_the_reason`
- `AC5_an_unaffected_event_and_a_refused_save_notify_nobody`
- `AC5_a_reservation_already_flagged_as_unavailable_is_not_announced_again`
- `AC5_a_reservation_flagged_for_another_reason_is_announced_when_its_equipment_becomes_unavailable`
- `AC5_a_retirement_names_the_retirement_as_the_reason`

### `backend/tests/db/scrum315EquipmentForEventFlagsDatabase.test.js` (21)

- `AC5_an_event_with_no_equipment_request_still_answers_null`
- `AC5_a_line_with_no_reservations_has_an_empty_flagged_list`
- `AC5_a_reservation_that_is_not_flagged_is_not_listed`
- `AC5_a_flagged_reservation_is_listed_with_its_quantity_period_and_reason`
- `AC5_a_flag_with_no_reason_is_listed_with_a_null_reason`
- `AC5_a_released_reservation_is_not_listed_even_if_it_was_flagged`
- `AC5_several_flags_on_one_line_are_listed_by_start_time`
- `AC5_only_the_line_with_the_flag_shows_it`
- `AC5_flags_on_another_event_do_not_leak_into_this_one`
- `AC5_a_newer_cancelled_request_does_not_hide_the_live_one_and_its_flags`
- `AC5_the_rest_of_the_answer_is_unchanged`
- `AC5_a_real_equipment_loss_shows_on_the_line_and_the_event_stays_as_it_was`
- `AC5_a_loss_flagged_through_the_confirmed_save_gets_the_equipment_lost_code`
- `AC5_a_retirement_flags_with_the_equipment_lost_code_too`
- `AC5_the_older_flag_function_used_by_the_date_change_flow_sets_no_code`
- `AC5_a_code_can_be_asked_for_by_name`
- `AC5_asking_for_no_code_gives_none`
- `AC5_a_code_that_is_not_known_is_refused_and_nothing_is_flagged`
- `AC5_running_the_migration_again_codes_flags_set_before_it_by_their_reason_and_changes_nothing_else`
- `AC5_a_flag_that_already_has_a_code_is_not_recoded_by_a_rerun`
- `AC5_the_old_three_argument_flag_function_is_gone_and_there_is_one_flag_by_function`

### `backend/tests/db/scrum315NeedsAttentionWalkthrough.test.js` (3)

- `AC5_AC6_lost_equipment_marks_the_line_and_puts_the_confirmed_event_on_the_list`
- `AC5_AC6_a_date_change_flag_is_on_the_list_but_is_not_called_equipment_lost`
- `AC5_a_lost_equipment_flag_carries_its_code_to_the_event_record`

### `backend/tests/services/equipmentLineService.test.js` (10)

- `AC5_a_line_carries_each_flagged_reservation_in_camel_case`
- `AC5_the_order_the_database_gave_is_kept`
- `AC5_a_flag_whose_code_is_%s_gives_a_null_code`
- `AC5_the_code_is_passed_on_as_it_was_given` **(supporting)**
- `AC5_a_flag_without_a_reason_or_a_time_gives_nulls`
- `AC5_a_flag_missing_those_keys_gives_nulls_too` **(supporting)**
- `AC5_a_line_with_none_has_an_empty_list`
- `AC5_when_the_answer_is_%s_the_line_has_an_empty_list`
- `AC5_every_line_is_read_on_its_own`
- `AC5_a_write_answers_with_the_flags_too`

### `frontend/tests/components/EventEquipmentSection.test.jsx` (9)

- `AC5_the_line_says_equipment_was_lost_with_the_reason_and_the_period`
- `AC5_only_the_flagged_line_is_marked`
- `AC5_a_line_with_%s_is_not_marked`
- `AC5_a_flag_with_no_reason_says_it_was_flagged_for_review`
- `AC5_the_marker_is_there_for_an_event_that_is_still_approved_too`
- `AC5_every_flagged_reservation_on_the_line_is_listed`
- `AC5_a_flag_that_is_not_about_lost_equipment_is_called_flagged_for_review`
- `AC5_a_line_with_a_lost_flag_and_another_flag_is_called_flagged_for_review`
- `AC5_a_flag_on_one_line_does_not_stop_the_other_lines_actions`

### `frontend/tests/services/scrum315FlagDisplay.test.js` (16)

- `AC5_a_line_with_one_flag_gives_its_quantity_period_and_reason` **(supporting)**
- `AC5_the_two_headings_are_the_ones_the_screen_shows` **(supporting)**
- `AC5_several_lost_equipment_flags_are_all_called_equipment_lost`
- `AC5_a_flag_whose_code_is_%s_is_called_flagged_for_review_not_equipment_lost`
- `AC5_one_flag_for_something_else_among_lost_ones_means_the_line_is_not_called_equipment_lost`
- `AC5_the_period_is_written_in_singapore_time`
- `AC5_one_unit_is_singular`
- `AC5_several_flags_are_totalled_and_kept_in_order`
- `AC5_a_flag_with_a_%s_reason_gets_the_plain_wording`
- `AC5_the_reason_is_trimmed`
- `AC5_a_flag_with_no_dates_says_so_instead_of_throwing`
- `AC5_%s_counts_as_zero_units`
- `AC5_a_flag_without_an_id_gets_a_stable_key`
- `AC5_entries_that_are_not_objects_are_skipped`
- `AC5_%s_means_nothing_flagged`
- `AC5_a_list_of_only_junk_means_nothing_flagged`

## AC6

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (4)

- `AC6_an_event_that_is_%s_keeps_that_status_when_its_equipment_is_flagged`
- `AC6_a_reservation_flagged_for_another_reason_is_flagged_as_unavailable_when_its_equipment_is_lost`
- `AC6_a_flag_for_another_reason_never_replaces_a_flag_for_unavailable_equipment`
- `AC6_a_second_flag_for_another_reason_leaves_the_first_one_alone`

### `backend/tests/db/scrum315EquipmentForEventFlagsDatabase.test.js` (5)

- `AC6_the_list_empties_when_the_flag_is_cleared`
- `AC6_a_confirmed_event_keeps_its_status_and_shows_the_flag`
- `AC6_clearing_the_flag_clears_the_code`
- `AC6_a_code_cannot_be_kept_on_a_reservation_that_is_not_flagged`
- `AC6_a_flag_that_stays_set_keeps_its_code_through_other_updates`

### `backend/tests/db/scrum315NeedsAttentionWalkthrough.test.js` (6)

- `AC6_a_confirmed_event_with_nothing_flagged_is_not_on_the_list`
- `AC6_the_event_stays_confirmed_through_the_loss`
- `AC6_an_event_that_holds_none_of_the_lost_equipment_is_not_on_the_list`
- `AC6_the_entry_goes_once_the_flagged_reservation_is_released`
- `AC6_the_entry_stays_while_any_flagged_reservation_remains`
- `AC6_a_flag_cleared_by_hand_takes_the_event_off_the_list`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (1)

- `AC6_a_confirmed_event_stays_confirmed_and_keeps_a_flagged_reservation_to_show`

### `backend/tests/services/eventRequestService.test.js` (23)

- `AC6_a_confirmed_event_with_%s_needs_attention_%s`
- `AC6_an_event_that_is_%s_does_not_need_attention_for_a_flagged_reservation`
- `AC6_when_%s_a_confirmed_event_does_not_need_attention`
- `AC6_an_embed_read_as_one_object_is_still_read`
- `AC6_a_null_entry_in_the_embed_is_skipped`
- `AC6_the_reason_the_flag_was_given_is_the_reason_shown`
- `AC6_a_lost_equipment_flag_whose_reason_is_%s_still_says_equipment_lost`
- `AC6_a_flag_whose_kind_is_%s_is_not_called_equipment_lost`
- `AC6_an_other_flag_with_a_%s_reason_says_only_that_it_is_flagged`
- `AC6_a_lost_flag_and_another_flag_with_the_same_reason_are_two_entries`
- `AC6_the_reason_is_trimmed`
- `AC6_two_flags_with_the_same_reason_are_one_entry`
- `AC6_flags_with_different_reasons_are_each_listed_in_the_order_met`
- `AC6_a_released_flag_adds_no_reason`
- `AC6_a_venue_flag_and_an_equipment_flag_are_both_given_as_reasons`
- `AC6_a_venue_flag_alone_still_gives_its_reason_and_an_equipment_flag_alone_gives_only_its_own`
- `AC6_an_event_that_does_not_need_attention_has_an_empty_reasons_list_not_a_missing_one`
- `AC6_the_organiser_list_names_the_kind_of_flag_and_not_the_staff_note`
- `AC6_the_organiser_single_read_names_the_kind_of_flag_and_not_the_staff_note`
- `AC6_an_organiser_sees_other_flags_by_kind_too_and_the_venue_reason_unchanged`
- `AC6_two_flags_of_one_kind_show_the_organiser_one_line`
- `AC6_the_coordinator_still_gets_the_reason_with_the_note`
- `AC6_every_event_read_that_carries_needs_attention_embeds_the_reservation_flags`

### `frontend/tests/components/CoordinatorRequestDetail.test.jsx` (2)

- `AC6_the_header_gives_the_reasons_under_the_event`
- `AC6_no_reasons_are_shown_when_%s`

### `frontend/tests/components/MyAssignedEvents.test.jsx` (3)

- `AC6_a_row_shows_the_reason_beside_its_badge`
- `AC6_only_the_rows_that_need_attention_show_reasons`
- `AC6_a_badge_with_no_reasons_still_shows_the_badge_only`

### `frontend/tests/components/NeedsAttentionReasons.test.jsx` (3)

- `AC6_lists_every_reason_the_server_gave`
- `AC6_shows_nothing_when_%s`
- `AC6_two_equal_reasons_do_not_break_the_list`

### `frontend/tests/services/scrum315FlagDisplay.test.js` (4)

- `AC6_gives_the_reasons_of_an_event_that_needs_attention`
- `AC6_trims_each_reason`
- `AC6_drops_blank_and_non_text_reasons`
- `AC6_shows_nothing_when_%s`

## AC7

### `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` (1)

- `AC7_%s_lists_nobody_even_when_the_type_is_already_over_committed`

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (11)

- `AC7_a_type_with_no_reservations_saves_a_smaller_total_with_nothing_flagged`
- `AC7_damage_that_still_leaves_enough_units_saves_with_nothing_flagged`
- `AC7_a_boundary_change_that_leaves_exactly_enough_units_affects_nothing`
- `AC7_one_unit_below_the_boundary_is_not_saved_directly`
- `AC7_ended_and_released_reservations_do_not_block_a_direct_save`
- `AC7_a_reservation_on_another_type_does_not_block_a_direct_save`
- `AC7_raising_the_usable_quantity_is_never_checked_and_flags_nothing`
- `AC7_a_change_that_keeps_the_usable_quantity_the_same_saves_directly`
- `AC7_a_name_only_edit_saves_with_no_check_at_all`
- `AC7_a_direct_save_still_refuses_a_confirmed_id_that_is_not_affected`
- `AC7_a_plain_update_that_leaves_room_or_changes_only_the_name_flags_nothing`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (1)

- `AC7_%s_that_leaves_room_for_every_reservation_saves_directly`

### `backend/tests/routes/scrum312ChangePreviewRoutes.test.js` (1)

- `AC7_answers_200_with_an_empty_list_when_no_one_is_affected`

### `backend/tests/routes/scrum313ConfirmedSaveRoutes.test.js` (1)

- `AC7_a_retirement_needs_no_body_when_nothing_is_affected`

### `backend/tests/services/scrum312ChangePreviewService.test.js` (1)

- `AC7_names_the_type_and_reports_no_one_affected_for_an_empty_list`

### `backend/tests/services/scrum313ConfirmedSaveService.test.js` (2)

- `AC7_a_save_that_affected_nothing_returns_zero_and_an_empty_list`
- `AC7_reads_a_missing_count_as_zero_and_missing_affected_as_empty`

### `frontend/tests/components/scrum314ConfirmationStep.test.jsx` (8)

- `AC7_a_total_with_no_reservations_affected_saves_at_once_with_an_empty_list`
- `AC7_a_damage_change_with_no_reservations_affected_saves_at_once`
- `AC7_raising_a_total_is_still_checked_and_saves_when_nothing_is_affected`
- `AC7_a_retirement_with_no_reservations_affected_retires_after_the_existing_confirm_only`
- `AC7_an_edit_that_leaves_the_total_alone_is_not_previewed`
- `AC7_a_reason_typed_for_a_non_total_edit_is_not_sent`
- `AC7_a_blank_reason_is_not_sent_with_a_total_change`
- `AC7_creating_a_type_never_asks_which_reservations_it_affects`

### `frontend/tests/components/useConfirmedChange.test.jsx` (1)

- `AC7_a_late_empty_answer_after_cancel_does_not_save`

### `frontend/tests/services/scrum314ConfirmationService.test.js` (3)

- `AC7_an_empty_list_sums_to_zero`
- `AC7_says_nothing_is_affected_for_an_empty_list_whatever_the_figures`
- `AC7_zero_usable_after_is_a_figure_not_a_missing_one`

## AC8

### `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` (14)

- `AC8_a_damage_change_with_%s_is_refused`
- `AC8_a_maintenance_change_with_%s_is_refused`
- `AC8_the_history_row_names_the_user_the_old_and_new_value_and_the_note`
- `AC8_a_total_change_records_its_optional_note_and_one_without_a_note_records_none`
- `AC8_a_retirement_records_the_user_and_its_note`
- `AC8_a_combined_change_writes_one_history_row_per_field_that_changed`
- `AC8_each_flag_event_records_the_user_the_time_and_the_reason_with_the_note`
- `AC8_without_a_note_the_flag_reason_is_the_plain_one`
- `AC8_a_blank_note_on_a_total_change_counts_as_no_note`
- `AC8_a_retirement_flag_records_the_user_and_the_retirement_reason`
- `AC8_the_note_is_trimmed_before_it_is_stored`
- `AC8_a_refused_save_records_nothing`
- `AC8_the_old_two_argument_flagging_still_records_no_user`
- `AC8_the_new_flagging_function_records_the_user_it_is_given`

### `backend/tests/db/scrum316FourChangesDatabase.test.js` (1)

- `AC8_the_change_and_each_flag_record_the_user_the_time_and_the_reason`

### `backend/tests/routes/scrum313ConfirmedSaveRoutes.test.js` (2)

- `AC8_%s_uses_the_signed_in_user_whatever_the_body_says`
- `AC8_a_retirement_with_a_bad_note_answers_400` **(supporting)**

### `backend/tests/services/scrum313ConfirmedSaveService.test.js` (3)

- `AC8_a_damage_change_sends_the_damage_the_note_and_the_list_and_nothing_else` **(supporting)**
- `AC8_%s_is_made_as_the_acting_user`
- `AC8_without_an_acting_user_the_caller_is_null_and_the_database_refuses`

### `backend/tests/validation/scrum313ConfirmedSaveValidation.test.js` (6)

- `AC8_leaves_the_note_out_when_none_is_sent`
- `AC8_trims_the_note`
- `AC8_reads_a_%s_note_as_none`
- `AC8_refuses_%s_as_a_note`
- `AC8_does_not_count_a_note_alone_as_a_change`
- `AC8_still_requires_a_note_on_a_damage_change`
