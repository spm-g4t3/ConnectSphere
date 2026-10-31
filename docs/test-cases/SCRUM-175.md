# SCRUM-175 — Test Cases

**Story:** Notify users of confirmation, changes and cancellation — all relevant users
**Schema:** `042_event_change_notification_types.sql`
**Status:** every case proved except AC5, which SCRUM-402 delivers (31 October 2026). The review is `docs/SCRUM-175.md`.

> As an Event Organiser, registered Attendee or relevant staff member, I want to be
> notified when confirmed event arrangements change so that I have the latest
> information.

1. **AC1:** The Event Organiser is notified when the event becomes confirmed.
2. **AC2:** Registered Attendees are notified when an event they registered for
   becomes confirmed, where applicable.
3. **AC3:** The Event Organiser and registered Attendees are notified when the
   confirmed date, time or venue changes.
4. **AC4:** Relevant affected staff are notified when a confirmed arrangement
   relevant to their responsibilities changes.
5. **AC5:** The Event Organiser is notified when their significant change request
   is accepted or declined.
6. **AC6:** Affected users are notified when an event is rescheduled, postponed or
   cancelled.
7. **AC7:** The notification identifies the event and nature of the change without
   exposing information the recipient is not authorised to view.

## Layers

| Short | File |
|---|---|
| pglite | `backend/tests/db/scrum175EventChangeNoticesDatabase.test.js` (real Postgres, baseline plus every migration) |
| types | `backend/tests/db/scrum175NotificationTypesDatabase.test.js` |
| 395 | `backend/tests/db/significantEventChangeDatabase.test.js` (SCRUM-395, unmodified) |
| display | `frontend/tests/services/scrum175NotificationDisplay.test.js` |

## Rules the cases depend on

- **"Re-confirmation"** means the event has an earlier `confirmed` row in its status
  history (a significant change sent it back to Approved). The tests write that row
  directly. On a first confirmation nobody can be registered (D4).
- **Attendee audiences.** Confirmation and venue change go to `registered` only;
  cancellation goes to `registered` and `waitlisted`. `withdrawn` and `cancelled`
  registrations hear nothing.
- **"No reason"** means the attendee payload has no `reason` key and no copy of the
  coordinator's reason text anywhere in it. The organiser's notice still carries it.
- **Postponed** has no status of its own: a postponement is a date change, so AC6's
  "rescheduled, postponed" is the date-change cases.

`%s` names are `it.each`; the variants are in brackets.

## Cases

| ID | AC | Layer | Test | Defect caught |
|---|---|---|---|---|
| AC1-01 | AC1 | pglite | `SCRUM175_AC1_the_organiser_is_told_the_event_is_confirmed_with_its_venues` | Organiser not told, or told the wrong period or venues |
| AC1-02 (trap) | AC1 | pglite | `SCRUM175_AC1_a_cancelled_booking_is_not_listed_as_a_venue` | A cancelled booking listed as a venue |
| AC1-03 | AC1 | display | `SCRUM175_AC1_organiser_is_told_the_event_is_confirmed_with_its_period_and_venues`, `…_falls_back_to_unnamed_event`, `…_without_a_venues_array_names_only_the_period` | Wording missing event, period or venues; crash on a sparse payload |
| AC2-01 | AC2 | pglite | `SCRUM175_AC2_registered_attendees_are_told_of_a_reconfirmation` | Withdrawn or cancelled registrants told; attendee payload carries organiser-only booking data |
| AC2-02 | AC2 | pglite | `SCRUM175_AC2_attendees_promoted_by_the_reconfirmation_are_told_too` (new) | Attendee list read before the status change, so those 037's trigger promotes miss it (D4) |
| AC2-03 (trap) | AC2 | pglite | `SCRUM175_AC2_a_first_confirmation_tells_attendees_nothing` | Attendees told of a first confirmation |
| AC2-04 | AC2 | display | `SCRUM175_AC2_attendee_is_told_an_event_they_registered_for_is_confirmed`, `…_a_reconfirmation_says_it_was_reconfirmed_after_a_change`, two sparse-payload cases | Wording does not say confirmed or reconfirmed |
| AC3-01 | AC3 | pglite | `SCRUM175_AC3_registered_attendees_are_told_the_new_and_previous_venue` | Attendees not told of a new venue; waitlisted or withdrawn told |
| AC3-02 (trap) | AC3 | pglite | `SCRUM175_AC3_a_replacement_at_the_same_venue_tells_attendees_nothing` | Venue notice for a new period at the same venue |
| AC3-03 (trap) | AC3 | pglite | `SCRUM175_AC3_a_replacement_before_reconfirmation_tells_attendees_nothing` (new) | Venue notice while the event is back at Approved; they learn the venues on re-confirmation (D3) |
| AC3-04 (trap) | AC3 | pglite | `SCRUM175_AC3_cancelling_a_flagged_booking_tells_attendees_nothing` | Venue notice with no new venue |
| AC3-05 | AC3 | display | `SCRUM175_AC3_attendee_is_told_the_new_and_previous_venue`, `…_venue_change_without_the_previous_venue_says_unknown_venue` | Wording missing either venue |
| AC3-06 | AC3, AC4, AC6 | 395 | `SCRUM395_AC4_applies_the_previewed_fields_flags_arrangements_and_records_history` | On a confirmed event's date change: organiser, both registered attendees and Venue Staff (`booking_flagged_event_change`) not told |
| AC4-01 | AC4, AC6 | 395 | `SCRUM395_AC9_lists_pending_venue_requests_leaves_them_open_and_tells_venue_staff`, `SCRUM395_AC9_tells_technical_support_once_and_sends_the_coordinator_no_equipment_flag` | Venue Staff not told of pending requests, or Technical Support not told, when a confirmed event moves |
| AC6-01 | AC6 | pglite | `SCRUM175_AC6_registered_and_waitlisted_attendees_get_the_attendee_message` | Waitlisted not told; message not trimmed; wrong cancellation time |
| AC6-02 | AC6 | pglite | `SCRUM175_AC6_a_blank_attendee_message_is_sent_as_null` | A blank message sent as text |
| AC6-03 | AC6 | display | `SCRUM175_AC6_attendee_is_told_the_event_was_cancelled_with_the_coordinators_message`, `…_cancellation_without_a_message_says_nothing_more` | Wording missing the message, or an empty "Message:" line |
| AC7-01 (trap) | AC7 | pglite | `SCRUM175_AC7_attendee_cancellation_payloads_carry_no_reason` | Internal reason in an attendee cancellation |
| AC7-02 (trap) | AC7 | pglite | `SCRUM175_AC7_a_date_change_tells_attendees_without_the_reason` | Internal reason in `event_significant_change_attendee` (D6) |
| AC7-03 (trap) | AC7 | display | `SCRUM175_AC7_attendee_cancellation_never_shows_the_internal_reason`, `…_an_attendee_change_notice_never_shows_a_reason`, `…_attendee_confirmation_does_not_show_organiser_only_booking_data` | A reason or booking data shown from an older or malformed row |
| AC7-04 | AC7 | display | `SCRUM175_AC7_%s_with_%s_audience_is_generic` (event_confirmed with venue_staff or no audience, event_venue_changed with organiser) | An unexpected audience shown attendee or organiser wording |
| AC7-05 | AC7 | display | `SCRUM175_AC7_attendee_%s_opens_the_attendee_event_page`, `…_attendee_event_cancelled_opens_nothing`, `…_organiser_event_confirmed_opens_their_list_focused_on_the_event` | A notice opening a page its reader cannot see |
| T-01 | AC7 | types | `SCRUM175_AC7_%s_inserts_when_it_names_its_event`, `…_is_refused_without_an_event` (event_confirmed, event_venue_changed) | A notice that cannot name its event |
| T-02 | AC7 | types | `SCRUM175_AC7_an_unknown_type_is_still_refused`, `…_the_widened_list_keeps_037s_types_and_adds_each_new_type_once`, `SCRUM175_AC7_existing_type_%s_still_inserts` (4 types) | Widening drops or duplicates a type |
| T-03 | D2 | types | `SCRUM175_AC7_rerunning_042_keeps_a_type_another_migration_added` | Re-running 042 drops a type another branch added |
| AC5 | AC5 | — | None here. SCRUM-402 (PR #95) sends `change_request_decided` and tests it (D1) | — |

## Regression: the other callers of the restated functions

042 restates four functions. Their suites run unmodified and pass, except one
filter noted below:

| Function | Suites |
|---|---|
| `confirm_event_request` | `scrum489SafetyReviewSubmissionDatabase` (its snapshot now ignores `event_confirmed`), `scrum489EquipmentArrangedDatabase`, `scrum379CompletedEventReadsDatabase`, `services/confirmEventRequest`, `routes/scrum489SafetyReviewRoutes` |
| `cancel_event_request` | `cancelEventRequestDatabase` (includes Venue Staff and Technical Support notices), `cancelEventReleasesReservationsDatabase`, `scrum539LeadCancelDatabase`, `scrum561SafetyCancelNotificationDatabase`, `scrum571FreedVenuesDatabase`, `scrum347RejectApprovedEventDatabase`, `cancelConflictingBookingRequestDatabase`, `bookingDecisionsAfterSafetyReviewDatabase`, `scrum379CompleteEventDatabase`, `services/eventCancellationService` |
| `notify_flagged_booking_resolved` | `cancelFlaggedBookingDatabase`, `replaceFlaggedBookingDatabase`, `reinstateFlaggedBookingDatabase`, `flaggedBookingWalkthrough`, `scrum492ReleaseVenueBookingDatabase` |
| `apply_significant_event_change` | `significantEventChangeDatabase`, `eventRegistrationDatabase`, `registrationSchemaIntegrationDatabase`, `scrum387EditEventDetailsDatabase`, `scrum489EquipmentArrangedDatabase` |

In `frontend/tests/services/notificationDisplay.test.js`, SCRUM-395's attendee
case now expects no reason (D6), and the type-list reader understands 042's
widening.

## Teeth checks (each reverted; 042 byte-identical afterwards)

| Break in 042 | Fails |
|---|---|
| Organiser `event_confirmed` insert writes nothing | 4: AC1-01, AC1-02, AC2-01, AC2-03 (the last two also check the organiser's notice) |
| Reconfirmed attendee insert skipped (`if false`) | 2: AC2-01, AC2-02 |
| Attendee insert moved before the status change | 1: AC2-02 |
| Venue change: drop `rb.venue_id <> b.venue_id` | 1: AC3-02 |
| Venue change: drop the confirmed-only condition | 1: AC3-03 |
| Cancel: `registered` only | 2: AC6-01, AC7-01 |
| Cancel: no attendee insert | 3: AC6-01, AC6-02, AC7-01 |
| Cancel: `reason` added to the attendee payload | 2: AC6-01, AC7-01 |
| Date change: `reason` added back to the attendee payload | 1: AC7-02 |
