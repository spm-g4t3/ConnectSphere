-- Keep the review queue tied to its submission and enforce safety-stage gates
-- at the database boundary, including on resubmission.

create or replace function safety_review_queue()
returns jsonb
language sql
stable
as $$
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

create or replace function safety_review_detail(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event event_requests%rowtype;
begin
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

notify pgrst, 'reload schema';

create or replace function enforce_event_safety_transitions()
returns trigger
language plpgsql
as $$
declare
  v_submission safety_review_submissions%rowtype;
  v_response_outcome text;
  v_response_created_at timestamptz;
  v_latest_approved timestamptz;
  v_latest_safety_review timestamptz;
  v_readiness jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status::text in ('safety_review', 'safety_approved', 'confirmed') then
      raise exception 'New events must enter through the normal planning lifecycle'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not event_request_status_allows(old.status, new.status) then
    raise exception 'Event % has status %, which cannot change to %',
      old.id, old.status, new.status
      using errcode = '55000';
  end if;

  if new.status::text = 'safety_review' then
    select * into v_submission
      from safety_review_submissions
     where event_request_id = old.id
     order by created_at desc, id desc
     limit 1;

    if not found then
      raise exception 'Submit the event through the safety review submission workflow'
        using errcode = '55000';
    end if;

    select max(created_at) into v_latest_approved
      from event_request_status_history
     where event_request_id = old.id
       and new_status::text = 'approved';

    if v_latest_approved is not null and v_submission.created_at < v_latest_approved then
      raise exception 'A new safety review submission is required after the event returns to Approved'
        using errcode = '55000';
    end if;

    perform 1 from bookings
     where event_request_id = old.id
       and status::text in ('pending', 'approved', 'flagged_for_review')
     order by id
       for share;
    perform 1 from equipment_requests
     where event_request_id = old.id
       and status::text <> 'cancelled'
     order by id
       for share;

    v_readiness := event_readiness(old.id, v_submission.no_equipment_confirmed);
    if not (v_readiness ->> 'ready')::boolean then
      raise exception 'This event is not ready for the safety check.'
        using errcode = 'PT409',
              hint = 'EVENT_NOT_READY',
              detail = (
                select coalesce(jsonb_agg(item), '[]'::jsonb)::text
                  from jsonb_array_elements(v_readiness -> 'items') item
                 where not (item ->> 'met')::boolean
              );
    end if;
  elsif old.status::text = 'safety_review'
        and new.status::text in ('safety_approved', 'approved') then
    select outcome, created_at
      into v_response_outcome, v_response_created_at
      from safety_review_responses
     where event_request_id = old.id
     order by created_at desc, id desc
     limit 1;

    if not found then
      raise exception 'A Safety Officer response is required before leaving Safety review'
        using errcode = '55000';
    end if;

    select max(created_at) into v_latest_safety_review
      from event_request_status_history
     where event_request_id = old.id
       and new_status::text = 'safety_review';

    if v_latest_safety_review is not null and v_response_created_at < v_latest_safety_review then
      raise exception 'A new Safety Officer response is required for this review'
        using errcode = '55000';
    end if;

    if (new.status::text = 'safety_approved' and v_response_outcome <> 'approved')
       or (new.status::text = 'approved' and v_response_outcome not in ('changes_requested', 'rejected')) then
      raise exception 'The response outcome does not match the requested status'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists event_requests_safety_transitions on event_requests;
create trigger event_requests_safety_transitions
  before insert or update of status on event_requests
  for each row execute function enforce_event_safety_transitions();

-- Keep the submission record in the same transaction before changing status;
-- the status guard verifies that it is fresh and that its readiness facts pass.
create or replace function submit_event_for_safety_review(
  p_event_request_id       uuid,
  p_coordinator_id         uuid,
  p_note                   text default null,
  p_no_equipment_confirmed boolean default false
)
returns event_requests
language plpgsql
as $$
declare
  v_request    event_requests;
  v_note       text := nullif(btrim(p_note), '');
  v_readiness  jsonb;
  v_confirmed  boolean;
begin
  if p_event_request_id is null then
    raise exception 'submit_event_for_safety_review needs an event request' using errcode = 'null_value_not_allowed';
  end if;

  select * into v_request from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  if p_coordinator_id is null or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned coordinator can submit it for the safety check'
      using errcode = '42501';
  end if;

  if v_request.status::text <> 'approved' then
    raise exception 'This event can be submitted for the safety check only while it is Approved. It is %.',
      case v_request.status::text
        when 'draft'                 then 'a Draft'
        when 'submitted'             then 'Submitted'
        when 'under_review'          then 'Under review'
        when 'pending_clarification' then 'Pending clarification'
        when 'safety_review'         then 'Safety review'
        when 'safety_approved'       then 'Safety approved'
        when 'confirmed'             then 'Confirmed'
        when 'completed'             then 'Completed'
        when 'rejected'              then 'Rejected'
        when 'cancelled'             then 'Cancelled'
        else v_request.status::text
      end
      using errcode = '55000';
  end if;

  if length(v_note) > 2000 then
    raise exception 'The note for the Safety Officer must be 2,000 characters or fewer' using errcode = '22023';
  end if;

  perform 1 from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'approved', 'flagged_for_review')
   order by id
     for share;
  perform 1 from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled'
   order by id
     for share;

  v_readiness := event_readiness(p_event_request_id, p_no_equipment_confirmed);
  if not (v_readiness ->> 'ready')::boolean then
    raise exception 'This event is not ready for the safety check.'
      using errcode = 'PT409',
            hint = 'EVENT_NOT_READY',
            detail = (
              select coalesce(jsonb_agg(item), '[]'::jsonb)::text
                from jsonb_array_elements(v_readiness -> 'items') item
               where not (item ->> 'met')::boolean
            );
  end if;

  v_confirmed := exists (
    select 1 from jsonb_array_elements(v_readiness -> 'items') item
     where item ->> 'key' = 'no_equipment_confirmation'
       and (item ->> 'met')::boolean
  );

  insert into safety_review_submissions (event_request_id, submitted_by, note, no_equipment_confirmed)
  values (p_event_request_id, p_coordinator_id, v_note, v_confirmed);

  v_request := change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'approved',
    p_new_status           => 'safety_review',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_note,
    p_expected_coordinator => p_coordinator_id
  );

  insert into notifications (recipient_id, type, event_request_id, payload)
  select profile.id,
         'event_submitted_for_safety_review',
         v_request.id,
         jsonb_build_object(
           'eventRequestId', v_request.id,
           'eventName', v_request.event_name,
           'coordinatorId', p_coordinator_id,
           'coordinatorName', profile_display_name(p_coordinator_id),
           'startsAt', v_request.proposed_start,
           'submittedAt', now()
         )
    from profiles profile
   where profile.role = 'safety_officer';

  return v_request;
end;
$$;

revoke execute on function enforce_event_safety_transitions() from public, anon, authenticated;
revoke execute on function submit_event_for_safety_review(uuid, uuid, text, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
