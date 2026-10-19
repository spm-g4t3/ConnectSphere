# SCRUM-369: SCRUM-363 acceptance review

Reviewed 19 October 2026 against Jira AC1-9, its Week 7 description/comment,
and the E3 rules in docs/requirements.md. Compared with fetched origin/dev
0fef506; dev is already an ancestor of this branch (da37843).

**Verdict: NOT READY for acceptance approval. AC9 is unimplemented.**
PASS below means local code/fixture evidence, not deployed Supabase verification.
Real overlapping PostgreSQL connections and browser end-to-end checks remain unexecuted.

| AC | Result | Verified behaviour |
| --- | --- | --- |
| 1 | PASS locally | Verified-token caller, exact Event Coordinator role and current assignment; only safety_approved, naming every other status on refusal. |
| 2 | PASS locally | Shared read-only readiness checks every relevant booking separately, approved covering periods without flags; holds excluded; all active equipment Arranged; required dates and future database clock. |
| 3 | PASS locally | All outstanding conditions returned together; readiness/history failures roll back without partial success. |
| 4 | PASS locally | Normal assigned-event navigation exposes the shared checklist and confirmation; loading, stale reads, access errors and repeat clicks handled. |
| 5 | PASS locally | Explicit no-equipment acknowledgement when original text is nonblank and no active request exists; revision-bound and recorded in history. |
| 6 | PASS locally | One backend-only invoker RPC locks event, then bookings and equipment requests in ID order; rechecks readiness after waiting; existing transition records coordinator/time once. Real connection races still require execution. |
| 7 | PASS locally | Owner-scoped current confirmed arrangements, every approved venue and arranged equipment quantities, Singapore times; hidden during planning/refresh. |
| 8 | PASS locally | Actual significant-change RPC returns Confirmed to Approved, preserves field locks, flags arrangements and requires their resolution plus fresh safety review before re-confirmation. Legacy direct acceptance is safely refused. |
| 9 | FAIL / blocker | SCRUM-175 remains To Do. No transactional organiser confirmation notification or active-attendee re-confirmation notification exists. Significant-change and safety notices do not satisfy this AC. |

## Exact supporting test IDs

Unless noted, backend SQL IDs are in db/scrum489SafetyReviewSubmissionDatabase.test.js.

- AC1: SCRUM363_AC1_reassignment_before_confirmation_is_revalidated;
  SCRUM363_AC1_current_status_approved_is_refused_and_named_without_writes
  (parameterised suite covers every non-safety_approved status);
  SCRUM363_AC1_database_role_authenticated_cannot_spoof_confirmation_or_write_status_directly.
- AC2: SCRUM363_AC2_multiple_approved_venues_can_confirm_only_while_each_still_covers_the_period;
  SCRUM363_AC2_holds_do_not_replace_a_booking_cancelled_after_safety_approval;
  SCRUM363_AC2_every_active_equipment_request_must_be_arranged_and_cancelled_requests_are_ignored;
  SCRUM363_AC2_rechecks_current_time_instead_of_the_start_of_a_longer_transaction.
- AC3: SCRUM363_AC3_all_current_booking_equipment_and_date_failures_are_returned_together.
- AC4: SCRUM363_AC4_lists_all_conditions_in_a_read_only_transaction_without_changing_arrangements_or_history;
  SCRUM363_AC4_shows_every_server_condition_and_refuses_outstanding_readiness
  (frontend/tests/components/EventConfirmationPanel.test.jsx);
  SCRUM363_AC4_returning_to_my_events_refreshes_the_open_detail_and_reveals_fresh_safety_approval
  (frontend/tests/components/scrum489CoordinatorSafetyCheck.test.jsx).
- AC5: SCRUM363_AC5_safety_submission_acknowledgement_is_not_reused_and_explicit_confirmation_is_recorded;
  SCRUM363_AC5_an_old_acknowledgement_revision_is_refused_after_a_new_safety_cycle;
  SCRUM363_AC5_requires_explicit_acknowledgement_and_server_recheck_in_both_directions
  (frontend/tests/components/EventConfirmationPanel.test.jsx).
- AC6: SCRUM363_AC6_a_safety_approved_event_is_confirmed_with_its_coordinator_and_timestamp_in_history;
  SCRUM363_AC6_HTTP_confirmation_uses_the_real_SQL_transaction_and_returns_safe_repeated_and_not_ready_responses;
  SCRUM363_AC6_queued_repeated_confirmations_write_one_history_row;
  SCRUM363_AC6_a_history_write_failure_rolls_back_the_status_and_all_other_state.
- AC7: SCRUM363_AC7_the_owner_reads_actual_confirmed_booking_and_reserved_equipment_records_and_planning_hides_them
  (db/scrum489EquipmentArrangedDatabase.test.js);
  SCRUM363_AC7_other_organisers_cannot_gain_access_by_supplying_an_event_id_or_owner_query
  (routes/confirmedArrangements.test.js);
  SCRUM363_AC7_cross_midnight_dates_use_Singapore_time_on_both_ends;
  SCRUM363_AC7_significant_change_hides_old_confirmation_and_reconfirmation_fetches_latest_arrangements
  (frontend/tests/components/ConfirmedArrangements.test.jsx; mocked lifecycle evidence).
- AC8: SCRUM363_AC8_actual_significant_change_preserves_field_locks_and_reconfirms_after_fresh_safety_review;
  SCRUM363_AC8_flagged_arrangements_require_real_resolution_and_fresh_safety_approval_before_reconfirmation;
  SCRUM363_AC8_a_failed_significant_change_rolls_back_the_early_transition_and_all_history
  (db/scrum489EquipmentArrangedDatabase.test.js);
  SCRUM363_AC8_legacy_change_acceptance_cannot_edit_confirmed_fields_and_rolls_back_the_decision.
- AC9: two explicit TODOs, no passing notification evidence:
  SCRUM363_AC9_organiser_confirmation_notification_requires_SCRUM175;
  SCRUM363_AC9_reconfirmation_notifies_only_active_registered_attendees_requires_SCRUM175.
- Registration integration: SCRUM363_AC2_actual_registration_settings_workflow_is_independent_of_confirmation;
  SCRUM363_AC6_confirmation_preserves_bookings_equipment_registrations_and_registration_settings.

## Changes in this review

- Extended the existing SQL integration suite with actual hold, venue-decision,
  booking-resolution and flag-reason migrations. A fresh venue avoids unrelated
  fixture clashes when executing the real occupancy checks.
- Added the flagged-arrangement lifecycle test above. It calls the real
  significant-change, equipment-flag, venue reinstatement, equipment review,
  safety submission/response and confirmation functions. Equipment flags are
  raised explicitly through the existing equipment function, not inferred from
  an equipment-change declaration. Reservations and quantities remain intact.
- Removed the obsolete AC8 TODO now covered by executable lifecycle tests.
- No production code or applied migration changed; no notification substitute added.

## Verification

- Backend full coverage: **7,622 passed, 2 AC9 TODOs, 178 suites**; all gates passed.
- Frontend full coverage: **3,573 passed, 153 suites**; all gates passed.
- Focused frontend: **220 passed**; updated SQL equipment/lifecycle suite: **8 passed**.
- Frontend lint: **0 errors, 24 existing warnings**; production build passed
  with the existing bundle-size warning. Git whitespace checks passed.

Exact CI commands are recorded in SCRUM363-dev-merge.md. No tests, timeouts or
coverage thresholds were weakened. Existing React warning output in the full
frontend run did not fail any test or coverage gate.

PGlite executes SQL with local fixtures, including a fixture auth/notification
schema. SQL-to-HTTP adapters do not prove real JWT/PostgREST or embedded relationship
discovery. Queued PGlite calls are not independent PostgreSQL connections.

## Dependencies and manual deployment

1. Dev 0fef506 already includes SCRUM-489/488/490, SCRUM-494 (#68), SCRUM-22 (#70),
   SCRUM-395 (#74) and equipment notification dependencies. No merge conflict or
   copied dependency implementation was introduced in this review.
2. Verify the target migration ledger; apply only missing prerequisites in their
   repository sequence, then 098_event_readiness_details.sql,
   099_confirmation_revision.sql and 100_significant_change_confirmation_compatibility.sql.
   Dev currently ends at 097; these numbers are unique and above it. Do not execute
   db/migration-history/scrum363 snapshots or replay already-applied SQL.
3. After prerequisites, a configured staging connection can apply the pending files:

   ```powershell
   psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/098_event_readiness_details.sql -f backend/db/migrations/099_confirmation_revision.sql -f backend/db/migrations/100_significant_change_confirmation_compatibility.sql
   ```

4. Deploy matching backend/frontend after SQL. No confirmation feature flag is
   required. Verify one four-argument confirm_event_request overload, invoker
   security, no anon/authenticated EXECUTE and service_role execution. Keep the
   service key server-side. Confirm must not enable independent registration settings.
5. Run db/confirmationConcurrency.manual.sql using two real PostgreSQL sessions
   and disposable ready fixtures: booking flag first/confirm first, equipment
   flag first/confirm first, double confirmation, rollback and start passing during
   lock waits. NOT executed: psql, postgres and docker are unavailable locally.
6. With actual accounts, use Coordinator -> My events -> Open -> Confirm Event;
   verify owner arrangements, denial to other users, stale acknowledgement,
   significant change -> flagged arrangement resolution -> new safety approval ->
   re-confirmation, preserved registrations/settings and independent registration.
   Deployed browser/PostgREST checks have NOT been run.
7. SCRUM-175 must supply transactional organiser and active-attendee confirmation
   notifications with repeat/rollback/privacy coverage before AC9 can pass.
   SCRUM-402 remains To Do for organiser change-request processing; this review
   proves the coordinator's significant-change path and safe refusal of legacy
   confirmed-field edits, not SCRUM-402 acceptance behaviour.

No remote SQL/live scripts, environment edits, commits, pushes, merges or Jira
modifications were performed. Existing SCRUM-22 edits remain in the original worktree.
