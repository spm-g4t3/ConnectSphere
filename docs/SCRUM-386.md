# SCRUM-386: Review against the acceptance criteria

Part of SCRUM-379. Each acceptance criterion with the tests that cover it, then what is still waiting on other stories.

Counts are test definitions in the source; a test written with `it.each` runs once per case, so the run count is higher. Every test name starts with `SCRUM379_AC<n>_`, so `npx vitest run -t SCRUM379_AC5_` runs one criterion on its own.

Paths below are under `backend/tests/` or `frontend/tests/`.

## AC1: only the assigned coordinator, only a Confirmed event, only after it ended

Built in: `complete_event_request` (migration 034), `POST /api/event-requests/:id/complete`, the Mark as completed panel.

- `db/scrum379CompleteEventDatabase.test.js` (22): `SCRUM379_AC1_the_assigned_coordinator_completes_a_confirmed_event_after_its_end`, `..._a_coordinator_who_is_not_assigned_is_refused_and_nothing_changes`, `..._a_%s_event_is_refused_with_a_message_naming_its_status` (every other status), `..._an_event_that_ends_in_one_minute_is_refused_with_a_message_about_the_end_time`, `..._an_event_ending_exactly_at_the_current_time_can_be_completed`, `..._one_second_after_the_clock_is_refused_and_one_second_before_is_accepted`, `..._the_boundary_holds_to_the_microsecond`, `..._an_event_with_no_end_time_cannot_be_completed`, end times written in five UTC offsets, four session time zones, `..._client_roles_cannot_call_the_function_but_the_api_role_can`.
- `routes/scrum379CompleteEventRoutes.test.js` (8): the caller comes from the token, 401 signed out, 403 for the organiser, attendee, technical support, venue staff and the Lead, 403 and 409 mapping from the database, the database's reason kept in the message.
- Frontend: `components/scrum379EventCompletionPanel.test.jsx` (17), `components/scrum379CoordinatorCompletion.test.jsx` (15), `services/scrum379EventCompletion.test.js` (23), `services/scrum379EventRequestService.test.js` (2).

## AC2: optional closing notes, visible to coordinators only

- `db/scrum379CompleteEventDatabase.test.js` (13): optional, trimmed, blank stored as null, line breaks kept, exactly 2000 characters accepted and 2001 refused, emoji counted as characters, the database rejects notes on a row that is not Completed, migration 033 runs twice.
- `db/scrum379CoordinatorReadsClosingNotesDatabase.test.js` (10): the coordinator reads return the notes; the organiser reads do not, on the real schema.
- `routes/scrum379CoordinatorReadsClosingNotesRoutes.test.js` (17): `GET /mine` and `GET /:id/review` return `closingNotes` to coordinators and the Lead; five other roles get 403 with no database call; nothing an organiser reads selects or returns them.
- `routes/scrum379CompleteEventRoutes.test.js` (9): notes optional, trimmed, blank sent as null, 2000 characters.
- Frontend: `components/scrum379CoordinatorCompletion.test.jsx` (14), `components/scrum379EventCompletionPanel.test.jsx` (15), `services/scrum379EventCompletion.test.js` (8), `services/scrum379EventRequestService.test.js` (4).

## AC3: final and read-only

- `domain/scrum379FinalEvent.test.js` (12): which statuses are final, and that nothing leads out of Completed.
- `middleware/scrum379FinalEventGuard.test.js` (25): the guard itself (409 `EVENT_FINAL`, the message, malformed ids, a read failure).
- `routes/scrum379FinalEventRoutes.test.js` (8): every guarded route family answers 409 for a Completed event and never reaches the service.
- `routes/scrum379FinalEventCoverage.test.js` (7): walks every router and fails if any route that changes an event is neither guarded nor listed as exempt with a reason; the guarded list is exactly the 46 documented endpoints. This is what catches a new endpoint added later.
- `db/scrum379CompleteEventDatabase.test.js` (3): a Completed event cannot be cancelled or completed again.
- Frontend: the panel and the coordinator screen show no edit actions once Completed (`components/scrum379EventCompletionPanel.test.jsx`, `components/scrum379CoordinatorCompletion.test.jsx`, 2 each), and `services/scrum379EventCompletion.test.js` (2).
- `frontend/tests/components/MyEventRequests.test.jsx` (2, found in the manual test): the organiser's list no longer offers "Request a change" on a Completed event; the server already refused it, the button was just still shown. Confirmed and Approved events still offer it.
- Not covered by the guard, by design: `register_for_event` already refuses any event that is not Confirmed, so registration closes without a write (AC4 test below).

## AC4: the same action releases equipment, closes change requests, closes registration, keeps the venue booking

- `db/scrum379CompleteEventDatabase.test.js` (15): live reservations released with the reason "event completed", several lines each released once, a reservation released earlier keeps its own reason, another event's reservations and change requests untouched, outstanding and in-progress change requests closed with the outcome `event_completed`, an already processed one keeps its outcome, `..._the_venue_booking_is_kept_as_a_history_record`, `..._registration_is_closed_because_a_completed_event_is_not_confirmed`, `..._a_forced_failure_rolls_everything_back`, row lock taken before the status is read, migration 034 runs twice.
- `routes/scrum379CompleteEventRoutes.test.js` (1): a second completion is a 409, not a 500.

## AC5: every record stays viewable by the organiser and coordinators

- `db/scrum379CompletedEventReadsDatabase.test.js` (15, new in 385): one event with a booking, reserved equipment, a clarification entry, a past decision and a change request is read before and after completion, and the two are compared. Covers the event details, the venue booking, the arranged equipment, the dates, the clarification history, the decision history (organiser, coordinator and Lead), the change history and the status history, plus that another organiser and a coordinator who is not assigned are still refused.
- `routes/confirmedArrangements.test.js` (4, new in 385): a Completed event still returns its venue and equipment to its own organiser, still hides unconfirmed bookings and unarranged or removed equipment, and carries no closing notes.
- `routes/scrum379FinalEventRoutes.test.js` (1) and `routes/scrum379FinalEventCoverage.test.js` (1): reads are never guarded, so a Completed event can be read through every read route.
- Frontend: `components/ConfirmedArrangements.test.jsx` (5) and `components/MyEventRequests.test.jsx` (1): a Completed event shows its arrangements under "Arrangements of the completed event" and is not described as currently confirmed.
- Found while writing these: the organiser's arrangements read returned nothing once the event was Completed. Fixed in `getConfirmedArrangementsForOrganiser` and the two screens; one older test (SCRUM363) that expected an empty answer for Completed was changed to expect the arrangements.

## AC6: coordinator and time recorded; the organiser sees Completed

- `db/scrum379CompleteEventDatabase.test.js` (1): `SCRUM379_AC6_the_status_history_records_the_coordinator_and_the_time`.
- `db/scrum379CompletedEventReadsDatabase.test.js` (5, new in 385): the last history row goes from Confirmed to Completed with the label "Completed" for the organiser, names the coordinator, has a date and time and is the latest row, exactly one such row is stored, and the closing notes never appear in what the organiser reads.

## AC7: the Needs attention list

- `domain/scrum379CoordinatorAttentionList.test.js` (27): the rules, wording and ordering with no database.
- `db/scrum379NeedsAttentionDatabase.test.js` (60): every source on the real schema, one second either side of each boundary, an event with several reasons, other coordinators' events, and items going away once resolved (completing, cancelling, approving the booking, arranging the equipment, releasing the flagged reservation).
- `routes/scrum379NeedsAttentionRoutes.test.js` (19): shape, scoping to the token, empty list, 401 and 403, no leaked database message.
- Frontend: `components/scrum379CoordinatorAttentionList.test.jsx` (23), `components/scrum379CoordinatorDashboardAttention.test.jsx` (9), `services/scrum379EventRequestService.test.js` (3).

## Dependencies on other stories

No criterion is blocked. Each source below is built and tested against what exists in the schema today.

- **SCRUM-162 (clarification):** stores the reply-by date and no overdue flag. The list works out "overdue" from the date (a Singapore date, overdue from the first second of the next day). If SCRUM-162 later adds a flag, replace `clarificationIsOverdue` in `backend/src/domain/coordinatorAttentionList.js`. Tests: `..._a_clarification_past_its_reply_by_date_is_listed_with_the_date` and the Singapore day boundary pair.
- **N24 (a venue block flags a booking):** the `flagged_for_review` booking status exists, and a real block override produces it (`db/createBookingRequestMigration.test.js`, SCRUM-256). The list reads the stored status and shows "Venue booking flagged for review". The Needs attention tests write the flagged booking directly; they do not run a block override end to end.
- **N25 (equipment reservation flags):** `flag_equipment_reservations` exists (baseline 06) and sets the flag for a retired type, fewer usable units and a changed event date. The list reads the stored flag and shows "Equipment flagged for review" or "Equipment unavailable", and the item clears when the reservation is released. The Needs attention tests write the flagged reservation directly; `db/scrum489EquipmentArrangedDatabase.test.js` runs the real flag function.
- **N15 (release of equipment on completion):** the release exists. The trigger `event_requests_release_equipment_on_completed` (baseline 06) releases the live reservations with the reason "event completed" in the same transaction, and `complete_event_request` relies on it. The AC4 tests prove it.
- **SCRUM-363 (readiness):** `event_readiness` supplies the venue and equipment items for Confirmed events.

## Open questions for Calven

1. Who sees the closing notes: built as every coordinator and the Lead, never an organiser.
2. Events in the safety check (`safety_review`, `safety_approved`) whose end has passed are not on the list, because AC7 names Approved only.
3. "Visible to coordinators only" is built as each coordinator seeing the events assigned to them.
4. The status history read is open to the organiser and the assigned coordinator only (SCRUM-322, unchanged), while the clarification history is open to every coordinator. AC5 says "organiser and coordinators", so say if another coordinator or the Lead should read the status history too.
5. Resolved in manual testing: a change request closed as `event_completed` read "Rejected" on the coordinator's page. Both screens now share `changeRequestOutcomeLabel` and say "Closed, event completed" (tests in `services/scrum379ChangeRequestOutcome.test.js`, `scrum379CoordinatorCompletion.test.jsx`, `scrum347RejectApprovedEvent.test.jsx`).
