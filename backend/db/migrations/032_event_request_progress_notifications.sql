-- Migration 032: tell the organiser and the coordinator how an event request is progressing.
-- Four new notification types. Field names mirror booking_request_approved/rejected and
-- venue_hold_expired, so the frontend reads them the same way.
--
-- Payloads:
-- - event_request_approved / event_request_rejected (to the organiser):
--   { eventRequestId, eventName, decidedAt, decidedById, decidedByName, reason }
--   reason is the decision note: optional on approval, always set on rejection
--   (decide_event_request requires it). A rejection is not final; the organiser may
--   change the request and resubmit it.
-- - venue_hold_placed (to the assigned coordinator):
--   { eventRequestId, eventName, venueId, venueName, expiresAt, placedById, placedByName }
-- - venue_hold_expiring (to the assigned coordinator):
--   { eventRequestId, eventName, venueId, venueName, expiresAt }, the shape of venue_hold_expired.
--
-- Re-runnable.

-- The whole list, restated from 016_overnight_operating_hours.sql with the new types.
alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (type = any (array[
    'booking_flagged',
    'booking_request_withdrawn',
    'clarification_requested',
    'clarification_replied',
    'clarification_closed',
    'booking_flagged_setup_change',
    'venue_hold_expired',
    'event_cancelled',
    'event_request_awaiting_assignment',
    'event_request_assigned',
    'event_request_coordinator_assigned',
    'safety_review_response',
    'safety_booking_flagged',
    'safety_equipment_review',
    'event_submitted_for_safety_review',
    'booking_request_approved',
    'booking_request_rejected',
    'booking_request_conflicting',
    'flagged_booking_resolved',
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired',
    'booking_released',
    'booking_request_conflict_cleared',
    'equipment_requested',
    'equipment_request_changed',
    'equipment_request_cancelled',
    'equipment_arranged',
    'equipment_not_fully_arranged',
    'equipment_flagged',
    'registration_schedule_conflict',
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change',
    'booking_flagged_hours_change',
    'event_request_approved',
    'event_request_rejected',
    'venue_hold_placed',
    'venue_hold_expiring'
  ]));

alter table notifications drop constraint if exists notifications_event_decision_needs_event;
alter table notifications
  add constraint notifications_event_decision_needs_event
  check ((type <> all (array['event_request_approved', 'event_request_rejected'])) or (event_request_id is not null));

alter table notifications drop constraint if exists notifications_hold_notice_needs_hold;
alter table notifications
  add constraint notifications_hold_notice_needs_hold
  check ((type <> all (array['venue_hold_placed', 'venue_hold_expiring'])) or (venue_hold_id is not null));

-- A hold gets one expiry reminder, however often the reminder job runs.
create unique index if not exists notifications_one_reminder_per_hold
  on notifications (venue_hold_id) where (type = 'venue_hold_expiring');
