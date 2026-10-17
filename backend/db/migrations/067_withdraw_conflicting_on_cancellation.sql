-- 067_withdraw_conflicting_on_cancellation.sql
-- SCRUM-258: cancelling an event treats its conflicting booking requests (065)
-- as it treats its pending ones -- they are withdrawn, listed in the preview,
-- and Venue Staff are told.
--
-- Its own file, apart from 066, because these functions belong to the
-- cancellation stack (042-049, 054) and 066's do not. Each is its latest
-- definition restated, changed only where it compares a booking status with
-- 'pending':
--   release_event_arrangements                                054
--   event_cancellation_impact_preview                         049
--   cancel_event_request                                      048
--
-- A converted hold (065, 066) is left alone: these act on active holds only,
-- and cancelling cancels the booking the hold became. Nothing here needs 066's
-- objects; only 065's 'conflicting' value, so it may run without 066.
--
-- Run order: 065, then 066, then 067, each as a separate execution.
-- SQLSTATEs are unchanged from 048, 049 and 054.


-- ---------------------------------------------------------------------
-- 1. release_event_arrangements (054, conflicting ones too)
-- ---------------------------------------------------------------------
-- Cancelling an event withdraws its conflicting requests as it withdraws its
-- pending ones. 054's function otherwise word for word.

create or replace function release_event_arrangements(
  p_event_request_id uuid,
  p_reason text,
  p_released_by uuid default null
)
returns void
language plpgsql
as $$
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Release reason is required and cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  update bookings
     set status = case
       when status in ('pending', 'conflicting') then 'withdrawn'::booking_status
       else 'cancelled'::booking_status
     end
   where event_request_id = p_event_request_id
     and status in ('pending', 'conflicting', 'approved', 'flagged_for_review');

  perform release_equipment_reservations(p_event_request_id, null, p_reason, null);

  update equipment_requests
     set status = 'cancelled'
   where event_request_id = p_event_request_id
     and status <> 'cancelled';

  update venue_holds
     set status = 'released',
         released_at = now(),
         released_by = p_released_by
   where event_request_id = p_event_request_id
     and status = 'active';
end;
$$;

revoke execute on function release_event_arrangements(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function release_event_arrangements(uuid, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------
-- 2. event_cancellation_impact_preview (049, conflicting ones too)
-- ---------------------------------------------------------------------
-- Lists the conflicting requests with the pending ones, since cancelling
-- withdraws both (section 1). 049's function otherwise word for word.

create or replace function event_cancellation_impact_preview(
  p_event_request_id uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_preview jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (
    select 1
      from event_requests
     where id = p_event_request_id
  ) then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  select jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'venueBookings', jsonb_build_object(
      'count', (
        select count(*)::integer
          from bookings b
         where b.event_request_id = p_event_request_id
           and b.status in ('approved', 'flagged_for_review')
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'status', b.status::text,
            'venueId', b.venue_id,
            'venueName', v.name,
            'venueLocation', v.location,
            'startsAt', b.starts_at,
            'endsAt', b.ends_at
          )
          order by b.starts_at, b.id
        )
          from bookings b
          join venues v on v.id = b.venue_id
         where b.event_request_id = p_event_request_id
           and b.status in ('approved', 'flagged_for_review')
      ), '[]'::jsonb)
    ),
    'bookingRequests', jsonb_build_object(
      'count', (
        select count(*)::integer
          from bookings b
         where b.event_request_id = p_event_request_id
           and b.status in ('pending', 'conflicting')
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'status', b.status::text,
            'venueId', b.venue_id,
            'venueName', v.name,
            'venueLocation', v.location,
            'startsAt', b.starts_at,
            'endsAt', b.ends_at
          )
          order by b.starts_at, b.id
        )
          from bookings b
          join venues v on v.id = b.venue_id
         where b.event_request_id = p_event_request_id
           and b.status in ('pending', 'conflicting')
      ), '[]'::jsonb)
    ),
    'venueHolds', jsonb_build_object(
      'count', (
        select count(*)::integer
          from venue_holds h
         where h.event_request_id = p_event_request_id
           and h.status = 'active'
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', h.id,
            'status', h.status::text,
            'venueId', h.venue_id,
            'venueName', v.name,
            'venueLocation', v.location,
            'placedAt', h.placed_at,
            'expiresAt', h.expires_at
          )
          order by h.expires_at, h.id
        )
          from venue_holds h
          join venues v on v.id = h.venue_id
         where h.event_request_id = p_event_request_id
           and h.status = 'active'
      ), '[]'::jsonb)
    ),
    'equipmentRequests', jsonb_build_object(
      'count', (
        select count(*)::integer
          from equipment_requests r
         where r.event_request_id = p_event_request_id
           and r.status <> 'cancelled'
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'status', r.status::text,
            'createdAt', r.created_at,
            'lines', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', l.id,
                  'equipmentTypeId', l.equipment_type_id,
                  'equipmentName', t.name,
                  'quantity', l.quantity,
                  'technicalNotes', l.technical_notes
                )
                order by t.name, l.id
              )
                from equipment_lines l
                join equipment_types t on t.id = l.equipment_type_id
               where l.equipment_request_id = r.id
                 and l.removed_at is null
            ), '[]'::jsonb)
          )
          order by r.created_at, r.id
        )
          from equipment_requests r
         where r.event_request_id = p_event_request_id
           and r.status <> 'cancelled'
      ), '[]'::jsonb)
    ),
    'equipmentReservations', jsonb_build_object(
      'count', (
        select count(*)::integer
          from equipment_reservations r
         where r.event_request_id = p_event_request_id
           and r.released_at is null
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'equipmentTypeId', r.equipment_type_id,
            'equipmentName', t.name,
            'equipmentLineId', r.equipment_line_id,
            'quantity', r.quantity,
            'startsAt', r.start_at,
            'endsAt', r.end_at,
            'flagged', r.flagged
          )
          order by r.start_at, t.name, r.id
        )
          from equipment_reservations r
          join equipment_types t on t.id = r.equipment_type_id
         where r.event_request_id = p_event_request_id
           and r.released_at is null
      ), '[]'::jsonb)
    )
  )
    into v_preview;

  return v_preview;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. cancel_event_request (048, conflicting ones too)
-- ---------------------------------------------------------------------
-- A conflicting request is one cancelling withdraws (section 1), so Venue
-- Staff are told as they are for a pending one. 048's function otherwise word
-- for word.

create or replace function cancel_event_request(
  p_event_request_id uuid,
  p_coordinator_id uuid,
  p_reason text,
  p_initiator event_cancellation_initiator,
  p_attendee_message text default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_question_id uuid;
  v_cancelled event_requests;
  v_has_venue_bookings boolean;
  v_has_equipment boolean;
begin
  if p_event_request_id is null or p_coordinator_id is null then
    raise exception 'Event request id and coordinator id are required'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Cancellation reason is required and cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_initiator is null then
    raise exception 'Cancellation initiator is required'
      using errcode = 'null_value_not_allowed';
  end if;

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the coordinator assigned to event request % can cancel it',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status::text not in (
    'submitted',
    'under_review',
    'pending_clarification',
    'approved',
    'confirmed'
  ) then
    raise exception 'Event request % has status %, which cannot be cancelled',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select exists (
    select 1
      from bookings b
     where b.event_request_id = p_event_request_id
       and b.status in ('pending', 'conflicting', 'approved', 'flagged_for_review')
  )
    into v_has_venue_bookings;

  select exists (
    select 1
      from equipment_requests r
     where r.event_request_id = p_event_request_id
       and r.status <> 'cancelled'
    union all
    select 1
      from equipment_reservations r
     where r.event_request_id = p_event_request_id
       and r.released_at is null
  )
    into v_has_equipment;

  select *
    into v_cancelled
    from change_event_request_status(
      p_event_request_id,
      v_request.status,
      'cancelled'::event_request_status,
      p_coordinator_id,
      btrim(p_reason),
      p_coordinator_id
    );

  update event_requests
     set cancellation_reason = btrim(p_reason),
         cancellation_initiator = p_initiator,
         cancelled_by = p_coordinator_id,
         cancelled_at = now(),
         attendee_message = nullif(btrim(p_attendee_message), '')
   where id = p_event_request_id
  returning * into v_cancelled;

  perform release_event_arrangements(
    p_event_request_id,
    'event cancelled',
    p_coordinator_id
  );

  update event_change_requests
     set status = 'processed',
         decision = 'event_cancelled',
         decision_notes = null,
         processed_by = p_coordinator_id
   where event_request_id = p_event_request_id
     and status in ('outstanding', 'in_progress');

  select question.id
    into v_question_id
    from event_request_clarification_history question
   where question.event_request_id = p_event_request_id
     and question.entry_type = 'question'
     and not exists (
       select 1
         from event_request_clarification_history closed
        where closed.event_request_id = question.event_request_id
          and closed.entry_type in ('reply', 'closure')
          and (closed.created_at, closed.id) > (question.created_at, question.id)
     )
   order by question.created_at desc, question.id desc
   limit 1;

  if v_question_id is not null then
    insert into event_request_clarification_history
      (event_request_id, entry_type, message, created_by)
    values
      (p_event_request_id, 'closure', 'Event cancelled', p_coordinator_id);
  end if;

  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_request.organiser_id,
    'event_cancelled',
    p_event_request_id,
    jsonb_build_object(
      'audience', 'organiser',
      'eventName', v_request.event_name,
      'reason', btrim(p_reason),
      'cancelledAt', v_cancelled.cancelled_at
    )
  );

  if v_has_venue_bookings then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'venue_staff',
             'eventName', v_request.event_name
           )
      from profiles p
     where p.role = 'venue_staff';
  end if;

  if v_has_equipment then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'technical_support_staff',
             'eventName', v_request.event_name
           )
      from profiles p
     where p.role = 'technical_support_staff';
  end if;

  return v_cancelled;
end;
$$;

revoke execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) from public, anon, authenticated;
grant execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) to service_role;


notify pgrst, 'reload schema';
