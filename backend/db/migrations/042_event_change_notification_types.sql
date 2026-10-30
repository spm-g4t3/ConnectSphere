-- Migration 042: notification types for a confirmed event's changes.
-- Confirmation, a change request's decision and a venue change each get a
-- type of their own; event_cancelled gains an attendee audience in its payload.

-- The whole list, restated from 037_event_waiting_list.sql with the new types.
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
    'event_details_changed',
    'event_rejected',
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
    'venue_hold_expiring',
    'registration_promoted',
    'event_confirmed',
    'change_request_decided',
    'event_venue_changed'
  ]));

-- Each is about one event; without it the notice cannot name or link it.
alter table notifications drop constraint if exists notifications_event_confirmed_needs_event;
alter table notifications
  add constraint notifications_event_confirmed_needs_event
  check ((type <> 'event_confirmed') or (event_request_id is not null));

alter table notifications drop constraint if exists notifications_change_request_decided_needs_event;
alter table notifications
  add constraint notifications_change_request_decided_needs_event
  check ((type <> 'change_request_decided') or (event_request_id is not null));

alter table notifications drop constraint if exists notifications_event_venue_changed_needs_event;
alter table notifications
  add constraint notifications_event_venue_changed_needs_event
  check ((type <> 'event_venue_changed') or (event_request_id is not null));
