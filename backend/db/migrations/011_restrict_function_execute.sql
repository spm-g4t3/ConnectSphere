-- Migration 011: only the API may call the schema's functions.
-- Supabase grants EXECUTE on every new public function to anon and authenticated,
-- and the functions trust their p_caller argument, so a client holding the
-- publishable key could call one directly as anyone. Every function is revoked
-- from the client roles here, new ones start revoked, and the reads that took no
-- caller now take one and check it. service_role keeps its grant.

-- New functions start revoked. postgres creates them, in the SQL editor and in
-- PGlite. PUBLIC's EXECUTE is a global default, so it is revoked globally; the
-- client roles were granted per schema, so they are revoked per schema.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- A caller who must hold one of p_roles.

create or replace function assert_caller_role(
  p_caller  uuid,
  p_roles   text[],
  p_message text
)
returns void
language plpgsql
stable
as $$
begin
  -- A null caller is refused explicitly, not left to the profile lookup finding
  -- no row, so the refusal does not hang on how the lookup is written.
  if p_caller is null or not exists (
    select 1 from profiles where id = p_caller and role::text = any (p_roles)
  ) then
    raise exception '%', p_message using errcode = '42501';
  end if;
end;
$$;

-- Starting or taking over an equipment review needs Technical Support Staff,
-- as the route's requireRole does; before this only a null caller was refused.

create or replace function start_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  perform assert_caller_role(
    p_user_id, array['technical_support_staff'],
    'Only Technical Support Staff can review equipment requests'
  );

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status = 'under_review' then
    raise exception
      'This equipment request is already Under review. Take over the review instead.'
      using errcode = '55000';
  end if;

  if v_request.status not in ('pending_review', 'cannot_be_fully_arranged') then
    raise exception
      'A review can only start when the request is Pending review or Cannot be fully arranged. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  update equipment_requests
     set status = 'under_review',
         reviewer_id = p_user_id,
         review_started_at = now()
   where id = v_request.id
     and status in ('pending_review', 'cannot_be_fully_arranged');

  if not found then
    raise exception 'The equipment request changed while the review was being started'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'started', p_user_id);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function take_over_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  perform assert_caller_role(
    p_user_id, array['technical_support_staff'],
    'Only Technical Support Staff can review equipment requests'
  );

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status <> 'under_review' then
    raise exception
      'A review can only be taken over while the request is Under review. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  if v_request.reviewer_id = p_user_id then
    raise exception 'You are already reviewing this request'
      using errcode = '55000';
  end if;

  update equipment_requests
     set reviewer_id = p_user_id
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being taken over'
      using errcode = '40001';
  end if;

  insert into equipment_review_history
    (equipment_request_id, action, user_id, from_user_id)
  values (v_request.id, 'taken_over', p_user_id, v_request.reviewer_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

-- The Safety Officer's queue, detail and history take the caller and check it.

drop function if exists safety_review_queue();
drop function if exists safety_review_detail(uuid);
drop function if exists safety_review_history();

create or replace function safety_review_queue(p_caller uuid)
returns jsonb
language sql
stable
as $$
  select assert_caller_role(
    p_caller, array['safety_officer'], 'Only Safety Officers can view safety reviews'
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'eventName', e.event_name,
        'startsAt', e.proposed_start,
        'endsAt', e.proposed_end,
        'expectedAttendance', e.expected_attendance,
        'coordinatorName', coordinator.full_name,
        'submittedAt', coalesce(safety_started.created_at, e.submitted_at, e.created_at),
        'waitingSeconds', greatest(0, floor(extract(epoch from (
          now() - coalesce(safety_started.created_at, e.submitted_at, e.created_at)
        )))::integer),
        'venues', coalesce((
          select jsonb_agg(distinct venue.name)
            from bookings booking
            join venues venue on venue.id = booking.venue_id
           where booking.event_request_id = e.id
             and booking.status in ('approved', 'flagged_for_review')
        ), '[]'::jsonb)
      ) order by coalesce(safety_started.created_at, e.submitted_at, e.created_at), e.id
    ),
    '[]'::jsonb
  )
  from event_requests e
  left join lateral (
    select history.created_at, history.changed_by
      from event_request_status_history history
     where history.event_request_id = e.id
       and history.new_status = 'safety_review'
     order by history.created_at desc, history.id desc
     limit 1
  ) safety_started on true
  left join lateral (
    select submission.submitted_by
      from safety_review_submissions submission
     where submission.event_request_id = e.id
     order by submission.created_at desc, submission.id desc
     limit 1
  ) latest_submission on true
  left join profiles coordinator
    on coordinator.id = coalesce(latest_submission.submitted_by, safety_started.changed_by)
  where e.status = 'safety_review';
$$;

create or replace function safety_review_detail(p_event_request_id uuid, p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event event_requests%rowtype;
begin
  perform assert_caller_role(
    p_caller, array['safety_officer'], 'Only Safety Officers can view safety reviews'
  );

  select * into v_event
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', v_event.id,
      'eventName', v_event.event_name,
      'status', v_event.status,
      'startsAt', v_event.proposed_start,
      'endsAt', v_event.proposed_end,
      'expectedAttendance', v_event.expected_attendance,
      'accessibilityRequirements', v_event.accessibility_requirements,
      'coordinatorNote', (
        select submission.note
          from safety_review_submissions submission
         where submission.event_request_id = v_event.id
         order by submission.created_at desc, submission.id desc
         limit 1
      )
    ),
    'venues', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bookingId', booking.id,
          'name', venue.name,
          'location', venue.location,
          'capacity', venue.max_capacity,
          'layout', layout.label,
          'emergencyAccess', venue.emergency_access,
          'knownRestrictions', venue.known_restrictions
        ) order by booking.starts_at, booking.id
      )
      from bookings booking
      join venues venue on venue.id = booking.venue_id
      left join room_layouts layout on layout.code = booking.room_layout_code
      where booking.event_request_id = v_event.id
        and booking.status in ('approved', 'flagged_for_review')
    ), '[]'::jsonb),
    'equipment', (
      select jsonb_build_object(
        'requestId', equipment_request.id,
        'status', equipment_request.status,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', line.id,
            'name', equipment_type.name,
            'quantity', line.quantity,
            'technicalNotes', line.technical_notes
          ) order by equipment_type.name, line.id)
          from equipment_lines line
          join equipment_types equipment_type on equipment_type.id = line.equipment_type_id
          where line.equipment_request_id = equipment_request.id
            and line.removed_at is null
        ), '[]'::jsonb)
      )
      from equipment_requests equipment_request
      where equipment_request.event_request_id = v_event.id
        and equipment_request.status = 'arranged'
      order by equipment_request.created_at, equipment_request.id
      limit 1
    ),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', response.id,
        'outcome', response.outcome,
        'note', response.note,
        'safetyOfficerId', response.safety_officer_id,
        'safetyOfficerName', officer.full_name,
        'affectedBookingIds', response.affected_booking_ids,
        'equipmentAffected', response.equipment_affected,
        'createdAt', response.created_at
      ) order by response.created_at, response.id)
      from safety_review_responses response
      left join profiles officer on officer.id = response.safety_officer_id
      where response.event_request_id = v_event.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function safety_review_history(p_caller uuid)
returns jsonb
language sql
stable
as $$
  select assert_caller_role(
    p_caller, array['safety_officer'], 'Only Safety Officers can view safety reviews'
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'eventName', e.event_name,
        'startsAt', e.proposed_start,
        'endsAt', e.proposed_end,
        'status', e.status,
        'outcome', r.outcome,
        'note', r.note,
        'safetyOfficerName', officer.full_name,
        'respondedAt', r.created_at
      ) order by r.created_at desc, r.id
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (event_request_id) *
      from safety_review_responses
     order by event_request_id, created_at desc, id desc
  ) r
  join event_requests e on e.id = r.event_request_id
  left join profiles officer on officer.id = r.safety_officer_id;
$$;

-- The cancellation preview takes the caller: the event's assigned coordinator only.

drop function if exists event_cancellation_impact_preview(uuid);

create or replace function event_cancellation_impact_preview(
  p_event_request_id uuid,
  p_caller           uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_preview  jsonb;
  v_assigned uuid;
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select assigned_coordinator_id into v_assigned
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- The route's check, kept here too: the assigned coordinator, still holding the role.
  if p_caller is null
     or v_assigned is distinct from p_caller
     or not exists (
       select 1 from profiles where id = p_caller and role = 'event_coordinator'
     ) then
    raise exception 'Only the coordinator assigned to this event can preview its cancellation'
      using errcode = '42501';
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

-- A reply-by date must be after today on the Singapore calendar, where every
-- user is; the UTC date lags it by a day from 00:00 to 08:00 Singapore time.

create or replace function request_event_clarification_with_fields(
  p_event_request_id     uuid,
  p_changed_by           uuid,
  p_expected_coordinator uuid,
  p_reason               text,
  p_reply_by_date        date,
  p_requested_fields     text[]
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_requested_fields text[];
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'clarification message is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reason)) > 2000 then
    raise exception 'clarification message must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if p_reply_by_date is not null
     and p_reply_by_date <= (now() at time zone 'Asia/Singapore')::date then
    raise exception 'reply-by date must be in the future'
      using errcode = '22023';
  end if;
  if p_requested_fields is null then
    raise exception 'requested fields must be a list'
      using errcode = '22023';
  end if;
  if exists (
    select field
      from unnest(p_requested_fields) as fields(field)
     where field is null
        or field not in (
       'eventName', 'purpose', 'description', 'proposedStart', 'proposedEnd',
       'expectedAttendance', 'venueRequirements', 'accessibilityRequirements',
       'equipmentRequirements'
     )
  ) then
    raise exception 'one or more clarification amendment fields are invalid'
      using errcode = '22023';
  end if;

  select array_agg(field order by first_position)
    into v_requested_fields
    from (
      select field, min(position) as first_position
        from unnest(p_requested_fields) with ordinality as fields(field, position)
       group by field
    ) deduplicated;
  v_requested_fields := coalesce(v_requested_fields, '{}'::text[]);

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'under_review'::event_request_status,
      'pending_clarification'::event_request_status,
      p_changed_by,
      btrim(p_reason),
      p_expected_coordinator
    );

  update event_requests
     set clarification_reply_by_date = p_reply_by_date
   where id = p_event_request_id
     and status = 'pending_clarification'
  returning * into v_request;

  if not found then
    raise exception 'event request % is no longer pending clarification', p_event_request_id
      using errcode = '40001';
  end if;

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by, reply_by_date, requested_fields)
  values
    (p_event_request_id, 'question', btrim(p_reason), p_changed_by, p_reply_by_date, v_requested_fields);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_requested',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reason),
      'replyByDate', p_reply_by_date,
      'requestedFields', v_requested_fields
    )
  );

  return v_request;
end;
$$;

-- Every function the schema defines, the ones above included. Extension
-- functions (btree_gist's) are left alone: they come from the extension and
-- read no rows. Triggers need no client grant: EXECUTE is checked when the
-- trigger is created, not when it fires. service_role is granted first so the
-- API never depended on the PUBLIC grant being revoked here.
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('grant execute on routine %s to service_role', v_fn);
    execute format('revoke execute on routine %s from public, anon, authenticated', v_fn);
  end loop;
end;
$$;
