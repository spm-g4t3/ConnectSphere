-- Migration 039: the registration notification contract (SCRUM-177).
-- Four new types, and the one writer every registration flow will call. Nothing
-- calls it yet; the flows and the opening/closing job are wired separately.
-- The matrix of transitions, recipients and destinations is docs/SCRUM-177.md.
--
-- Payloads (every one also carries audience, eventRequestId, eventName and
-- occurrenceKey; event_request_id is always set on the row):
-- - registration_opened:  { opensAt, closesAt, cause }
--     cause: opening_time | settings_changed | event_confirmed
-- - registration_closed:  { closedAt, cause }
--     cause: closing_time | switched_off | event_started | event_not_confirmed
-- - registration_capacity_reached: { capacity, registeredCount }
-- - registration_place_released:   { capacity, registeredCount, cause }
--     cause: withdrawal
-- registration_promoted (037) stays as it is; it is the waiting-list status change.
--
-- Only counts are sent, never another attendee's name, id or registration.
-- occurrenceKey names one occurrence of a transition, so a retried or repeated
-- writer sends nothing twice while a later occurrence (a reopening) still does.
--
-- Re-runnable.

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
    'registration_opened',
    'registration_closed',
    'registration_capacity_reached',
    'registration_place_released'
  ]));

-- Enforced on the row as well as in the writer, so a later direct insert cannot
-- send a staff-only notice to an attendee or lose its event.
alter table notifications drop constraint if exists notifications_registration_change_shape;
alter table notifications
  add constraint notifications_registration_change_shape check (
    type <> all (array['registration_opened', 'registration_closed',
                       'registration_capacity_reached', 'registration_place_released'])
    or (event_request_id is not null
        and coalesce(payload->>'occurrenceKey', '') <> ''
        -- coalesce: a missing audience must fail the check, not pass it as null.
        and case when type in ('registration_opened', 'registration_closed')
                 then coalesce(payload->>'audience', '') in ('organiser', 'coordinator', 'waitlisted')
                 else coalesce(payload->>'audience', '') in ('organiser', 'coordinator') end)
  );

create unique index if not exists notifications_one_per_registration_change
  on notifications (recipient_id, event_request_id, type, (payload->>'occurrenceKey'))
  where type in ('registration_opened', 'registration_closed',
                 'registration_capacity_reached', 'registration_place_released');

-- Sends one registration notice to each requested audience of an event:
-- organiser, coordinator (the assigned one, unless they are also the organiser)
-- and waitlisted (attendees queued now). p_details holds the type's own fields;
-- the shared ones are set here and win over it. Runs in the caller's
-- transaction and takes no lock, so a flow calls it after its own writes, under
-- the event lock it already holds. Returns how many were inserted; a repeated
-- occurrence inserts none.

create or replace function notify_registration_change(
  p_event_request_id uuid,
  p_type text,
  p_audiences text[],
  p_occurrence_key text,
  p_details jsonb default '{}'
)
returns integer
language plpgsql
as $$
declare
  v_event event_requests;
  v_allowed text[];
  v_causes text[];
  v_inserted integer;
begin
  v_allowed := case p_type
    when 'registration_opened' then array['organiser', 'coordinator', 'waitlisted']
    when 'registration_closed' then array['organiser', 'coordinator', 'waitlisted']
    when 'registration_capacity_reached' then array['organiser', 'coordinator']
    when 'registration_place_released' then array['organiser', 'coordinator']
  end;
  if v_allowed is null then
    raise exception 'Unknown registration notification type %', p_type using errcode = '22023';
  end if;
  if p_audiences is null or cardinality(p_audiences) = 0 or not (p_audiences <@ v_allowed) then
    raise exception '% cannot be sent to %', p_type, p_audiences using errcode = '22023';
  end if;
  if coalesce(p_occurrence_key, '') = '' then
    raise exception 'An occurrence key is required' using errcode = '22023';
  end if;

  v_causes := case p_type
    when 'registration_opened' then array['opening_time', 'settings_changed', 'event_confirmed']
    when 'registration_closed' then array['closing_time', 'switched_off', 'event_started', 'event_not_confirmed']
    when 'registration_place_released' then array['withdrawal']
  end;
  if v_causes is not null and coalesce(p_details->>'cause', '') <> all (v_causes) then
    raise exception '% needs a cause of %', p_type, v_causes using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  with recipients (recipient_id, audience) as (
    select v_event.organiser_id, 'organiser'
     where 'organiser' = any (p_audiences) and v_event.organiser_id is not null
    union all
    select v_event.assigned_coordinator_id, 'coordinator'
     where 'coordinator' = any (p_audiences)
       and v_event.assigned_coordinator_id is not null
       and v_event.assigned_coordinator_id is distinct from v_event.organiser_id
    union all
    select r.attendee_id, 'waitlisted'
      from event_registrations r
     where 'waitlisted' = any (p_audiences)
       and r.event_request_id = p_event_request_id and r.status = 'waitlisted'
  ), inserted as (
    insert into notifications (recipient_id, type, event_request_id, payload)
    select recipient_id, p_type, p_event_request_id,
           coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
             'audience', audience,
             'eventRequestId', p_event_request_id,
             'eventName', v_event.event_name,
             'occurrenceKey', p_occurrence_key)
      from recipients
    on conflict (recipient_id, event_request_id, type, (payload->>'occurrenceKey'))
      where type in ('registration_opened', 'registration_closed',
                     'registration_capacity_reached', 'registration_place_released')
      do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$$;
revoke execute on function notify_registration_change(uuid, text, text[], text, jsonb) from public, anon, authenticated;
