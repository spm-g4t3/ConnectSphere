# SCRUM-310: Test Cases

**Story:** Handle Equipment Lost After Reservation - Technical Support Staff
**Subtask:** SCRUM-317 (this document)
**Schema:** `020_equipment_over_commitment.sql`, `021_equipment_confirmed_save.sql`, `023_equipment_for_event_flags.sql` (SCRUM-311, SCRUM-313, SCRUM-315) and `026_equipment_loss_fixes.sql` (review fixes)
**Status:** 8 of 8 acceptance criteria proved. 0 cases not yet implemented. Two criteria rest on other stories' work (AC5 on SCRUM-176, AC6 on SCRUM-266); both stories are Done, and what each gives this story is listed under **Dependencies**. The review is `docs/SCRUM-310.md`.
**Written:** 25 October 2026, after the code, from the tests' own names. A script checks that every test named below exists, so a rename that is not copied here fails the check.

This document is the written layer between SCRUM-310's acceptance criteria and the
tests. The chain is **user story → acceptance criteria → test case → test → code**.
The cases name the tests that prove each behaviour. The full list
(`docs/test-cases/SCRUM-310-test-ids.md`) has every test ID under its AC and marks
the supporting ones, the checks on bodies, wording and error mapping around a case
that are not worth a case of their own.

---

## How case IDs relate to test names

Each case has a short stable ID (`AC4-03`). **Implemented by** names the tests that
prove it with the `SCRUM310_` prefix left off, so a name starting `AC4_` is the test
of that name with `SCRUM310_` in front. A name with `%s` is a parameterised test that runs
once per value. A test named `AC5_AC6_…` proves both criteria and is counted under AC5.

| Short | File | Proves |
|---|---|---|
| calc | `backend/tests/db/scrum311EquipmentOverCommitmentDatabase.test.js` | Which reservations a lower usable quantity cannot keep (SCRUM-311) |
| save | `backend/tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js` | The confirmed save: refusals, flags, requests, notices, history (SCRUM-313) |
| four | `backend/tests/db/scrum316FourChangesDatabase.test.js` | Damage, maintenance, a lower total and a retirement, each through the whole flow (SCRUM-316) |
| flags | `backend/tests/db/scrum315EquipmentForEventFlagsDatabase.test.js` | The event record's flagged lines and the flag's kind (SCRUM-315) |
| walk | `backend/tests/db/scrum315NeedsAttentionWalkthrough.test.js` | A real loss, end to end, through the API to the coordinator's views (SCRUM-315) |
| route | `backend/tests/routes/scrum312ChangePreviewRoutes.test.js`, `scrum313ConfirmedSaveRoutes.test.js` | The gate, status codes, the caller from the token |
| svc | `backend/tests/services/scrum312ChangePreviewService.test.js`, `scrum313ConfirmedSaveService.test.js`, `equipmentLineService.test.js`, `eventRequestService.test.js` | What is sent to the database, how answers and errors are read, `needsAttention` |
| valid | `backend/tests/validation/scrum312ChangePreviewValidation.test.js`, `scrum313ConfirmedSaveValidation.test.js` | What the API accepts and refuses in a body |
| screen | `frontend/tests/components/scrum314ConfirmationStep.test.jsx`, `useConfirmedChange.test.jsx` | The confirmation step on the catalogue |
| fsvc | `frontend/tests/services/scrum314ConfirmationService.test.js`, `scrum315FlagDisplay.test.js` | The calls, the wording, the flagged-line wording |
| coord | `frontend/tests/components/EventEquipmentSection.test.jsx`, `CoordinatorRequestDetail.test.jsx`, `MyAssignedEvents.test.jsx`, `NeedsAttentionReasons.test.jsx` | What the coordinator sees |

---

## The story

> **USER STORY:** As Technical Support Staff, when equipment is damaged, under
> maintenance, reduced or retired after it has been reserved, I want to see which
> reservations it affects and confirm the change, so that the right events are told
> and no one is surprised.

### Acceptance criteria

Summarised from the ticket.

1. A change that lowers the usable quantity (damage, maintenance, a lower total, or
   retiring the type) is checked against reservations that have not ended.
2. The affected reservations are shown and the change needs a confirmation. Without
   it nothing is saved.
3. First come, first served: the oldest reservations keep their equipment.
4. On confirmation the change is saved and the affected reservations are flagged
   "equipment lost" together, as one action. Their requests return to Pending
   review.
5. The coordinator is notified (SCRUM-176) and the event record shows the affected
   lines.
6. A Confirmed event stays Confirmed but is marked "Needs attention".
7. A change that affects nothing saves directly.
8. The change and each flag record the user, the date and time and the reason.

---

## Dependencies

| Story | Status | What this story relies on | Where it is proved here |
|---|---|---|---|
| SCRUM-176 Notify Users of Equipment Requests and Availability | Done | The `equipment_flagged` notice, sent by the trigger on a reservation becoming flagged, and its wording in the inbox | AC5-01 to AC5-03 prove our flagging sends it, once per affected event, with the reason. The inbox wording is SCRUM-176's own tests (`equipmentNotificationDisplay.test.js`) and is not repeated |
| SCRUM-266 Resolve a Flagged Venue Booking | Done | The "Needs attention" badge on the coordinator's events | AC6-02 to AC6-04 prove an equipment flag puts a Confirmed event on the list and takes it off again. The badge is 266's; this story added the equipment reasons beside it |
| SCRUM-395 Apply a Significant Change to a Planned Event | Done | The date-change flow that flags reservations without a code | AC5-05 proves that flow's flags are shown as "flagged for review", not "equipment unavailable" |

---

## Case tables

### AC1: the change is checked against reservations that have not ended

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC1-01 | Only Technical Support Staff may ask; no caller, another role or no profile is refused (42501) | calc: `AC1_a_null_caller_is_refused_with_42501`, `AC1_only_technical_support_staff_may_ask`, `AC1_a_%s_is_refused_with_42501`, `AC1_a_caller_with_no_profile_is_refused_with_42501`, `AC1_the_client_roles_cannot_execute_it_and_service_role_can`. route: `AC1_refuses_%s_with_403_and_reads_nothing`, `AC1_refuses_a_signed_out_caller_with_401_and_reads_nothing`, `AC1_a_role_named_in_the_body_does_not_help_a_coordinator`, `AC1_a_database_refusal_of_the_caller_is_a_403` | Proved |
| AC1-02 | A missing type, a negative or missing figure and a bad id are refused with their own errors | calc: `AC1_an_unknown_type_is_refused_with_P0002`, `AC1_a_missing_type_id_is_refused_with_P0002`, `AC1_a_negative_or_missing_usable_quantity_is_refused_with_22023`. route: `AC1_an_unknown_type_is_a_404`, `AC1_a_malformed_id_is_a_400_with_no_query`. svc: `AC1_a_bad_id_%j_is_a_400_with_no_query` | Proved |
| AC1-03 | Bad bodies are refused before the database is asked: empty, unknown fields only, negative, damaged plus maintenance above the total | valid: `AC1_refuses_an_empty_object`, `AC1_refuses_a_body_with_only_unknown_fields`, `AC1_refuses_a_bad_%s`, `AC1_lists_every_invalid_field_together`, `AC1_keeps_a_valid_field_even_when_another_is_invalid`. route: `AC1_damaged_plus_under_maintenance_above_the_total_is_a_400_listing_the_field`. svc: `AC1_%s_is_a_400_naming_%s_with_no_rpc`, `AC1_damaged_plus_maintenance_exactly_equal_to_the_total_is_allowed` | Proved |
| AC1-04 | A reservation that is held and has not ended counts, including one already under way and one on a Confirmed or other-status event | calc: `AC1_a_reservation_already_under_way_still_counts`, `AC1_a_reservation_on_a_%s_event_is_still_checked` | Proved |
| AC1-05 | A reservation that has ended, been released, belongs to another type or sits on a cancelled request is ignored | calc: `AC1_reservations_that_have_ended_are_ignored`, `AC1_released_reservations_are_ignored`, `AC1_another_types_reservations_are_ignored`, `AC1_a_request_cancelled_after_the_reservation_no_longer_counts`. four: `AC1_a_reservation_that_has_already_ended_is_not_listed` | Proved |
| AC1-06 | A type with nothing reserved has nothing affected; a usable quantity of zero affects every held reservation | calc: `AC1_a_type_with_no_reservations_has_nothing_affected`, `AC1_a_usable_quantity_of_zero_affects_every_held_reservation` | Proved |
| AC1-07 | Each of the four changes is checked: damage, maintenance, a lower total, a retirement (a retirement is zero usable) | four: `AC1_the_check_lists_the_unended_reservations_the_change_cannot_cover` (once per change). svc: `AC1_sends_%s_as_it_was_given_and_leaves_the_rest_null`, `AC1_the_usable_quantities_are_the_ones_the_database_answered`, `AC1_a_retired_type_can_still_have_a_quantity_change_previewed`. calc: `AC1_a_retired_type_still_answers_and_all_its_held_reservations_are_affected`. route: `AC1_a_retirement_is_previewed_as_zero_usable` | Proved |
| AC1-08 | Asking changes nothing: no reservation, history or notice is written, and the function is declared stable | calc: `AC1_asking_changes_no_reservation_and_writes_no_history_or_notice`, `AC1_the_function_is_declared_stable`. route: `AC1_editing_a_type_still_works_and_does_not_call_the_preview_function` | Proved |
| AC1-09 | The preview route is a POST of its own and does not disturb the others | route: `AC1_%s_on_the_preview_path_is_not_a_preview`, `AC1_the_history_route_is_not_swallowed_by_the_new_one` | Proved |
| AC1-10 | An unexpected database failure is a 500 that does not leak its message; a vanished type is a 404 | route: `AC1_an_unexpected_database_failure_is_a_500_that_does_not_leak_its_message`, `AC1_a_type_that_vanishes_before_the_function_runs_is_a_404`. svc: `AC1_an_unlisted_rpc_error_stays_an_untyped_failure`, `AC1_a_failed_read_of_the_type_is_not_swallowed_and_the_rpc_is_not_asked` | Proved |
| AC1-11 | The preview and the save share one calculation, `equipment_change_affected`: it reports the usable quantity before and after for each kind of change, lists the same reservations as the check, lists nobody for a change that raises or keeps the usable quantity, still lists a retirement's reservations when no unit was usable, only reads, and is closed to the client roles | calc: `AC1_%s_reports_the_usable_quantity_before_and_after`, `AC1_quantities_left_out_stay_as_they_are`, `AC1_a_change_that_lowers_the_usable_quantity_lists_the_same_reservations_as_the_check`, `AC7_%s_lists_nobody_even_when_the_type_is_already_over_committed`, `AC4_a_retirement_lists_the_reservations_even_when_no_unit_was_usable`, `AC1_it_only_reads`, `AC1_the_client_roles_cannot_execute_the_new_functions_and_service_role_can`, `AC1_a_null_caller_and_other_roles_are_refused_with_42501`, `AC1_an_unknown_type_is_refused_with_P0002`, `AC1_a_change_that_takes_the_usable_quantity_below_zero_is_refused_with_22023`, `AC1_the_unchecked_calculation_refuses_a_negative_figure_and_an_unknown_type`. svc: `AC1_the_database_decides_whether_a_change_can_affect_anything_so_it_is_always_asked`, `AC1_a_usable_figure_in_the_body_is_never_sent`, `AC1_the_argument_names_sent_are_the_parameter_names_of_the_real_function` | Proved |
| AC1-12 | A bad or taken name, or a bad description, category or location, is refused when the change is previewed, so it is found before the list is confirmed; a name alone is not a change to preview; a retirement cannot carry an edited field | valid: `AC1_reads_the_name_and_the_optional_text_fields_trimmed`, `AC1_refuses_the_name_%j`, `AC1_refuses_a_%s_that_is_not_text`, `AC1_a_name_alone_is_not_a_change_to_preview`, `AC1_refuses_retire_together_with_%s`. svc: `AC1_a_name_that_is_already_taken_is_a_400_naming_name_and_the_rpc_is_not_asked`, `AC1_a_bad_name_%j_is_a_400_with_no_query`, `AC1_a_free_name_goes_through_and_is_never_sent_to_the_database_function`, `AC1_a_retirement_with_an_edited_field_is_refused`. screen: `AC2_sends_the_edited_name_with_the_total_so_a_taken_name_is_found_before_confirming`, `AC2_a_name_the_preview_refuses_is_shown_on_the_form_and_no_list_is_offered` | Proved |

### AC2: the affected reservations are shown; nothing is saved without a confirmation

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC2-01 | Each affected reservation names the event, period, quantity and coordinator, in the order they were made | calc: `AC2_each_affected_reservation_names_the_event_period_quantity_and_coordinator`, `AC2_the_list_is_in_the_order_the_reservations_were_made`. svc: `AC2_maps_a_row_to_the_api_shape_field_by_field`, `AC2_keeps_the_order_the_database_gave_and_totals_the_units`, `AC2_a_coordinator_with_no_name_comes_back_as_null_not_dropped`. route: `AC2_answers_200_with_the_preview` | Proved |
| AC2-02 | The screen shows the list with the figures and what confirming does | screen: `AC2_asks_which_reservations_the_new_total_affects_before_saving`, `AC2_shows_event_period_quantity_and_coordinator_for_each_affected_reservation`, `AC2_keeps_the_order_the_backend_gave`, `AC2_says_how_many_reservations_and_units_and_how_usable_changes`, `AC2_says_what_confirming_does`, `AC2_marks_a_reservation_that_was_already_flagged`, `AC2_says_when_an_event_has_no_coordinator_or_no_name`. fsvc: `AC2_gives_event_period_quantity_and_coordinator`, `AC2_writes_the_period_in_singapore_time`, `AC2_gives_the_usable_figures_and_the_counts` | Proved |
| AC2-03 | Damage, maintenance and a retirement show their list the same way | screen: `AC2_a_retirement_that_affects_reservations_lists_them_under_the_row_and_retires_nothing`, `AC4_a_maintenance_change_is_previewed_and_saved_the_same_way`, `AC4_both_quantities_are_previewed_and_saved_together`, `AC2_only_the_row_being_retired_shows_a_list` | Proved |
| AC2-04 | Without a confirmation nothing is saved or flagged: asking, going back, keeping the type, or leaving the form | save: `AC2_an_affecting_change_with_nothing_confirmed_writes_nothing_and_returns_the_list`. four: `AC2_asking_without_confirming_saves_nothing_and_flags_nothing` (once per change). screen: `AC2_saves_nothing_while_the_list_is_on_screen`, `AC2_going_back_saves_nothing_and_keeps_what_was_typed`, `AC2_keeping_the_type_retires_nothing_and_closes_the_list`, `AC2_leaving_the_form_while_it_is_checking_never_goes_on_to_save`. screen (hook): `AC2_a_late_list_after_cancel_is_dropped`, `AC2_a_late_failure_after_cancel_shows_nothing`, `AC2_a_new_check_after_cancel_works_and_the_old_answer_cannot_overwrite_it`, `AC7_a_late_empty_answer_after_cancel_does_not_save` | Proved |
| AC2-05 | A confirmation that is not exactly the current list is refused and writes nothing: one missing, one extra, the wrong ones, made-up ids | save: `AC2_a_confirmed_list_missing_one_affected_reservation_is_refused`, `AC2_a_confirmed_list_with_an_extra_reservation_is_refused`, `AC2_a_confirmed_list_of_the_wrong_reservations_is_refused`, `AC2_made_up_ids_are_refused`. four: `AC4_a_confirmation_that_does_not_match_the_check_saves_nothing` | Proved |
| AC2-06 | The list moving after the preview is caught: a newer reservation, an older release that changes who is affected, a change to the type, a confirmed id that is still held but not affected, one from another type | save: `AC2_a_reservation_made_after_the_preview_makes_the_old_confirmation_stale`, `AC2_a_confirmed_id_that_is_still_held_and_not_affected_makes_the_confirmation_stale`, `AC2_a_confirmed_id_from_another_type_makes_the_confirmation_stale_even_if_it_has_ended`, `AC2_an_older_reservation_released_after_the_preview_changes_who_is_affected`, `AC2_a_change_to_the_type_after_the_preview_that_changes_the_list_is_caught`, `AC2_the_function_takes_the_row_lock_before_it_decides` | Proved |
| AC2-07 | Order and repeats in the confirmed list do not matter; after a refusal the returned list confirms and saves | save: `AC2_the_confirmed_order_and_repeats_do_not_matter`, `AC2_after_a_refusal_the_returned_list_confirms_and_saves`, `AC2_the_list_returned_is_the_one_the_preview_function_gives` | Proved |
| AC2-08 | The API answers a moved list with 409 and the new list, and the screen shows it with a notice and saves nothing more | route: `AC2_%s_answers_409_with_the_code_and_the_new_list`. svc: `AC2_%s_is_refused_with_409_and_the_new_list`, `AC2_a_refusal_with_an_empty_new_list_is_still_a_refusal`, `AC2_%s_does_not_return_a_type_when_refused`, `AC2_the_message_tells_the_staff_member_to_review_again`, `AC2_a_conflict_hint_becomes_the_conflicts_code`. screen: `AC2_a_refused_save_shows_the_new_list_with_a_notice_and_saves_nothing_more`, `AC2_the_server_text_of_the_refusal_is_never_shown`, `AC2_a_refused_damage_change_shows_the_new_list_and_confirms_it_with_the_same_note`, `AC2_a_refused_retirement_shows_the_new_list_and_confirms_it`, `AC2_a_refusal_does_not_refetch_the_catalogue` | Proved |
| AC2-09 | The confirmed list is validated: ids only, no repeats kept, at most 1000, a bad list reported once | valid: `AC2_accepts_a_list_of_reservation_ids_and_returns_it`, `AC2_accepts_an_empty_list_as_the_claim_that_nothing_is_affected`, `AC2_drops_repeats_so_a_list_that_names_one_reservation_twice_is_the_same_list`, `AC2_accepts_as_many_as_one_thousand`, `AC2_refuses_more_than_one_thousand`, `AC2_refuses_%s_in_place_of_a_list`, `AC2_refuses_a_list_holding_%s`, `AC2_reports_a_bad_list_once_whatever_else_is_wrong` | Proved |
| AC2-10 | A check that fails is never read as permission to save, and the form stays usable | screen: `AC2_a_failed_preview_on_an_edit_shows_a_message_and_leaves_the_form_usable`, `AC2_a_failed_preview_can_be_retried_and_then_continues_as_normal`, `AC2_a_preview_answer_of_%s_is_an_error_and_never_a_reason_to_save`, `AC2_a_failed_preview_on_a_retirement_shows_a_message_under_the_row_and_retires_nothing`, `AC2_a_blank_note_is_refused_before_the_preview`, `AC2_no_change_is_refused_before_the_preview`. fsvc: `AC2_has_a_message_for_a_failed_preview_that_says_nothing_was_saved` | Proved |
| AC2-11 | The calls: a POST to the preview path, never a PATCH or a GET, carrying the confirmed list through unchanged | fsvc: `AC2_previews_a_change_with_a_post_to_the_change_preview_path_and_returns_the_body`, `AC2_a_preview_never_uses_patch_or_a_get`, `AC2_retires_with_the_confirmed_reservations_in_the_body`, `AC2_an_edit_and_a_condition_change_carry_the_confirmed_list_through_unchanged` | Proved |
| AC2-12 | A reservation released or ended after the preview does not make the confirmation stale: the save goes ahead, flags only what is still short, and never flags a reservation that was not confirmed | save: `AC2_a_reservation_released_after_the_preview_is_not_flagged_and_the_save_goes_ahead`, `AC2_a_reservation_that_ends_after_the_preview_does_not_make_the_confirmation_stale` | Proved |

### AC3: first come, first served

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC3-01 | Of two overlapping reservations the older is kept; "oldest" means made first, not earliest in time; ties are broken by id | calc: `AC3_of_two_overlapping_reservations_the_older_is_kept`, `AC3_oldest_means_made_first_not_earliest_in_time`, `AC3_reservations_made_at_the_same_instant_are_ordered_by_id`. save: `AC3_the_newest_overlapping_reservation_loses_and_the_oldest_keep_their_equipment` | Proved |
| AC3-02 | Reservations that do not overlap are all kept, including one ending as another starts | calc: `AC3_reservations_that_do_not_overlap_are_all_kept`, `AC3_one_ending_as_another_starts_does_not_overlap_it`. save: `AC3_non_overlapping_reservations_are_all_kept` | Proved |
| AC3-03 | A chain of partly overlapping reservations is judged at each moment, so only the ones that do not fit lose | calc: `AC3_partly_overlapping_reservations_are_judged_at_each_moment`, `AC3_a_peak_inside_a_long_reservation_is_found`, `AC3_the_peak_is_the_most_held_at_once_not_the_sum_of_everything_that_touches`. save: `AC3_only_the_reservations_that_do_not_fit_are_flagged_in_a_chain_of_partial_overlaps` | Proved |
| AC3-04 | A reservation that is already flagged as unavailable still takes part, and is not flagged twice (the save reports only what it flagged) | calc: `AC3_a_flagged_reservation_still_takes_part_in_the_pass`. save: `AC3_a_reservation_already_flagged_as_unavailable_takes_part_and_is_not_flagged_twice` | Proved |
| AC3-05 | An affected reservation does not take up room for later ones; reservations held together add up and the one that tips it loses | calc: `AC3_an_affected_reservation_does_not_take_up_room_for_later_ones`, `AC3_reservations_held_together_add_up_and_the_one_that_tips_it_is_affected` | Proved |
| AC3-06 | The boundaries: a peak equal to the usable quantity fits, one unit below affects the newer, a larger one affects the one too big | calc: `AC3_a_peak_exactly_equal_to_the_usable_quantity_fits`, `AC3_one_unit_below_that_peak_affects_the_newer_reservation`, `AC3_a_usable_quantity_above_everything_held_affects_nothing`, `AC3_one_reservation_larger_than_the_usable_quantity_is_affected`, `AC3_everything_fits_when_the_usable_quantity_covers_the_peak`. save: `AC3_a_reservation_larger_than_everything_usable_is_affected_and_the_rest_stay` | Proved |
| AC3-07 | Units already damaged or in maintenance count against a new change; a retirement affects every held reservation | save: `AC3_units_already_under_maintenance_count_against_new_damage`, `AC3_new_maintenance_counts_against_units_already_damaged`, `AC3_retiring_affects_every_held_reservation_that_has_not_ended` | Proved |
| AC3-08 | The answer matches a brute-force count over random cases, for the check and for the save | calc: `AC3_seed_%i_matches_the_brute_force_answer_for_several_usable_quantities`. save: `AC3_seed_%i_flags_exactly_the_reservations_the_plain_rule_picks_and_nothing_else` | Proved |
| AC3-09 | The newer reservation is the one that loses, whichever of the four changes is made | four: `AC3_the_newer_reservation_is_the_one_that_loses_its_units` (once per change) | Proved |
| AC3-10 | After a moved list the screen confirms the new ids, not the old ones | screen: `AC3_confirming_the_new_list_sends_the_new_ids_and_not_the_old_ones`, `AC3_the_usable_figures_from_the_preview_stay_on_the_refreshed_list` | Proved |

### AC4: the change is saved and the reservations flagged together; requests return to Pending review

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC4-01 | Only Technical Support Staff may save; no caller, another role or no profile is refused (42501) and nothing changes | save: `AC4_a_null_caller_is_refused_with_42501_and_nothing_changes`, `AC4_a_%s_is_refused_with_42501_and_nothing_changes`, `AC4_a_coordinator_is_refused_%s_even_though_no_reservation_check_runs`, `AC4_a_caller_with_no_profile_or_a_made_up_one_is_refused_with_42501`, `AC4_the_client_roles_cannot_execute_the_new_functions_and_service_role_can`. route: `AC4_refuses_%s_from_%s_with_403_and_reads_and_saves_nothing`, `AC4_refuses_%s_when_signed_out_with_401`, `AC4_%s_made_by_a_coordinator_cannot_be_unlocked_with_a_role_in_the_body` | Proved |
| AC4-02 | A confirmed change saves the type, flags the listed reservations and returns their requests to Pending review, including a request under review | save: `AC4_a_confirmed_change_saves_the_type_flags_the_reservation_and_returns_its_request_to_pending_review`, `AC4_a_request_under_review_also_returns_to_pending_review`. four: `AC4_a_confirmed_save_changes_the_type_flags_the_listed_reservations_and_sends_their_requests_back` (once per change) | Proved |
| AC4-03 | A reservation is flagged, never released or cancelled, and keeps its quantity | save: `AC4_a_reservation_is_flagged_never_released_or_cancelled`, `AC4_the_saved_row_comes_back_in_the_answer_as_stored` | Proved |
| AC4-04 | All or nothing: a forced failure while flagging, or a name already taken, changes nothing | save: `AC4_a_forced_failure_while_flagging_changes_nothing`, `AC4_a_name_that_is_already_taken_fails_the_whole_save_and_flags_nothing`, `AC4_an_edit_of_the_name_and_a_smaller_total_save_together` | Proved |
| AC4-05 | Other types' reservations are never touched | save: `AC4_changes_to_one_type_never_touch_another_types_reservations` | Proved |
| AC4-06 | A retirement sets `retired_at`, keeps the quantities, refuses a second retirement (409), and a retired type can still have its quantities changed | save: `AC4_a_retirement_sets_retired_at_and_leaves_the_quantities`, `AC4_retiring_a_retired_type_is_a_PT409_with_its_hint_and_changes_nothing`, `AC4_a_retired_type_can_still_have_its_quantities_changed`, `AC4_retiring_a_type_with_no_usable_units_still_flags_the_reservations_it_holds`, `AC4_retiring_a_type_with_no_usable_units_leaves_a_reservation_already_flagged_as_unavailable_alone`, `AC4_retiring_a_type_whose_reservations_have_all_ended_saves_directly`. route: `AC4_a_409_for_a_retired_type_keeps_its_own_code`, `AC4_a_retirement_that_loses_a_race_to_another_retirement_is_a_409_with_that_code` | Proved |
| AC4-07 | The save refuses what makes no sense: no change, `retire: false` alone, retiring with other fields, a bad total, damaged plus maintenance above the total, a null confirmed list | save: `AC4_nothing_to_change_is_refused`, `AC4_retire_false_with_nothing_else_is_refused`, `AC4_retiring_together_with_%s_is_refused`, `AC4_damaged_plus_under_maintenance_above_the_total_is_refused`, `AC4_a_smaller_total_than_the_units_already_out_is_refused`, `AC4_a_null_confirmed_list_is_refused`, `AC4_a_confirmed_list_with_a_null_in_it_is_refused`, `AC4_fields_given_as_%s_are_refused`, `AC4_damaged_plus_under_maintenance_exactly_the_total_is_allowed`, `AC4_a_total_of_zero_is_allowed_when_nothing_is_out` | Proved |
| AC4-08 | The old silent trigger is gone; a change made outside the save (a seed script, the SQL editor) is still flagged by the backstop, newest first, and a change the save makes is flagged once; the other flagging triggers still work; the fixes migration can be run again | save: `AC4_the_trigger_and_its_function_no_longer_exist`, `AC4_a_change_the_save_makes_is_flagged_once_not_again_by_the_backstop`, `AC4_a_plain_update_that_lowers_the_usable_quantity_flags_the_newest_reservations`, `AC4_a_plain_retirement_flags_every_held_reservation_even_with_no_usable_units`, `AC7_a_plain_update_that_leaves_room_or_changes_only_the_name_flags_nothing`, `AC4_the_fixes_migration_can_be_run_again_and_the_save_still_works`, `AC4_the_other_flagging_triggers_still_work` | Proved |
| AC4-09 | An ordinary edit with fields saves them with the total or not at all; unknown keys are ignored | save: `AC4_only_the_fields_given_change_and_null_clears_a_field`, `AC4_unknown_keys_in_fields_are_ignored` | Proved |
| AC4-10 | The service sends the confirmed save with the right arguments and only the fields given, and the parameter names match the real function | svc: `AC4_a_total_edit_sends_only_the_fields_that_were_given`, `AC4_a_retirement_sends_retire_true_and_no_quantities`, `AC4_a_maintenance_change_sends_the_maintenance_figure`, `AC4_%s_sends_exactly_the_declared_parameter_names`, `AC4_the_migration_declares_nine_parameters`, `AC4_the_rpc_name_is_the_function_the_migration_creates`, `AC4_%s_makes_one_read_and_one_call_and_no_table_write` | Proved |
| AC4-11 | The API answers with the saved type and what was flagged, and each failure with its status | route: `AC4_a_total_edit_answers_200_with_the_type_and_what_was_flagged`, `AC4_a_damage_change_answers_200_with_the_new_usable_figure`, `AC4_a_retirement_answers_200_with_retired_at_and_what_was_flagged`, `AC4_%s_answers_404_for_an_unknown_type`, `AC4_%s_answers_400_when_the_database_refuses_the_input`, `AC4_%s_answers_500_without_the_database_message_when_the_function_fails`. svc: `AC4_returns_how_many_were_flagged_and_which`, `AC4_a_deadlock_asks_the_staff_member_to_try_again` | Proved |
| AC4-12 | The screen confirms exactly the reservations shown, once, with the reason | screen: `AC4_confirming_saves_the_total_with_exactly_the_reservations_shown`, `AC4_sends_the_reason_with_the_confirmed_total_change`, `AC4_confirming_a_damage_change_saves_it_with_the_note_and_the_list`, `AC4_confirming_a_retirement_sends_the_list_that_was_shown_and_refreshes`, `AC4_returns_to_a_refreshed_list_after_the_save`, `AC4_the_confirm_button_is_pressed_once_so_the_save_is_sent_once`, `AC4_pressing_confirm_twice_in_one_moment_saves_once` | Proved |
| AC4-13 | A save that fails keeps the list on screen with the message, and nothing is shown to someone who has left | screen: `AC4_a_failed_save_keeps_the_list_on_screen_with_the_message_and_allows_another_try`, `AC4_a_failed_damage_save_shows_the_conditions_message`, `AC4_going_back_after_a_failed_save_returns_to_the_form_with_nothing_saved`, `AC4_a_failed_retirement_after_the_list_stays_in_front_of_the_user`, `AC4_a_save_that_fails_after_the_user_left_shows_nothing_and_does_not_crash`, `AC4_a_save_already_on_its_way_still_refreshes_the_list_when_the_user_has_left` | Proved |

### AC5: the coordinator is notified (SCRUM-176) and the event record shows the affected lines

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC5-01 | The coordinator of each affected event gets one notice with the reason; a retirement names the retirement | save: `AC5_the_coordinator_of_each_affected_event_gets_one_notice_with_the_reason`, `AC5_a_retirement_names_the_retirement_as_the_reason` | Proved (depends on SCRUM-176's trigger) |
| AC5-02 | An unaffected event and a refused save notify nobody; a reservation already flagged as unavailable is not announced again, one flagged for another reason is announced | save: `AC5_an_unaffected_event_and_a_refused_save_notify_nobody`, `AC5_a_reservation_already_flagged_as_unavailable_is_not_announced_again`, `AC5_a_reservation_flagged_for_another_reason_is_announced_when_its_equipment_becomes_unavailable` | Proved |
| AC5-03 | The event's equipment answer lists each line's flagged reservations with quantity, period and reason, in start order | flags: `AC5_a_flagged_reservation_is_listed_with_its_quantity_period_and_reason`, `AC5_a_flag_with_no_reason_is_listed_with_a_null_reason`, `AC5_several_flags_on_one_line_are_listed_by_start_time`, `AC5_only_the_line_with_the_flag_shows_it` | Proved |
| AC5-04 | Nothing leaks: unflagged, released, another event's, another line's; a line with none has an empty list; the rest of the answer is unchanged | flags: `AC5_a_line_with_no_reservations_has_an_empty_flagged_list`, `AC5_a_reservation_that_is_not_flagged_is_not_listed`, `AC5_a_released_reservation_is_not_listed_even_if_it_was_flagged`, `AC5_flags_on_another_event_do_not_leak_into_this_one`, `AC5_a_newer_cancelled_request_does_not_hide_the_live_one_and_its_flags`, `AC5_an_event_with_no_equipment_request_still_answers_null`, `AC5_the_rest_of_the_answer_is_unchanged` | Proved |
| AC5-05 | A flag is labelled "equipment unavailable" only when it carries the `equipment_lost` code; the date-change flow's flags are labelled "flagged for review" | flags: `AC5_a_loss_flagged_through_the_confirmed_save_gets_the_equipment_lost_code`, `AC5_a_retirement_flags_with_the_equipment_lost_code_too`, `AC5_the_older_flag_function_used_by_the_date_change_flow_sets_no_code`, `AC5_a_code_can_be_asked_for_by_name`, `AC5_asking_for_no_code_gives_none`, `AC5_a_code_that_is_not_known_is_refused_and_nothing_is_flagged`, `AC5_the_old_three_argument_flag_function_is_gone_and_there_is_one_flag_by_function`. walk: `AC5_AC6_a_date_change_flag_is_on_the_list_but_is_not_called_equipment_lost`, `AC5_a_lost_equipment_flag_carries_its_code_to_the_event_record` | Proved |
| AC5-06 | Re-running the migration codes flags set before it, once, and changes nothing else | flags: `AC5_running_the_migration_again_codes_flags_set_before_it_by_their_reason_and_changes_nothing_else`, `AC5_a_flag_that_already_has_a_code_is_not_recoded_by_a_rerun` | Proved |
| AC5-07 | The API gives each line its flagged reservations in the camel-case shape, an empty list when none, and also on a write | svc: `AC5_a_line_carries_each_flagged_reservation_in_camel_case`, `AC5_the_order_the_database_gave_is_kept`, `AC5_a_flag_whose_code_is_%s_gives_a_null_code`, `AC5_a_flag_without_a_reason_or_a_time_gives_nulls`, `AC5_a_line_with_none_has_an_empty_list`, `AC5_when_the_answer_is_%s_the_line_has_an_empty_list`, `AC5_every_line_is_read_on_its_own`, `AC5_a_write_answers_with_the_flags_too` | Proved |
| AC5-08 | The coordinator's equipment section marks only the flagged line, says "equipment unavailable" with the reason and period, lists every flagged reservation, and does not stop the other lines' actions | coord: `AC5_the_line_says_equipment_was_lost_with_the_reason_and_the_period`, `AC5_only_the_flagged_line_is_marked`, `AC5_a_line_with_%s_is_not_marked`, `AC5_every_flagged_reservation_on_the_line_is_listed`, `AC5_the_marker_is_there_for_an_event_that_is_still_approved_too`, `AC5_a_flag_on_one_line_does_not_stop_the_other_lines_actions` | Proved |
| AC5-09 | Wording rules: a flag with no reason, a flag that is not about unavailable equipment, or a mixed line is called "flagged for review"; times are Singapore time; one unit is singular | coord: `AC5_a_flag_with_no_reason_says_it_was_flagged_for_review`, `AC5_a_flag_that_is_not_about_lost_equipment_is_called_flagged_for_review`, `AC5_a_line_with_a_lost_flag_and_another_flag_is_called_flagged_for_review`. fsvc: `AC5_several_lost_equipment_flags_are_all_called_equipment_lost`, `AC5_a_flag_whose_code_is_%s_is_called_flagged_for_review_not_equipment_lost`, `AC5_one_flag_for_something_else_among_lost_ones_means_the_line_is_not_called_equipment_lost`, `AC5_the_period_is_written_in_singapore_time`, `AC5_one_unit_is_singular`, `AC5_several_flags_are_totalled_and_kept_in_order`, `AC5_a_flag_with_a_%s_reason_gets_the_plain_wording`, `AC5_the_reason_is_trimmed` | Proved |
| AC5-10 | Bad data does not break the section: no dates, bad quantities, no id, junk entries | fsvc: `AC5_a_flag_with_no_dates_says_so_instead_of_throwing`, `AC5_%s_counts_as_zero_units`, `AC5_a_flag_without_an_id_gets_a_stable_key`, `AC5_entries_that_are_not_objects_are_skipped`, `AC5_%s_means_nothing_flagged`, `AC5_a_list_of_only_junk_means_nothing_flagged` | Proved |
| AC5-11 | A real loss shows on the line and the event stays as it was | flags: `AC5_a_real_equipment_loss_shows_on_the_line_and_the_event_stays_as_it_was`. walk: `AC5_AC6_lost_equipment_marks_the_line_and_puts_the_confirmed_event_on_the_list` | Proved |

### AC6: a Confirmed event stays Confirmed but "Needs attention"

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC6-01 | An event keeps its status, whatever it is, when its equipment is flagged; its equipment request goes to Pending review | save: `AC6_an_event_that_is_%s_keeps_that_status_when_its_equipment_is_flagged`. four: `AC6_a_confirmed_event_stays_confirmed_and_keeps_a_flagged_reservation_to_show` (once per change). walk: `AC6_the_event_stays_confirmed_through_the_loss` | Proved |
| AC6-02 | A Confirmed event with a flagged, unreleased equipment reservation needs attention, with the reason | svc: `AC6_a_confirmed_event_with_%s_needs_attention_%s`, `AC6_the_reason_the_flag_was_given_is_the_reason_shown`, `AC6_a_lost_equipment_flag_whose_reason_is_%s_still_says_equipment_lost` | Proved |
| AC6-03 | It does not need attention when nothing is flagged, the event is any other status, the reservation is released, or the flag is cleared | svc: `AC6_an_event_that_is_%s_does_not_need_attention_for_a_flagged_reservation`, `AC6_when_%s_a_confirmed_event_does_not_need_attention`, `AC6_a_released_flag_adds_no_reason`. walk: `AC6_a_confirmed_event_with_nothing_flagged_is_not_on_the_list`, `AC6_an_event_that_holds_none_of_the_lost_equipment_is_not_on_the_list`, `AC6_the_entry_goes_once_the_flagged_reservation_is_released`, `AC6_the_entry_stays_while_any_flagged_reservation_remains`, `AC6_a_flag_cleared_by_hand_takes_the_event_off_the_list` | Proved |
| AC6-04 | Reasons are worded by the flag's kind, trimmed, and not repeated; a venue flag and an equipment flag both appear | svc: `AC6_a_flag_whose_kind_is_%s_is_not_called_equipment_lost`, `AC6_an_other_flag_with_a_%s_reason_says_only_that_it_is_flagged`, `AC6_a_lost_flag_and_another_flag_with_the_same_reason_are_two_entries`, `AC6_the_reason_is_trimmed`, `AC6_two_flags_with_the_same_reason_are_one_entry`, `AC6_flags_with_different_reasons_are_each_listed_in_the_order_met`, `AC6_a_venue_flag_and_an_equipment_flag_are_both_given_as_reasons`, `AC6_a_venue_flag_alone_still_gives_its_reason_and_an_equipment_flag_alone_gives_only_its_own` | Proved |
| AC6-05 | Every read that carries the badge also reads the reservation flags; an event that needs none has an empty list, not a missing one | svc: `AC6_every_event_read_that_carries_needs_attention_embeds_the_reservation_flags`, `AC6_an_event_that_does_not_need_attention_has_an_empty_reasons_list_not_a_missing_one`, `AC6_an_embed_read_as_one_object_is_still_read`, `AC6_a_null_entry_in_the_embed_is_skipped` | Proved |
| AC6-06 | The flag's code is cleared with the flag, cannot sit on an unflagged reservation, and survives other updates | flags: `AC6_clearing_the_flag_clears_the_code`, `AC6_a_code_cannot_be_kept_on_a_reservation_that_is_not_flagged`, `AC6_a_flag_that_stays_set_keeps_its_code_through_other_updates`, `AC6_the_list_empties_when_the_flag_is_cleared`, `AC6_a_confirmed_event_keeps_its_status_and_shows_the_flag` | Proved |
| AC6-07 | The coordinator sees the reasons under the event and beside the badge on My events, and nothing when there are none | coord: `AC6_the_header_gives_the_reasons_under_the_event`, `AC6_no_reasons_are_shown_when_%s`, `AC6_a_row_shows_the_reason_beside_its_badge`, `AC6_only_the_rows_that_need_attention_show_reasons`, `AC6_a_badge_with_no_reasons_still_shows_the_badge_only`, `AC6_lists_every_reason_the_server_gave`, `AC6_shows_nothing_when_%s`, `AC6_two_equal_reasons_do_not_break_the_list`. fsvc: `AC6_gives_the_reasons_of_an_event_that_needs_attention`, `AC6_trims_each_reason`, `AC6_drops_blank_and_non_text_reasons`, `AC6_shows_nothing_when_%s` | Proved |
| AC6-08 | A reservation already flagged for another reason (the event's date changed) is flagged as unavailable when its equipment is lost: new reason and code, a new flag event with the user, the request back to Pending review, the coordinator told; the date-change flow never replaces an unavailable flag or an earlier flag | save: `AC6_a_reservation_flagged_for_another_reason_is_flagged_as_unavailable_when_its_equipment_is_lost`, `AC6_a_flag_for_another_reason_never_replaces_a_flag_for_unavailable_equipment`, `AC6_a_second_flag_for_another_reason_leaves_the_first_one_alone` | Proved |
| AC6-09 | An organiser sees the kind of flag on their event and never the staff note: the list and the single read give "Equipment unavailable" without the reason, other flags by kind, one line per kind, and the coordinator still gets the full reason | svc: `AC6_the_organiser_list_names_the_kind_of_flag_and_not_the_staff_note`, `AC6_the_organiser_single_read_names_the_kind_of_flag_and_not_the_staff_note`, `AC6_an_organiser_sees_other_flags_by_kind_too_and_the_venue_reason_unchanged`, `AC6_two_flags_of_one_kind_show_the_organiser_one_line`, `AC6_the_coordinator_still_gets_the_reason_with_the_note` | Proved |

### AC7: a change that affects nothing saves directly

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC7-01 | A type with no reservations, or damage that leaves enough units, saves with nothing flagged | save: `AC7_a_type_with_no_reservations_saves_a_smaller_total_with_nothing_flagged`, `AC7_damage_that_still_leaves_enough_units_saves_with_nothing_flagged`. four: `AC7_%s_that_leaves_room_for_every_reservation_saves_directly` | Proved |
| AC7-02 | The boundary: exactly enough units affects nothing; one unit below is not saved directly | save: `AC7_a_boundary_change_that_leaves_exactly_enough_units_affects_nothing`, `AC7_one_unit_below_the_boundary_is_not_saved_directly` | Proved |
| AC7-03 | Ended, released and other types' reservations do not block a direct save | save: `AC7_ended_and_released_reservations_do_not_block_a_direct_save`, `AC7_a_reservation_on_another_type_does_not_block_a_direct_save` | Proved |
| AC7-04 | Raising the usable quantity, or leaving it the same, is never flagged; a name-only edit needs no check | save: `AC7_raising_the_usable_quantity_is_never_checked_and_flags_nothing`, `AC7_a_change_that_keeps_the_usable_quantity_the_same_saves_directly`, `AC7_a_name_only_edit_saves_with_no_check_at_all`, `AC7_a_direct_save_still_refuses_a_confirmed_id_that_is_not_affected` | Proved |
| AC7-05 | The API reads "nothing affected" as zero flagged and an empty list, including a missing count | route: `AC7_a_retirement_needs_no_body_when_nothing_is_affected`, `AC7_answers_200_with_an_empty_list_when_no_one_is_affected`. svc: `AC7_a_save_that_affected_nothing_returns_zero_and_an_empty_list`, `AC7_reads_a_missing_count_as_zero_and_missing_affected_as_empty`, `AC7_names_the_type_and_reports_no_one_affected_for_an_empty_list` | Proved |
| AC7-06 | On the screen, a change that affects nothing saves at once with an empty list, with no list shown | screen: `AC7_a_total_with_no_reservations_affected_saves_at_once_with_an_empty_list`, `AC7_a_damage_change_with_no_reservations_affected_saves_at_once`, `AC7_raising_a_total_is_still_checked_and_saves_when_nothing_is_affected`, `AC7_a_retirement_with_no_reservations_affected_retires_after_the_existing_confirm_only` | Proved |
| AC7-07 | Edits that are not a lowering are not previewed: an edit that leaves the total alone, a reason for a non-total edit, a blank reason, creating a type | screen: `AC7_an_edit_that_leaves_the_total_alone_is_not_previewed`, `AC7_a_reason_typed_for_a_non_total_edit_is_not_sent`, `AC7_a_blank_reason_is_not_sent_with_a_total_change`, `AC7_creating_a_type_never_asks_which_reservations_it_affects`. fsvc: `AC7_an_empty_list_sums_to_zero`, `AC7_says_nothing_is_affected_for_an_empty_list_whatever_the_figures`, `AC7_zero_usable_after_is_a_figure_not_a_missing_one` | Proved |

### AC8: the change and each flag record the user, the date and time and the reason

| ID | Case | Implemented by | Result |
|---|---|---|---|
| AC8-01 | The history row names the user, the old and new value and the note; a retirement records `retired_at`; a combined change writes one row per field | save: `AC8_the_history_row_names_the_user_the_old_and_new_value_and_the_note`, `AC8_a_retirement_records_the_user_and_its_note`, `AC8_a_combined_change_writes_one_history_row_per_field_that_changed` | Proved |
| AC8-02 | Each flag records the user, the time and the reason (with the note); a retirement flag records the retirement reason | save: `AC8_each_flag_event_records_the_user_the_time_and_the_reason_with_the_note`, `AC8_a_retirement_flag_records_the_user_and_the_retirement_reason`, `AC8_without_a_note_the_flag_reason_is_the_plain_one` | Proved |
| AC8-03 | The same holds for each of the four changes | four: `AC8_the_change_and_each_flag_record_the_user_the_time_and_the_reason` (once per change) | Proved |
| AC8-04 | The note is optional on a total change, trimmed, and a blank one counts as none; damage and maintenance require one | save: `AC8_a_total_change_records_its_optional_note_and_one_without_a_note_records_none`, `AC8_a_blank_note_on_a_total_change_counts_as_no_note`, `AC8_the_note_is_trimmed_before_it_is_stored`, `AC8_a_damage_change_with_%s_is_refused`, `AC8_a_maintenance_change_with_%s_is_refused`. valid: `AC8_trims_the_note`, `AC8_leaves_the_note_out_when_none_is_sent`, `AC8_reads_a_%s_note_as_none`, `AC8_refuses_%s_as_a_note`, `AC8_does_not_count_a_note_alone_as_a_change`, `AC8_still_requires_a_note_on_a_damage_change` | Proved |
| AC8-05 | A refused save records nothing | save: `AC8_a_refused_save_records_nothing` | Proved |
| AC8-06 | The user is the signed-in one, never one named in the body; without a user the database refuses | route: `AC8_%s_uses_the_signed_in_user_whatever_the_body_says`, `AC1_the_acting_user_sent_to_the_database_is_the_signed_in_one`. svc: `AC8_%s_is_made_as_the_acting_user`, `AC8_without_an_acting_user_the_caller_is_null_and_the_database_refuses`, `AC1_the_caller_sent_is_the_one_passed_in_and_nothing_in_the_body_can_change_it` | Proved |
| AC8-07 | The flagging function records the user it is given; the older two-argument form records none, as before | save: `AC8_the_new_flagging_function_records_the_user_it_is_given`, `AC8_the_old_two_argument_flagging_still_records_no_user` | Proved |

---

## What cannot be tested as written

- **The notice in a real inbox.** AC5's notice is proved at the database (the row
  and its reason). Its wording in the inbox is SCRUM-176's, and a real account
  seeing it is a manual check on dev after deploy.
- **The new PostgREST embed.** The coordinator's `needsAttention` reads
  `equipment_reservations(...)` inside the event read. The tests run it against a
  PGlite stand-in for the Supabase client. Opening My events on dev after deploy
  is the check that the real embed returns the same shape.
- **Two people saving at once.** The row lock is proved structurally
  (`AC2_the_function_takes_the_row_lock_before_it_decides`) and the stale list is
  proved by simulating the second save. A true race against a live database is not
  run.

## Tally

| AC | Cases | Proved | Not implemented | Tests (titles) |
|---|---|---|---|---|
| AC1 | 12 | 12 | 0 | 91 |
| AC2 | 12 | 12 | 0 | 139 |
| AC3 | 10 | 10 | 0 | 29 |
| AC4 | 13 | 13 | 0 | 122 |
| AC5 | 11 | 11 | 0 | 64 |
| AC6 | 9 | 9 | 0 | 51 |
| AC7 | 7 | 7 | 0 | 30 |
| AC8 | 7 | 7 | 0 | 26 |
| **Total** | **81** | **81** | **0** | **552** |

Counts are test titles. A parameterised test is one title that runs once per value.
The full list is `docs/test-cases/SCRUM-310-test-ids.md`.
