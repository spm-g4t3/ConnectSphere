> This dated review predates the integration of origin/dev `7c2dd16`. SCRUM-395 is now included, and migration 100 resolves its interaction with confirmed-field protection. See [current merge evidence and deployment steps](SCRUM363-dev-merge.md). Notification AC9 remains a separate dependency.

# SCRUM-369: SCRUM-363 acceptance review

Reviewed 18 October 2026 against Jira SCRUM-363 AC1–9 and its Week 7 overrides.
Scope: SCRUM-364–368 and their readiness, safety, lifecycle, arrangement,
authentication and registration dependencies. Overall: **FAIL / incomplete**.

## Acceptance checklist

PASS below means local executable evidence and code review; it is not a deployed
Supabase or browser end-to-end sign-off. Real overlapping connections remain untested.

| AC | Result | Finding |
| --- | --- | --- |
| 1 | PASS locally | Express and SQL require the current assigned Event Coordinator; exact `safety_approved`. All other current statuses are refused and named. |
| 2 | PASS locally | Shared `event_readiness`: every live booking separately, approved/exact or wider coverage/unflagged; holds ignored; every non-cancelled equipment request Arranged; required dates and future database clock. Registration and technical support are not prerequisites. |
| 3 | PASS locally | One refusal includes all unmet conditions. Failed readiness, stale revision and history failures leave no partial writes. |
| 4 | PASS locally | Normal My events navigation exposes the shared checklist/action. Fresh parent records and tab-return refresh update the open detail. Errors, loading and repeated clicks are handled. |
| 5 | PASS locally | Non-whitespace equipment requirements without an active request require explicit acknowledgement, recorded in history. Missing or obsolete event revision cannot replay it. |
| 6 | PASS locally | One RPC locks event, bookings by ID FOR SHARE, equipment requests by ID FOR SHARE, then rechecks readiness and uses the existing transition/history function. Correct actor/time and one history row. |
| 7 | PASS locally | Owner-scoped read returns authoritative confirmed dates, all approved venues and arranged equipment quantities, formatted in Singapore time. Non-confirmed arrangements are hidden. |
| 8 | FAIL — dependency | Field locks include legacy change acceptance. Actual significant-change → Approved → new safety review → re-confirmation is absent here: SCRUM-395 is In Review (#74), SCRUM-402 is To Do. Direct reverts used in tests do not prove this workflow. |
| 9 | FAIL — dependency | SCRUM-175 is To Do. Neither confirmation RPC contains organiser/active-attendee confirmation notification delivery. Existing safety notices do not satisfy this AC. |

## Exact supporting test IDs

The database IDs below are in `db/scrum489SafetyReviewSubmissionDatabase.test.js`
unless a different file is named. Parameterized IDs below show an executed case.

- AC1:
  - `SCRUM363_AC1_reassignment_before_confirmation_is_revalidated`
  - `SCRUM363_AC1_current_status_approved_is_refused_and_named_without_writes`
  - `SCRUM363_AC1_database_role_authenticated_cannot_spoof_confirmation_or_write_status_directly`
  - `SCRUM363_AC1_authentication_is_required_before_database_access` (`routes/scrum489SafetyReviewRoutes.test.js`).
- AC2:
  - `SCRUM363_AC2_multiple_approved_venues_can_confirm_only_while_each_still_covers_the_period`
  - `SCRUM363_AC2_holds_do_not_replace_a_booking_cancelled_after_safety_approval`
  - `SCRUM363_AC2_every_active_equipment_request_must_be_arranged_and_cancelled_requests_are_ignored`
  - `SCRUM363_AC2_rechecks_current_time_instead_of_the_start_of_a_longer_transaction`
  - `SCRUM363_AC2_an_actual_reservation_flag_after_safety_approval_blocks_confirmation_without_releasing_equipment` (`db/scrum489EquipmentArrangedDatabase.test.js`).
  - `SCRUM363_AC2_confirmation_does_not_open_registration_until_independent_settings_allow_it`.
  - `SCRUM363_AC2_actual_registration_settings_workflow_is_independent_of_confirmation`.
- AC3:
  - `SCRUM363_AC3_all_current_booking_equipment_and_date_failures_are_returned_together`
  - `SCRUM363_AC3_lists_all_outstanding_items_and_refreshes_after_stale_readiness` (`frontend/tests/components/EventConfirmationPanel.test.jsx`).
- AC4:
  - `SCRUM363_AC4_lists_all_conditions_in_a_read_only_transaction_without_changing_arrangements_or_history`
  - `SCRUM363_AC4_shows_every_server_condition_and_refuses_outstanding_readiness` (`frontend/tests/components/EventConfirmationPanel.test.jsx`).
  - `SCRUM363_AC4_returning_to_my_events_refreshes_the_open_detail_and_reveals_fresh_safety_approval` (`frontend/tests/components/scrum489CoordinatorSafetyCheck.test.jsx`).
- AC5:
  - `SCRUM363_AC5_safety_submission_acknowledgement_is_not_reused_and_explicit_confirmation_is_recorded`
  - `SCRUM363_AC5_acknowledgement_without_an_observed_revision_cannot_confirm`
  - `SCRUM363_AC5_an_old_acknowledgement_revision_is_refused_after_a_new_safety_cycle`
  - `SCRUM363_AC5_a_new_event_revision_clears_the_checkbox_and_rechecks_without_replaying_acknowledgement` (`frontend/tests/components/EventConfirmationPanel.test.jsx`).
- AC6:
  - `SCRUM363_AC6_a_safety_approved_event_is_confirmed_with_its_coordinator_and_timestamp_in_history`
  - `SCRUM363_AC6_HTTP_confirmation_uses_the_real_SQL_transaction_and_returns_safe_repeated_and_not_ready_responses`
  - `SCRUM363_AC6_queued_repeated_confirmations_write_one_history_row`
  - `SCRUM363_AC6_a_history_write_failure_rolls_back_the_status_and_all_other_state`
  - `SCRUM363_AC6_fresh_planning_data_replaces_local_confirmation_and_clears_stale_success_feedback` (`frontend/tests/components/scrum489CoordinatorSafetyCheck.test.jsx`).
- AC7:
  - `SCRUM363_AC7_the_owner_reads_actual_confirmed_booking_and_reserved_equipment_records_and_planning_hides_them` (`db/scrum489EquipmentArrangedDatabase.test.js`).
  - `SCRUM363_AC7_other_organisers_cannot_gain_access_by_supplying_an_event_id_or_owner_query` (`routes/confirmedArrangements.test.js`).
  - `SCRUM363_AC7_cross_midnight_dates_use_Singapore_time_on_both_ends` (`frontend/tests/components/ConfirmedArrangements.test.jsx`).
  - `SCRUM363_AC7_significant_change_hides_old_confirmation_and_reconfirmation_fetches_latest_arrangements` (same frontend file; mocked lifecycle data only).
- AC8 partial evidence:
  - `SCRUM363_AC8_confirmed_fields_are_locked_on_the_organiser_patch_endpoint`
  - `SCRUM363_AC8_legacy_change_acceptance_cannot_edit_confirmed_fields_and_rolls_back_the_decision`
  - `SCRUM363_AC8_confirmed_proposed_start_is_locked_even_for_a_trusted_table_writer`
  - **TODO:** `SCRUM363_AC8_actual_significant_change_to_Approved_safety_review_and_reconfirmation_requires_SCRUM395_and_SCRUM402`.
- AC9 has no passing notification evidence:
  - **TODO:** `SCRUM363_AC9_organiser_confirmation_notification_requires_SCRUM175`
  - **TODO:** `SCRUM363_AC9_reconfirmation_notifies_only_active_registered_attendees_requires_SCRUM175`.

## Changes and security findings

- The coordinator confirmation test now stubs both unrelated booking panels,
  matching its existing component-isolation pattern. This removes real booking
  reads and the unrelated session-error alert without weakening refusal assertions.
- The organiser notification-navigation test waits for the scroll effect before
  checking its call count. It retains the exact once-only and target-row assertions.
- Active migrations are now `098_event_readiness_details.sql` followed by
  `099_confirmation_revision.sql`, above dev's latest 097. Original 085, 086 and
  087 SQL is preserved unchanged under `db/migration-history/scrum363/` and must
  not be deployed again. SQL tests cover an old three-argument RPC upgrade and
  fresh installation without that obsolete signature.
- After merging SCRUM-22, the confirmation SQL suite loads the actual registration
  migrations 050, 068, 082 and 091-094. It uses canonical `event_registrations`,
  the current structured RPC outcomes and the real enabled-window constraint.
  The former registration-settings TODO now executes the organiser's setup RPC
  and verifies that confirmation preserves settings/history and closing preserves
  registrations. It does not claim deployed UI or Supabase verification.
- New `db/migrations/099_confirmation_revision.sql` retains the existing atomic
  confirmation implementation, removes the old three-argument overload and adds
  `p_expected_updated_at`. Acknowledgements require the reviewed event revision;
  supplied stale revisions are refused under the event lock. No existing migration changed.
- The same migration adds a narrow event-field trigger: ordinary field updates
  cannot leave changed details in Confirmed. The existing legacy change-request
  transaction now rolls back its decision too. Registration settings and metadata
  remain editable. SCRUM-395/402 must still supply the real revert/flags/history workflow.
- `src/routes/eventRequests.js`, `src/services/eventRequestService.js` and the
  frontend service carry the revision without dropping PostgreSQL microseconds.
  `src/services/eventChangeRequestService.js` maps the field-lock SQLSTATE to 409.
- `frontend/src/components/EventConfirmationPanel.jsx` binds readiness,
  acknowledgement and refusal state to the event revision and ignores obsolete
  submission responses. `CoordinatorRequestDetail.jsx` no longer masks refreshed
  server data with an older local response or shows stale success after reverting.
  `MyAssignedEvents.jsx` refreshes the open detail as well as its list.
- Regression changes: the two SQL suites above, `routes/scrum489SafetyReviewRoutes.test.js`,
  `services/confirmEventRequest.test.js`, the two frontend confirmation suites above,
  `frontend/tests/services/scrum489EventRequestService.test.js`, and the manual race
  script's migration prerequisite. Shared readiness and organiser reads were retained.
- No generic status-changing HTTP endpoint was found. The generic transition
  helper is invoker security; client roles cannot use it to bypass deny-all RLS.
  A trusted `service_role`/database owner can write tables by design and must stay server-side.

## Executed local verification

- Latest full backend coverage run after SCRUM-22 integration: **7,579 passed,
  3 TODO across 175 suites**, with all coverage gates passing (`--maxWorkers=2`).
  The previously failing SQL suite passes independently: **135 passed, 3 TODO**.
- Earlier frontend evidence: **259 passed**, 9 focused suites. All three SCRUM-363 component coverage
  gates pass at **100% lines, branches, functions and statements**.
- The two previously failing frontend suites also pass together: **72 passed**.
- Full frontend lint: **0 errors, 24 existing warnings**. Production build passed
  with the existing bundle-size warning. `git diff --check` clean.
- Regression tests first reproduced replay, stale parent state and the legacy
  confirmed-field bypass, then passed with the fixes.

Backend command (inside `backend/`):

```powershell
npm.cmd run test:coverage -- --maxWorkers=2 --reporter=dot
npx.cmd vitest run tests/db/scrum489SafetyReviewSubmissionDatabase.test.js tests/db/scrum489EquipmentArrangedDatabase.test.js tests/db/scrum489EquipmentLockDatabase.test.js tests/db/bookingDecisionsAfterSafetyReviewDatabase.test.js tests/routes/scrum489SafetyReviewRoutes.test.js tests/routes/confirmedArrangements.test.js tests/services/confirmEventRequest.test.js tests/services/scrum489SafetyReviewSubmission.test.js tests/middleware/requireAuth.test.js tests/middleware/requireRole.test.js --maxWorkers=2 --reporter=dot
npx.cmd vitest run tests/domain/eventRequestStatus.test.js tests/domain/userRole.test.js --maxWorkers=2 --reporter=dot
```

Frontend command (inside `frontend/`):

```powershell
npx.cmd vitest run tests/components/EventConfirmationPanel.test.jsx tests/components/scrum489CoordinatorSafetyCheck.test.jsx tests/components/scrum489SafetyCheckSubmissionPanel.test.jsx tests/components/ConfirmedArrangements.test.jsx tests/components/MyEventRequests.test.jsx tests/services/scrum489EventRequestService.test.js tests/components/CoordinatorRequestDetail.test.jsx tests/components/CoordinatorRequestDetailEquipment.test.jsx tests/components/MyAssignedEvents.test.jsx --coverage --coverage.include=src/components/EventConfirmationPanel.jsx --coverage.include=src/components/ReadinessChecklist.jsx --coverage.include=src/components/ConfirmedArrangements.jsx --coverage.reportsDirectory=coverage/scrum363 --maxWorkers=2 --reporter=dot
```

PGlite executes real SQL with local fixtures. The main suite constructs its
notification table and hold fixture and loads SCRUM-494/22's actual registration
schema and functions, without hand-added settings columns. Its HTTP adapter executes SQL but does not exercise live PostgREST or
Supabase JWT verification. Organiser SQL-adapter tests do not verify deployed
PostgREST relationship discovery. Queued PGlite promises are not concurrent connections.

## Manual deployment and end-to-end checks — NOT executed

1. `git fetch origin dev` was executed before allocating 098 and 099; origin/dev
   is `cd0ee4b`, highest migration 097. Pending #68 uses 091; #74 uses 095/096.
   Recheck numbering if dev advances.
   Verify the deployment's migration ledger and existing SCRUM-489/318/safety and
   arrangement prerequisites. Apply only pending migrations; never rewrite/reapply
   older definitions over newer ones or deploy `db/migration-history/` snapshots.
2. Apply 098 then 099 manually in one transaction through the project's migration
   process or paste both complete files between BEGIN and COMMIT in the Supabase
   SQL editor. Fresh installations do not need archived 085-087; existing installs
   keep their data and history. For a configured disposable
   PostgreSQL connection, from repository root:

   ```powershell
   psql -X -v ON_ERROR_STOP=1 --single-transaction -f backend/db/migrations/098_event_readiness_details.sql -f backend/db/migrations/099_confirmation_revision.sql
   ```

   The file notifies PostgREST to reload its schema. Verify one four-argument
   confirmation overload, invoker security and service-role-only execution:

   ```sql
   select oid::regprocedure, prosecdef from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'confirm_event_request';
   select has_function_privilege('authenticated',
     'public.confirm_event_request(uuid,uuid,boolean,timestamptz)', 'execute'); -- false
   ```

3. Deploy migration first, then the matching backend and frontend. An older
   acknowledgement-only client is deliberately refused until refreshed/upgraded;
   a new backend against the old RPC signature cannot work. Confirmation itself
   has no feature flag. Do not expose the service-role key to the browser.
4. With real accounts, navigate Coordinator → My events → Open. Use future dates,
   every approved covering booking and arranged equipment, complete actual safety
   submission/approval, then confirm. Test unassigned/other roles, every refusal,
   explicit acknowledgement, double click, lost network response and safe refresh.
   Verify status, actor/time/reason and exactly one confirmation history row.
5. As the owner, open My event requests → Confirmed arrangements. Verify all venue
   names/locations, actual equipment quantities and Singapore dates. A different
   organiser's ID request must return 404. Verify deployed embedded reads, API
   permissions, authentication failures and safe database-error responses.
6. Run `db/confirmationConcurrency.manual.sql` in two real PostgreSQL sessions
   against disposable fixtures: flag-first, confirm-first, repeated confirmation,
   rollback, start passing during a booking lock wait, and actual equipment flagging
   in both orders. No local PostgreSQL/psql/docker executable was available; none ran.
7. After SCRUM-395/402 exists, use its actual UI/API to change a Confirmed event;
   verify all affected arrangements flagged, no releases/deletions, Approved status,
   stale safety review closed, fresh safety approval, new acknowledgement and re-confirm.
   Do not substitute direct status SQL for this check.
   Migration 100 now moves to Approved before editing locked fields in the same
   transaction. Apply it after 096 and 099, preserving the direct-edit guard.
8. After SCRUM-175 exists, verify transactional organiser notification and, on
   re-confirmation, only active registered attendees; repeat/failure must not duplicate
   notifications or deliver any partial success. AC9 remains failed until then.
9. Registration requires SCRUM-494's real schema/settings workflow and the SCRUM-22
   RPCs, plus `open_event_registration_state` (068) for browsing. No enabling occurs
   during confirmation. Once those dependencies are deployed, independently enable
   registration within its window and verify SCRUM-22 availability/registration.
   Browse has no feature flag; deploy its SQL prerequisites before the API/UI.

Remaining external dependencies: SCRUM-395, SCRUM-402, SCRUM-175 and deployment of
SCRUM-494. No remote database, live script, environment file, commit, push, merge
or Jira modification was performed.
