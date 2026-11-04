-- Migration 024: the assigned coordinator rejects an Approved event whose essential
-- arrangements cannot be met (SCRUM-347). The approval moves into 012's decision
-- history, the rejection becomes the current decision, and the event's
-- arrangements are released, all in one call. Decision history rows become immutable.

-- History is a record: rows are written once and never changed or removed.

create or replace function refuse_event_request_decision_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'decision history entries cannot be changed or deleted'
    using errcode = '42501';
end;
$$;

drop trigger if exists event_request_decision_history_immutable on event_request_decision_history;
create trigger event_request_decision_history_immutable
  before delete or update on event_request_decision_history
  for each row
  execute function refuse_event_request_decision_history_mutation();

alter table event_request_decision_history
  drop constraint if exists event_request_decision_history_superseded_reason_known;
alter table event_request_decision_history
  add constraint event_request_decision_history_superseded_reason_known
  check (superseded_reason = any (array['reopened_for_revision'::text, 'rejected_after_approval'::text]));

-- Notifications: 016's list, SCRUM-387's event_details_changed (its 022 is on live
-- ahead of dev, and live already holds such rows), and event_rejected.

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
    'event_details_changed',
    'event_rejected'
  ]));

-- Venue Staff are told once per released booking, so theirs must name it.
alter table notifications drop constraint if exists notifications_event_rejected_needs_refs;
alter table notifications
  add constraint notifications_event_rejected_needs_refs check (
    type <> 'event_rejected'
    or (event_request_id is not null
        and (payload ->> 'audience' is distinct from 'venue_staff' or booking_id is not null))
  );

create or replace function reject_approved_event(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_reason           text
)
returns event_requests
language plpgsql
as $$
declare
  v_request     event_requests;
  v_rejected    event_requests;
  -- btrim alone keeps tabs and line breaks, so a reason of only those would pass.
  v_reason      text := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_booking_ids uuid[];
  v_equipment_ids uuid[];
begin
  if p_event_request_id is null then
    raise exception 'An event request is required' using errcode = '22023';
  end if;

  perform assert_caller_role(
    p_coordinator_id, array['event_coordinator'],
    'Only the event''s assigned Event Coordinator can reject it'
  );

  select * into v_request from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  if v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned Event Coordinator can reject it' using errcode = '42501';
  end if;

  -- Confirmed events are past rejection: they leave through cancellation (N08)
  -- or a significant change (N05). The hint lets the UI offer cancellation.
  if v_request.status = 'confirmed' then
    raise exception 'This event is Confirmed, and only an Approved event can be rejected. Cancel it instead.'
      using errcode = '55000', hint = 'CANCEL_INSTEAD';
  end if;

  if v_request.status <> 'approved' then
    raise exception 'This event is %, and only an Approved event can be rejected.',
      equipment_event_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  if v_reason is null or v_reason = '' then
    raise exception 'A reason is required to reject this event' using errcode = '22023';
  end if;

  -- Lock in confirm_event_request's order, so a concurrent venue or equipment
  -- decision waits, then note what is about to be released for the notifications.
  perform 1 from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
   order by id
     for update;
  perform 1 from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled'
   order by id
     for update;

  select array_agg(id order by id) into v_booking_ids
    from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review');
  select array_agg(id order by id) into v_equipment_ids
    from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled';

  insert into event_request_decision_history
    (event_request_id, decision, decision_note, decided_by, decided_at,
     superseded_reason, superseded_by)
  values
    (v_request.id, v_request.decision, v_request.decision_note, v_request.decided_by,
     v_request.decided_at, 'rejected_after_approval', p_coordinator_id);

  -- The rejecter becomes the reviewer too: after a reassignment the reviewer is
  -- still the coordinator who approved, and decided_by_is_reviewer needs them equal.
  update event_requests
     set decision                 = 'rejected',
         decision_note            = v_reason,
         decided_by               = p_coordinator_id,
         decided_at               = now(),
         reviewing_coordinator_id = p_coordinator_id
   where id = p_event_request_id
     and status = 'approved';

  v_rejected := change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'approved',
    p_new_status           => 'rejected',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_reason,
    p_expected_coordinator => p_coordinator_id
  );

  perform release_event_arrangements(p_event_request_id, 'event rejected', p_coordinator_id);

  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_request.organiser_id,
    'event_rejected',
    p_event_request_id,
    jsonb_build_object(
      'audience', 'organiser',
      'eventName', v_request.event_name,
      'reason', v_reason,
      'rejectedAt', v_rejected.decided_at
    )
  );

  insert into notifications (recipient_id, type, event_request_id, booking_id, payload)
  select p.id,
         'event_rejected',
         p_event_request_id,
         b.id,
         jsonb_build_object(
           'audience', 'venue_staff',
           'eventName', v_request.event_name,
           'venueId', b.venue_id,
           'venueName', v.name,
           'startsAt', b.starts_at,
           'endsAt', b.ends_at
         )
    from bookings b
    join venues v on v.id = b.venue_id
   cross join profiles p
   where b.id = any (coalesce(v_booking_ids, '{}'))
     and p.role = 'venue_staff';

  insert into notifications (recipient_id, type, event_request_id, payload)
  select p.id,
         'event_rejected',
         p_event_request_id,
         jsonb_build_object(
           'audience', 'technical_support_staff',
           'eventName', v_request.event_name,
           'equipmentRequestId', r.id
         )
    from unnest(coalesce(v_equipment_ids, '{}')) as r(id)
   cross join profiles p
   where p.role = 'technical_support_staff';

  return v_rejected;
end;
$$;
revoke execute on function reject_approved_event(uuid, uuid, text) from public, anon, authenticated;
