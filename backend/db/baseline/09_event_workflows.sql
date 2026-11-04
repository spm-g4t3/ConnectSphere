-- Baseline 09: workflows that span the domains above: cancelling an event and releasing
-- its arrangements, confirming it, and significant changes after confirmation.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

-- Cancellation. Cancelled is final; bookings and equipment are released, not deleted.

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
revoke execute on function release_event_arrangements(uuid, text, uuid) from public, anon, authenticated;

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

  if not event_request_status_allows(v_request.status, 'cancelled'::event_request_status) then
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

  -- Only safety_review: those officers were told it was waiting on them. A
  -- safety_approved event is already answered, and 064 notifies nobody then.
  if v_request.status::text = 'safety_review' then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select r.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'safety_officer',
             'eventName', v_request.event_name,
             'reason', btrim(p_reason),
             'cancelledAt', v_cancelled.cancelled_at
           )
      from safety_officer_recipients() as r(id);
  end if;

  return v_cancelled;
end;
$$;
revoke execute on function cancel_event_request(uuid, uuid, text, event_cancellation_initiator, text) from public, anon, authenticated;

-- Confirmation.

create or replace function confirm_event_request(
  p_event_request_id       uuid,
  p_coordinator_id         uuid,
  p_no_equipment_confirmed boolean default false,
  p_expected_updated_at    timestamptz default null
)
returns event_requests
language plpgsql
as $$
declare
  v_event      event_requests;
  v_readiness  jsonb;
  v_reason     text := 'Event confirmed.';
begin
  if p_event_request_id is null then
    raise exception 'An event request is required' using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  if p_coordinator_id is null
     or v_event.assigned_coordinator_id is distinct from p_coordinator_id
     or not exists (
       select 1 from profiles where id = p_coordinator_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the event''s assigned Event Coordinator can confirm it' using errcode = '42501';
  end if;

  if v_event.status <> 'safety_approved' then
    raise exception 'This event can be confirmed only while it is Safety approved. Its current status is %.',
      v_event.status using errcode = '55000';
  end if;

  -- Match safety submission's order: event, bookings by id, then equipment by id.
  -- Include conflicting requests so a concurrent venue decision also waits.
  perform 1 from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
   order by id
     for share;
  perform 1 from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled'
   order by id
     for share;

  -- 098 checks the current database clock, after any lock wait above.
  v_readiness := event_readiness(p_event_request_id, coalesce(p_no_equipment_confirmed, false));
  if not (v_readiness ->> 'ready')::boolean then
    raise exception 'This event is not ready for confirmation.'
      using errcode = 'PT409', hint = 'EVENT_NOT_READY',
            detail = (
              select coalesce(jsonb_agg(item), '[]'::jsonb)::text
                from jsonb_array_elements(v_readiness -> 'items') item
               where not (item ->> 'met')::boolean
            );
  end if;

  -- Acknowledgement belongs to the event revision the coordinator reviewed.
  if p_expected_updated_at is not null
     and v_event.updated_at is distinct from p_expected_updated_at then
    raise exception 'This event has changed. Refresh its checklist before confirming.' using errcode = '55000';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_readiness -> 'items') item
     where item ->> 'key' = 'no_equipment_confirmation' and (item ->> 'met')::boolean
  ) then
    if p_expected_updated_at is null then
      raise exception 'Refresh this event and explicitly acknowledge that no equipment is needed before confirming.'
        using errcode = '55000';
    end if;
    v_reason := 'Event confirmed. Coordinator acknowledged that no equipment is needed.';
  end if;

  return change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'safety_approved',
    p_new_status           => 'confirmed',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_reason,
    p_expected_coordinator => p_coordinator_id
  );
end;
$$;
revoke execute on function confirm_event_request(uuid, uuid, boolean, timestamp with time zone) from public, anon, authenticated;

-- Significant changes to a confirmed event: preview the impact, then apply it, which
-- flags affected arrangements and sends the event back through safety review.

create or replace function significant_event_change_impact(
  p_event_request_id uuid,
  p_changes          jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public
as $impact$
declare
  v_event event_requests%rowtype;
  v_key text;
  v_start timestamptz;
  v_end timestamptz;
  v_attendance integer;
  v_venue_requirements text;
  v_accessibility_requirements text;
  v_start_changed boolean;
  v_end_changed boolean;
  v_attendance_changed boolean;
  v_venue_requirements_changed boolean;
  v_accessibility_requirements_changed boolean;
  v_equipment_change boolean;
  v_changed_fields jsonb;
  v_bookings jsonb;
  v_reservations jsonb;
  v_pending_requests jsonb;
  v_attendee_count integer;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Significant event changes must be an object'
      using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_changes)
  loop
    if v_key not in (
      'proposedStart', 'proposedEnd', 'expectedAttendance',
      'venueRequirements', 'accessibilityRequirements', 'equipmentChange'
    ) then
      raise exception 'Unsupported significant event field: %', v_key
        using errcode = '22023';
    end if;
  end loop;

  if p_changes = '{}'::jsonb then
    raise exception 'At least one significant event change is required'
      using errcode = '22023';
  end if;

  select * into v_event
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  if p_changes ? 'proposedStart' then
    if jsonb_typeof(p_changes -> 'proposedStart') <> 'string'
       or p_changes ->> 'proposedStart' !~ $timestamp$^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$$timestamp$ then
      raise exception 'proposedStart must be an ISO timestamp'
        using errcode = '22023';
    end if;
    begin
      v_start := (p_changes ->> 'proposedStart')::timestamptz;
    exception when others then
      raise exception 'proposedStart must be an ISO timestamp'
        using errcode = '22023';
    end;
  else
    v_start := v_event.proposed_start;
  end if;

  if p_changes ? 'proposedEnd' then
    if jsonb_typeof(p_changes -> 'proposedEnd') <> 'string'
       or p_changes ->> 'proposedEnd' !~ $timestamp$^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$$timestamp$ then
      raise exception 'proposedEnd must be an ISO timestamp'
        using errcode = '22023';
    end if;
    begin
      v_end := (p_changes ->> 'proposedEnd')::timestamptz;
    exception when others then
      raise exception 'proposedEnd must be an ISO timestamp'
        using errcode = '22023';
    end;
  else
    v_end := v_event.proposed_end;
  end if;

  if p_changes ? 'expectedAttendance' then
    if jsonb_typeof(p_changes -> 'expectedAttendance') <> 'number'
       or (p_changes ->> 'expectedAttendance')::numeric <= 0
       or (p_changes ->> 'expectedAttendance')::numeric > 2147483647
       or trunc((p_changes ->> 'expectedAttendance')::numeric)
            <> (p_changes ->> 'expectedAttendance')::numeric then
      raise exception 'expectedAttendance must be a positive whole number'
        using errcode = '22023';
    end if;
    v_attendance := (p_changes ->> 'expectedAttendance')::integer;
  else
    v_attendance := v_event.expected_attendance;
  end if;

  if p_changes ? 'venueRequirements' then
    if jsonb_typeof(p_changes -> 'venueRequirements') not in ('string', 'null') then
      raise exception 'venueRequirements must be text or null'
        using errcode = '22023';
    end if;
    v_venue_requirements := nullif(btrim(p_changes ->> 'venueRequirements'), '');
  else
    v_venue_requirements := v_event.venue_requirements;
  end if;

  if p_changes ? 'accessibilityRequirements' then
    if jsonb_typeof(p_changes -> 'accessibilityRequirements') not in ('string', 'null') then
      raise exception 'accessibilityRequirements must be text or null'
        using errcode = '22023';
    end if;
    v_accessibility_requirements := nullif(btrim(p_changes ->> 'accessibilityRequirements'), '');
  else
    v_accessibility_requirements := v_event.accessibility_requirements;
  end if;

  if p_changes ? 'equipmentChange' then
    if jsonb_typeof(p_changes -> 'equipmentChange') <> 'boolean' then
      raise exception 'equipmentChange must be true or false'
        using errcode = '22023';
    end if;
    v_equipment_change := (p_changes ->> 'equipmentChange')::boolean;
  else
    v_equipment_change := false;
  end if;

  if nullif(btrim(v_event.event_name), '') is null
     or nullif(btrim(v_event.purpose), '') is null
     or v_start is null or v_end is null or v_attendance is null or v_attendance <= 0 then
    raise exception 'The event does not meet SCRUM-10 submission requirements'
      using errcode = '22023';
  end if;
  if v_start <= now() then
    raise exception 'proposedStart must be in the future'
      using errcode = '22023';
  end if;
  if v_end <= v_start then
    raise exception 'proposedEnd must be later than proposedStart'
      using errcode = '22023';
  end if;

  v_start_changed := v_start is distinct from v_event.proposed_start;
  v_end_changed := v_end is distinct from v_event.proposed_end;
  v_attendance_changed := v_attendance is distinct from v_event.expected_attendance;
  v_venue_requirements_changed :=
    v_venue_requirements is distinct from v_event.venue_requirements;
  v_accessibility_requirements_changed :=
    v_accessibility_requirements is distinct from v_event.accessibility_requirements;

  if not (
    v_start_changed or v_end_changed or v_attendance_changed
    or v_venue_requirements_changed or v_accessibility_requirements_changed
    or v_equipment_change
  ) then
    raise exception 'The significant event change contains no changed values'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', b.id,
             'venueId', b.venue_id,
             'venueName', v.name,
             'venueLocation', v.location,
             'capacity', v.max_capacity,
             'startsAt', b.starts_at,
             'endsAt', b.ends_at,
             'occupiedStartsAt', lower(venue_occupied_period(
               v_start, v_end, v.setup_minutes, v.turnaround_minutes
             )),
             'occupiedEndsAt', upper(venue_occupied_period(
               v_start, v_end, v.setup_minutes, v.turnaround_minutes
             )),
             'alreadyFlagged', b.status::text = 'flagged_for_review'
           ) order by b.starts_at, b.id
         ), '[]'::jsonb)
    into v_bookings
    from bookings b
    join venues v on v.id = b.venue_id
   where b.event_request_id = p_event_request_id
     and b.status::text in ('approved', 'flagged_for_review')
     and (
       v_start_changed or v_end_changed
       or (v_attendance_changed and v_attendance > v.max_capacity)
       or v_venue_requirements_changed
       or v_accessibility_requirements_changed
     );

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', reservation.id,
             'equipmentName', equipment.name,
             'quantity', reservation.quantity,
             'startsAt', reservation.start_at,
             'endsAt', reservation.end_at
           ) order by reservation.start_at, reservation.id
         ), '[]'::jsonb)
    into v_reservations
    from equipment_reservations reservation
    join equipment_types equipment on equipment.id = reservation.equipment_type_id
   where reservation.event_request_id = p_event_request_id
     and (v_start_changed or v_end_changed)
     and reservation.released_at is null
     and not reservation.flagged;

  -- Open requests are listed, never flagged: only a confirmed booking blocks a
  -- venue, so Venue Staff are told and the coordinator decides what to do.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', b.id,
             'venueName', v.name,
             'startsAt', b.starts_at,
             'endsAt', b.ends_at
           ) order by b.starts_at, b.id
         ), '[]'::jsonb)
    into v_pending_requests
    from bookings b
    join venues v on v.id = b.venue_id
   where b.event_request_id = p_event_request_id
     and b.status::text in ('pending', 'conflicting')
     and (v_start_changed or v_end_changed);

  if v_start_changed or v_end_changed then
    select count(*)::integer
      into v_attendee_count
      from event_registrations registration
     where registration.event_request_id = p_event_request_id
       and registration.status = 'registered';
  else
    v_attendee_count := 0;
  end if;

  select coalesce(jsonb_agg(field), '[]'::jsonb)
    into v_changed_fields
    from (
      select field from (values
        ('proposedStart', v_start_changed),
        ('proposedEnd', v_end_changed),
        ('expectedAttendance', v_attendance_changed),
        ('venueRequirements', v_venue_requirements_changed),
        ('accessibilityRequirements', v_accessibility_requirements_changed),
        ('equipment', v_equipment_change)
      ) as changed(field, changed)
      where changed
    ) fields;

  return jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'eventName', v_event.event_name,
    'statusBefore', v_event.status::text,
    'statusAfter', case
      when v_event.status::text in ('confirmed', 'safety_review', 'safety_approved')
        then 'approved'
      else v_event.status::text
    end,
    'changedFields', v_changed_fields,
    'venueBookings', v_bookings,
    'equipmentReservations', v_reservations,
    'pendingBookingRequests', v_pending_requests,
    'registeredAttendeesToNotify', v_attendee_count,
    'equipmentChangeRecorded', v_equipment_change
  );
end;
$impact$;
revoke execute on function significant_event_change_impact(uuid, jsonb) from public, anon, authenticated;

create or replace function preview_significant_event_change(
  p_event_request_id uuid,
  p_changes          jsonb,
  p_user_id          uuid
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can preview this change'
      using errcode = '42501';
  end if;
  if v_event.status::text not in ('approved', 'confirmed', 'safety_review', 'safety_approved') then
    raise exception 'Event status % does not allow a significant change', v_event.status
      using errcode = 'PT409',
            hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;

  return significant_event_change_impact(p_event_request_id, p_changes);
end;
$$;
revoke execute on function preview_significant_event_change(uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function apply_significant_event_change(
  p_event_request_id uuid,
  p_changes          jsonb,
  p_reason           text,
  p_user_id          uuid,
  p_expected_impact  jsonb default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_updated event_requests%rowtype;
  v_impact jsonb;
  v_booking_ids uuid[];
  v_reservation_ids uuid[];
  v_flagged_booking_ids uuid[];
  v_reservation_count integer;
  v_latest_submission_id uuid;
  v_previous_change_event_id text;
  v_reason text := nullif(btrim(p_reason), '');
begin
  -- 1. Lock the event before checking its owner, lifecycle or arrangements.
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  -- 2. Verify the caller and status under the lock.
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can apply this change'
      using errcode = '42501';
  end if;
  if v_event.status::text not in ('approved', 'confirmed', 'safety_review', 'safety_approved') then
    raise exception 'Event status % does not allow a significant change', v_event.status
      using errcode = 'PT409',
            hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;
  if v_reason is null or length(v_reason) > 4000 then
    raise exception 'A reason of 1 to 4,000 characters is required'
      using errcode = '22023';
  end if;

  -- Determine and lock the exact active arrangements before persisting fields.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;

  perform 1
    from bookings
   where id = any(v_booking_ids)
   order by id
   for update;
  perform 1
    from equipment_reservations
   where id = any(v_reservation_ids)
   order by id
   for update;

  -- Recalculate with the shared routine after acquiring arrangement locks.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;
  if p_expected_impact is not null and v_impact is distinct from p_expected_impact then
    raise exception 'The impact changed; refresh the preview before confirming'
      using errcode = 'PT409',
            hint = 'SIGNIFICANT_CHANGE_IMPACT_CHANGED';
  end if;

  -- Close a pending review and leave Confirmed before editing locked fields.
  -- Later failures roll back this transition and its history with the change.
  if v_event.status::text = 'safety_review' then
    select id into v_latest_submission_id
      from safety_review_submissions
     where event_request_id = p_event_request_id
     order by created_at desc, id desc
     limit 1;

    if v_latest_submission_id is null then
      raise exception 'The pending safety review has no submission to close'
        using errcode = '55000';
    end if;

    insert into safety_review_closures (
      event_request_id, safety_review_submission_id, closed_by, reason
    ) values (
      p_event_request_id, v_latest_submission_id, p_user_id, v_reason
    );
  end if;

  -- Return Confirmed and safety-stage events to Approved through the
  -- existing transition/history function.
  if v_event.status::text in ('confirmed', 'safety_review', 'safety_approved') then
    v_updated := change_event_request_status(
      p_event_request_id,
      v_event.status,
      'approved',
      p_user_id,
      v_reason,
      p_user_id
    );
  end if;

  -- 3. Save fields and one history row for each changed field.
  v_previous_change_event_id :=
    current_setting('connectsphere.significant_event_change_event_id', true);
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    p_event_request_id::text,
    true
  );
  update event_requests
     set proposed_start = case when p_changes ? 'proposedStart'
                               then (p_changes ->> 'proposedStart')::timestamptz
                               else proposed_start end,
         proposed_end = case when p_changes ? 'proposedEnd'
                             then (p_changes ->> 'proposedEnd')::timestamptz
                             else proposed_end end,
         expected_attendance = case when p_changes ? 'expectedAttendance'
                                    then (p_changes ->> 'expectedAttendance')::integer
                                    else expected_attendance end,
         venue_requirements = case when p_changes ? 'venueRequirements'
                                   then nullif(btrim(p_changes ->> 'venueRequirements'), '')
                                   else venue_requirements end,
         accessibility_requirements = case when p_changes ? 'accessibilityRequirements'
                                            then nullif(btrim(p_changes ->> 'accessibilityRequirements'), '')
                                            else accessibility_requirements end
   where id = p_event_request_id
   returning * into v_updated;
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    coalesce(v_previous_change_event_id, ''),
    true
  );

  insert into event_change_history (
    event_request_id, changed_by, field_name, old_value, new_value, reason
  )
  select p_event_request_id, p_user_id, field_name, old_value, new_value, v_reason
    from (
      select 'proposedStart'::text as field_name,
             to_jsonb(v_event.proposed_start) as old_value,
             to_jsonb(v_updated.proposed_start) as new_value
      union all
      select 'proposedEnd',
             to_jsonb(v_event.proposed_end),
             to_jsonb(v_updated.proposed_end)
      union all
      select 'expectedAttendance',
             to_jsonb(v_event.expected_attendance),
             to_jsonb(v_updated.expected_attendance)
      union all
      select 'venueRequirements',
             to_jsonb(v_event.venue_requirements),
             to_jsonb(v_updated.venue_requirements)
      union all
      select 'accessibilityRequirements',
             to_jsonb(v_event.accessibility_requirements),
             to_jsonb(v_updated.accessibility_requirements)
    ) changed_fields
   where old_value is distinct from new_value;

  if coalesce((v_impact ->> 'equipmentChangeRecorded')::boolean, false) then
    insert into event_change_history (
      event_request_id, changed_by, field_name, old_value, new_value, reason
    ) values (
      p_event_request_id, p_user_id, 'equipment',
      '{"changeRequested":false}'::jsonb,
      '{"changeRequested":true}'::jsonb,
      v_reason
    );
  end if;

  -- 4. Flag each affected venue booking. Existing flags stay under review;
  -- this event-change category is added without erasing the original cause.
  with flagged as (
    update bookings b
       set status = 'flagged_for_review',
           flag_reason = coalesce(b.flag_reason, 'event_change'),
           review_reason = coalesce(b.review_reason, 'event_changed'),
           flagged_at = coalesce(b.flagged_at, now()),
           flagged_by = coalesce(b.flagged_by, p_user_id)
     where b.id = any(v_booking_ids)
       and b.status::text in ('approved', 'flagged_for_review')
    returning b.id, b.venue_id, b.starts_at, b.ends_at
  )
  select coalesce(array_agg(flagged.id order by flagged.id), '{}')
    into v_flagged_booking_ids
    from flagged;

  if cardinality(v_flagged_booking_ids) <> cardinality(v_booking_ids) then
    raise exception 'A venue booking changed while applying the event change'
      using errcode = '40001';
  end if;

  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_flagged_event_change', flagged.id, p_event_request_id,
         jsonb_build_object(
           'eventName', v_updated.event_name,
           'venueName', venue.name,
           'startsAt', flagged.starts_at,
           'endsAt', flagged.ends_at,
           'reason', v_reason
         )
    from bookings flagged
    join venues venue on venue.id = flagged.venue_id
    cross join profiles staff
   where flagged.id = any(v_flagged_booking_ids)
     and staff.role = 'venue_staff';

  -- Pending requests keep their status; Venue Staff deciding them need the new time.
  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_request_event_change', (item ->> 'id')::uuid, p_event_request_id,
         jsonb_build_object(
           'eventRequestId', p_event_request_id,
           'eventName', v_updated.event_name,
           'venueName', item ->> 'venueName',
           'startsAt', item -> 'startsAt',
           'endsAt', item -> 'endsAt',
           'newStartsAt', v_updated.proposed_start,
           'newEndsAt', v_updated.proposed_end,
           'reason', v_reason
         )
    from jsonb_array_elements(v_impact -> 'pendingBookingRequests') item
    cross join profiles staff
   where staff.role = 'venue_staff';

  -- 5. N15 owns reservation history and equipment-request review state. 054's
  -- own reason, so 097 tells Technical Support and the coordinator once per move.
  v_reservation_count := flag_equipment_reservations(v_reservation_ids, 'The event date or time changed');
  if v_reservation_count <> cardinality(v_reservation_ids) then
    raise exception 'An equipment reservation changed while applying the event change'
      using errcode = '40001';
  end if;


  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_event.organiser_id,
    'event_significant_change',
    p_event_request_id,
    jsonb_build_object(
      'eventRequestId', p_event_request_id,
      'eventName', v_event.event_name,
      'reason', v_reason,
      'changedFields', v_impact -> 'changedFields',
      'statusBefore', v_impact ->> 'statusBefore',
      'statusAfter', v_impact ->> 'statusAfter'
    )
  );

  if coalesce((v_impact ->> 'registeredAttendeesToNotify')::integer, 0) > 0 then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select registration.attendee_id,
           'event_significant_change_attendee',
           p_event_request_id,
           jsonb_build_object(
             'eventRequestId', p_event_request_id,
             'eventName', v_event.event_name,
             'startsAt', v_updated.proposed_start,
             'endsAt', v_updated.proposed_end,
             'reason', v_reason
           )
      from event_registrations registration
     where registration.event_request_id = p_event_request_id
       and registration.status = 'registered';
  end if;

  return jsonb_build_object(
    'event', to_jsonb(v_updated),
    'impact', v_impact,
    'flaggedBookingIds', to_jsonb(v_flagged_booking_ids),
    'flaggedReservationCount', v_reservation_count
  );
end;
$$;
revoke execute on function apply_significant_event_change(uuid, jsonb, text, uuid, jsonb) from public, anon, authenticated;
