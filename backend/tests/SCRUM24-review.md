# SCRUM-24 acceptance and merge review

Reviewed 19 October 2026 against Jira SCRUM-24 AC1-8, its six subtasks and the
repository's Week 7 rules. Branch: `SCRUM-24-view-event-information-attendee`,
HEAD `2a03d86`. Fetched `origin/dev` is `0fef506` and is already an ancestor.

**Verdict: not ready for full acceptance approval.** The protected read and UI
have local evidence for all eight criteria, but the real confirmation/change/
safety/re-confirmation integration remains blocked by unmerged SCRUM-363.
No hosted PostgREST or real-account browser verification was performed.

## Acceptance checklist and exact test IDs

Backend route IDs are in `routes/attendeeEvents.test.js`; SQL IDs are in
`db/attendeeEventDatabase.test.js`. Frontend IDs are in
`frontend/tests/auth/registeredEventsRoute.test.jsx` unless specified otherwise.
Parameterized IDs below name an executed case, not a separate test declaration.

| AC | Result | Supporting test IDs |
| --- | --- | --- |
| 1: registered Attendee only | PASS locally | `SCRUM24_AC1_reads_only_the_verified_attendees_own_active_registration`; `SCRUM24_AC1_unknown_and_inaccessible_events_have_the_same_safe_response`; `SCRUM24_AC1_ignores_forged_attendee_identity_and_role_in_query_and_body`; `SCRUM24_AC1_withdrawal_revokes_access_on_the_next_read` |
| 2: exact Confirmed visibility | PASS locally | `SCRUM24_AC2_AC3_non_confirmed_state_never_discloses_arrangements_approved`; `SCRUM24_AC2_AC3_SQL_non_confirmed_event_has_no_arrangements_approved` |
| 3: clear unconfirmed feedback | PASS locally | `SCRUM24_AC2_AC3_unavailable_contract_does_not_describe_cancelled_events_as_awaiting_confirmation` |
| 4: confirmed date | PASS locally | `SCRUM24_AC4_AC5_AC6_SQL_reads_current_times_and_multiple_confirmed_venues`; `SCRUM24_AC1_AC4_AC5_AC6_dashboard_reaches_protected_event_reads_without_a_flag` |
| 5: confirmed start/end | PASS locally | The AC4 IDs also assert Singapore start/end times and the next day's date for cross-midnight events. |
| 6: every confirmed venue | PASS locally | `SCRUM24_AC6_every_confirmed_venue_shows_its_stored_name_and_multiline_location`; `SCRUM24_AC6_SQL_holds_and_every_unconfirmed_booking_are_excluded`; `SCRUM24_AC6_missing_venue_details_are_handled_without_inventing_arrangements` |
| 7: latest confirmed arrangements | PASS for local reads; BLOCKED for lifecycle sign-off | `SCRUM24_AC7_SQL_change_hides_old_arrangements_and_reconfirmation_reads_latest`; `SCRUM24_AC2_AC3_AC7_mocked_confirmed_approved_reconfirmed_responses_replace_arrangements_authoritatively`; `SCRUM24_AC7_event_route_changes_clear_old_data_before_the_next_reply` |
| 8: exclude internal information | PASS locally | `SCRUM24_AC8_confirmed_response_uses_an_allowlist_including_nested_venues`; `SCRUM24_AC8_query_selects_exactly_the_columns_required_by_the_protected_read`; `SCRUM24_AC8_browse_list_and_preview_never_expose_protected_venues_registered_true` (`routes/openEvents.test.js`) |

Subtask mapping: AC1 -> SCRUM-49; AC2 -> SCRUM-52; AC3 -> SCRUM-51;
AC4/5 -> SCRUM-48/52; AC6 -> SCRUM-54; AC7 -> SCRUM-51/52; AC8 -> SCRUM-53.

The user confirmed that stored `venues.name` and `venues.location` satisfy AC6's
room/hall details where applicable. No separate room schema or inferred layout
name is required. Multiple venues, missing optional data and safe text rendering
are tested without exposing unsupported planning fields.

## Security and contract findings

- Express verifies the token/current profile role; the service rechecks the
  supplied verified identity. Only the caller's own `event_registrations` row
  with exact `registered` status grants access. Withdrawn, cancelled and
  waitlisted rows do not. Query/body identity and event-ID overrides are ignored.
- One nested read obtains registration, current event status, dates and
  bookings in one database snapshot. An explicit response allowlist excludes
  staff, supplier, equipment planning, other attendees and unconfirmed venues.
- Unknown and inaccessible valid event IDs return the same safe 404. Responses
  use no-store; missing schema fails closed with 503, other driver failures
  produce generic 500 responses. Public browse never returns protected venues.
- Registration closure, disabled settings, full capacity and past start time
  do not revoke access: `SCRUM24_AC1_SQL_closed_disabled_full_and_past_events_remain_readable`.
- Detail refresh hides previous arrangements immediately, including failed
  refreshes and revoked access. Route changes remount read state and late
  responses cannot replace another event's data.

No production defect requiring a code change was found in this review. No
generic status write, organiser-only endpoint reuse or frontend database read
was introduced. The branch diff contains only SCRUM-24 and direct integration
surfaces, with no dependency migration copies.

## Review changes and validation

- Removed SQL-suite skipping and the external migration-directory override.
  All prerequisite SQL must now come from this repository; missing files fail CI.
- Corrected the README's obsolete dependency/numbering claims and recorded the
  user's AC6 data-source decision. Added this acceptance evidence/checklist.
- Focused backend review: 280 tests passed across three suites using repository SQL.
- Full backend/frontend coverage, lint and build results will be recorded here
  after the review runs finish. No thresholds or timeouts are weakened.

PGlite executes actual prerequisite schemas and the protected query's SQL
equivalent. Its status-changing fixtures are visibility tests, not execution
of lifecycle RPCs. Frontend lifecycle sequences mock service responses. Neither
proves deployed PostgREST embedded relationship resolution or JWT authentication.

## Dependencies and manual deployment

1. SCRUM-494 (#68), SCRUM-22 (#70), safety statuses/review and SCRUM-395 (#74)
   are already on dev and included here. This branch adds or changes no SQL
   migrations; dev's highest active number is 097, so no SCRUM-24 number clash exists.
2. SCRUM-363 (#75) is not on dev: there is no `confirm_event_request` function
   in its migrations/services. Complete/approve that dependency first, merge
   it into dev, then refresh SCRUM-24 from dev and rerun the relevant checks.
   Do not copy its implementation or claim its acceptance criteria passed here.
3. Verify the target database's migration inventory. Apply only pending dev
   prerequisites in filename order, including registration 050, 068, 082,
   091, 092, 093 and 094, then the confirmation dependency's reviewed migrations
   after it merges. Preserve applied migrations and do not replay archived SQL.
   SCRUM-24 itself requires no new SQL command or configuration flag.
4. Deploy the matching protected API and frontend together after database
   prerequisites. Verify `event_registrations` relationships to `event_requests`
   and nested bookings/venues through real PostgREST. Reload its schema cache
   after schema changes when needed (`NOTIFY pgrst, 'reload schema';`, manual only).
5. With actual accounts: use Attendee -> Registered events -> event. Check
   401/403, unrelated/unknown events, withdrawn registration, multiple venues,
   Singapore dates and cross-midnight times. Closed/full/past-start events must
   stay readable while registered and confirmed.
6. Use the actual coordinator significant-change and safety/confirmation UI/API
   for Confirmed -> Approved -> Safety review -> Safety approved -> Confirmed.
   Return to the attendee page during planning, on refresh failure and after
   re-confirmation. Verify hidden old details, fresh venues/times and preserved
   registration. This essential integration check has NOT been executed.
7. SCRUM-402's organiser change-request processing is separate and remains
   unverified; the coordinator-path fixtures do not establish that workflow.

No live scripts, remote migrations, environment edits, commits, pushes, merges
or Jira changes were performed during this review.

## Proposed PR description

Adds protected registered-event navigation and current confirmed event
information for Attendees. Access uses the verified attendee's own active
registration, independent of registration availability. A single authorised
read returns only confirmed dates/times and approved venue names/locations;
planning data stays private. Refreshes hide stale arrangements and Singapore
formatting handles overnight events.

Uses the merged canonical registration schema; SCRUM-24 adds no migrations or
feature flag. Full lifecycle sign-off waits for SCRUM-363 and deployed
PostgREST/browser verification. See this review for exact test IDs and checks.
