# SCRUM-24 acceptance and merge review

Reviewed 20 October 2026 against Jira SCRUM-24 AC1-8 and the Week 7 rules.
Branch `SCRUM-24-view-event-information-attendee`, refreshed from `origin/dev`
at `429c8e8`, which includes SCRUM-363 (#75) and migrations 098-102.

**Verdict: ready to merge into dev.** All eight criteria have passing tests,
including AC7 through the real change-request, safety-review and confirmation
functions. Deployed PostgREST and real-account browser checks remain manual
(see Deployment).

## Acceptance checklist

Route IDs are in `routes/attendeeEvents.test.js`, SQL IDs in
`db/attendeeEventDatabase.test.js`, frontend IDs in
`frontend/tests/auth/registeredEventsRoute.test.jsx` unless stated.

| AC | Result | Supporting test IDs |
| --- | --- | --- |
| 1: registered Attendee only | PASS | `SCRUM24_AC1_reads_only_the_verified_attendees_own_active_registration`; `SCRUM24_AC1_unknown_and_inaccessible_events_have_the_same_safe_response`; `SCRUM24_AC1_ignores_forged_attendee_identity_and_role_in_query_and_body`; `SCRUM24_AC1_withdrawal_revokes_access_on_the_next_read`; `SCRUM24_AC1_SQL_inactive_registration_never_grants_access_*` |
| 2: only Confirmed is visible | PASS | `SCRUM24_AC2_AC3_non_confirmed_state_never_discloses_arrangements_*`; `SCRUM24_AC2_AC3_SQL_non_confirmed_event_has_no_arrangements_*` |
| 3: clear unconfirmed feedback | PASS | `SCRUM24_AC2_AC3_unavailable_contract_does_not_describe_cancelled_events_as_awaiting_confirmation` |
| 4: confirmed date | PASS | `SCRUM24_AC4_AC5_AC6_SQL_reads_current_times_and_multiple_confirmed_venues`; `SCRUM24_AC1_AC4_AC5_AC6_*_reaches_protected_event_reads_without_a_flag` |
| 5: confirmed start/end | PASS | As AC4, plus Singapore times and the next day's date for overnight events |
| 6: every confirmed venue | PASS | `SCRUM24_AC6_every_confirmed_venue_shows_its_stored_name_and_multiline_location`; `SCRUM24_AC6_SQL_holds_and_every_unconfirmed_booking_are_excluded`; `SCRUM24_AC6_missing_venue_details_are_handled_without_inventing_arrangements` |
| 7: latest confirmed arrangements | PASS | `SCRUM24_AC7_attendee_read_follows_change_request_safety_review_and_reconfirmation` (`db/scrum489EquipmentArrangedDatabase.test.js`); `SCRUM24_AC7_SQL_change_hides_old_arrangements_and_reconfirmation_reads_latest`; `SCRUM24_AC2_AC3_AC7_mocked_confirmed_approved_reconfirmed_responses_replace_arrangements_authoritatively`; `SCRUM24_AC7_event_route_changes_clear_old_data_before_the_next_reply` |
| 8: no internal information | PASS | `SCRUM24_AC8_confirmed_response_uses_an_allowlist_including_nested_venues`; `SCRUM24_AC8_query_selects_exactly_the_columns_required_by_the_protected_read`; `SCRUM24_AC8_SQL_response_never_exposes_planning_or_staffing`; `SCRUM24_AC8_browse_list_and_preview_never_expose_protected_venues_registered_*` (`routes/openEvents.test.js`) |

AC6 uses the stored `venues.name` and `venues.location` for room/hall details,
as the user confirmed; there is no separate room schema.

The AC7 lifecycle test drives a confirmed, registered event through an
organiser's start-time change request (approved via 102's
`process_change_request`, which returns it to Approved), booking reinstatement,
an equipment move, safety review and `confirm_event_request`. The attendee read
is `unavailable` at every intermediate step and shows the new start and venue
once reconfirmed; the registration is untouched.

## Review changes

- Added the real-lifecycle AC7 test above. The PGlite stand-in for the
  PostgREST read moved to `tests/fixtures/attendeeEventSqlClient.js` so both
  database suites check the same columns and joins.
- Condensed the README section to the contract and deployment facts; removed
  review history that had gone stale after SCRUM-363 merged.

## Validation

- Backend `npm run test:coverage`: 179 files, 7,747 passed, 2 AC9 TODOs
  (SCRUM-363, waiting on SCRUM-175), thresholds met.
- Frontend `npm run test:coverage`: 3,629 of 3,631 passed. The two failures
  differ between runs (SCRUM-493 flow timeout, SCRUM-178, ClarificationHistory),
  touch no SCRUM-24 file and pass when rerun alone; the suite is flaky under
  load. No coverage threshold failed. Lint: 0 errors. Build: passes.

## Follow-ups resolved on this branch

- **Event name.** Both responses now carry `eventName`, which the
  registered-events list already showed in every state, and the page heading
  uses it. A reply for another event, or a blank name, falls back to "Event
  information". `SCRUM24_AC4_the_page_is_headed_by_the_event_name_when_*`;
  `SCRUM24_AC8_the_heading_falls_back_for_*`; `SCRUM24_AC2_AC3_unavailable_response_names_the_event_and_nothing_else`.
- **Flagged venues.** Every writer flags only an approved booking, and a flag
  leaves the venue held until Venue Staff or the Coordinator resolve it. A
  flagged booking on a confirmed event is therefore listed with
  `underReview: true` and the note "This venue is being reviewed and may
  change." The flag and review reasons stay private.
  `SCRUM24_AC6_a_flagged_venue_stays_listed_as_under_review_without_its_reason`;
  `SCRUM24_AC6_SQL_a_flagged_booking_on_a_confirmed_event_is_listed_as_under_review`;
  `SCRUM24_AC6_a_venue_under_review_stays_listed_with_a_neutral_note`.

## Deployment

1. SCRUM-24 adds no migrations. Apply pending dev migrations in filename
   order, including registration 050-094 and 101, and SCRUM-363's 098-102.
2. Deploy the API and frontend together. On the deployed API, check that
   `event_registrations` embeds `event_requests` and nested `bookings`/`venues`;
   reload the PostgREST schema cache after schema changes if needed.
3. With real accounts: Attendee -> Registered events -> event. Check 401/403,
   unknown and unrelated events, a withdrawn registration, multiple venues,
   Singapore and overnight times, and that a significant change hides the
   details until reconfirmation.
