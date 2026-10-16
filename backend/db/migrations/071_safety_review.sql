-- 071_safety_review.sql
-- SCRUM-490: review event arrangements and record an immutable response.
--
-- Apply after 064_safety_review_submission.sql and 054_equipment_reservation_actions.sql.
-- Every response and its status/arrangement/notification effects are committed
-- by one function call.

alter table bookings add column if not exists review_reason text;
alter table bookings drop constraint if exists bookings_review_reason_known;
alter table bookings
  add constraint bookings_review_reason_known
  check (review_reason in ('setup_or_turnaround_changed', 'safety_review'));

alter table bookings drop constraint if exists bookings_safety_review_response_fk;
alter table bookings drop column if exists safety_review_reason;
alter table bookings drop column if exists safety_review_response_id;

create table if not exists safety_review_responses (
  id                    uuid primary key default gen_random_uuid(),
  event_request_id      uuid not null references event_requests(id) on delete restrict,
  safety_officer_id     uuid not null references auth.users(id) on delete restrict,
  outcome               text not null check (outcome in ('approved', 'changes_requested', 'rejected')),
  note                  text,
  affected_booking_ids  uuid[] not null default '{}',
  equipment_affected    boolean not null default false,
  created_at            timestamptz not null default now(),
  constraint safety_review_response_note_required
    check (outcome = 'approved' or (note is not null and length(btrim(note)) > 0))
);

alter table event_requests
drop constraint if exists event_requests_status_in_lifecycle;
alter table event_requests
add constraint event_requests_status_in_lifecycle check (
  status in (
    'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
    'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'
  )
);

do $$
begin
if exists (
  select 1 from pg_constraint
   where conname = 'event_requests_decided_status_has_decision'
     and conrelid = 'public.event_requests'::regclass
) then
  alter table event_requests
    drop constraint event_requests_decided_status_has_decision;
  alter table event_requests
    add constraint event_requests_decided_status_has_decision check (
      status not in ('approved', 'rejected', 'confirmed', 'completed', 'safety_review', 'safety_approved')
      or decision is not null
    );
end if;

if exists (
  select 1 from pg_constraint
   where conname = 'event_requests_decision_has_decided_status'
     and conrelid = 'public.event_requests'::regclass
) then
  alter table event_requests
    drop constraint event_requests_decision_has_decided_status;
  alter table event_requests
    add constraint event_requests_decision_has_decided_status check (
      decision is null
      or status in (
        'approved', 'rejected', 'confirmed', 'completed', 'cancelled',
        'safety_review', 'safety_approved'
      )
    );
end if;
end
$$;

create index if not exists safety_review_responses_event_created_idx
  on safety_review_responses (event_request_id, created_at, id);

alter table safety_review_responses enable row level security;

create or replace function reject_safety_review_response_edits()
returns trigger
language plpgsql
as $$
begin
  raise exception 'safety review responses are immutable'
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

drop trigger if exists safety_review_responses_immutable on safety_review_responses;
create trigger safety_review_responses_immutable
  before update or delete on safety_review_responses
  for each row execute function reject_safety_review_response_edits();

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
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
      'event_submitted_for_safety_review'
    )
  );

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
        'waitingSeconds', greatest(0, floor(extract(epoch from (now() - coalesce(safety_started.created_at, e.submitted_at, e.created_at))))::integer),
        'venues', coalesce((
          select jsonb_agg(distinct venue.name)
            from bookings booking
            join venues venue on venue.id = booking.venue_id
           where booking.event_request_id = e.id
             and booking.status in ('approved', 'flagged_for_review')
        ), '[]'::jsonb)
      ) order by coalesce(e.submitted_at, e.created_at), e.id
    ),
    '[]'::jsonb
  )
  from event_requests e
  left join profiles coordinator on coordinator.id = e.assigned_coordinator_id
  left join lateral (
    select history.created_at
      from event_request_status_history history
     where history.event_request_id = e.id
       and history.new_status = 'safety_review'
     order by history.created_at desc, history.id desc
     limit 1
  ) safety_started on true
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
      'coordinatorNote', null
    ),
    'venues', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bookingId', booking.id,
          'name', venue.name,
          'location', venue.location,
          'capacity', venue.max_capacity,
          'layout', layout.label,
          'startsAt', booking.starts_at,
          'endsAt', booking.ends_at,
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

create or replace function respond_to_safety_review(
  p_event_request_id uuid,
  p_safety_officer_id uuid,
  p_outcome text,
  p_note text,
  p_affected_booking_ids uuid[],
  p_equipment_affected boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_event event_requests%rowtype;
  v_response safety_review_responses%rowtype;
  v_equipment equipment_requests%rowtype;
  v_new_status event_request_status;
  v_booking_ids uuid[] := coalesce(p_affected_booking_ids, '{}');
begin
  if p_safety_officer_id is null
     or not exists (
       select 1 from profiles
        where id = p_safety_officer_id and role = 'safety_officer'
     ) then
    raise exception 'Only Safety Officers can respond to a safety review'
      using errcode = 'insufficient_privilege';
  end if;

  if p_outcome is null or p_outcome not in ('approved', 'changes_requested', 'rejected') then
    raise exception 'Choose approve, request changes or reject the safety arrangement'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_outcome <> 'approved' and (p_note is null or length(btrim(p_note)) = 0) then
    raise exception 'A note is required for this safety review response'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_outcome = 'approved'
     and (cardinality(coalesce(p_affected_booking_ids, '{}')) > 0
          or coalesce(p_equipment_affected, false)) then
    raise exception 'Arrangements can be marked as affected only when requesting changes or rejecting'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_event
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_event.status <> 'safety_review' then
    raise exception 'Event % has status %, so it cannot receive a safety review response',
      p_event_request_id, v_event.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if cardinality(v_booking_ids) <> (
       select count(distinct selected_id)
         from unnest(v_booking_ids) selected_id
     ) then
    raise exception 'A venue booking may be selected only once'
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
      from unnest(v_booking_ids) selected(id)
      left join bookings booking
        on booking.id = selected.id
       and booking.event_request_id = p_event_request_id
       and booking.status in ('approved', 'flagged_for_review')
     where booking.id is null
  ) then
    raise exception 'A selected venue booking does not belong to this event or is no longer booked'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_equipment_affected then
    select * into v_equipment
      from equipment_requests
     where event_request_id = p_event_request_id
       and status = 'arranged'
     order by created_at, id
     limit 1
     for update;

    if not found then
      raise exception 'This event has no arranged equipment request to return for review'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_new_status := case
    when p_outcome = 'approved' then 'safety_approved'::event_request_status
    else 'approved'::event_request_status
  end;

  insert into safety_review_responses (
    event_request_id, safety_officer_id, outcome, note,
    affected_booking_ids, equipment_affected
  ) values (
    p_event_request_id, p_safety_officer_id, p_outcome, nullif(btrim(p_note), ''),
    v_booking_ids, coalesce(p_equipment_affected, false)
  ) returning * into v_response;

  if cardinality(v_booking_ids) > 0 then
    update bookings
       set status = 'flagged_for_review',
           review_reason = 'safety_review',
           flagged_at = now(),
           flagged_by = p_safety_officer_id
     where event_request_id = p_event_request_id
       and id = any(v_booking_ids)
       and status in ('approved', 'flagged_for_review');

    if not found then
      raise exception 'The selected venue bookings changed during the safety review'
        using errcode = 'serialization_failure';
    end if;
  end if;

  if p_equipment_affected then
    perform release_equipment_reservations(
      p_event_request_id, null, 'Safety review', p_safety_officer_id
    );

    update equipment_requests
       set status = 'pending_review'
     where id = v_equipment.id
       and status = 'arranged';

    if not found then
      raise exception 'The equipment request changed during the safety review'
        using errcode = 'serialization_failure';
    end if;

    insert into equipment_review_history (equipment_request_id, action, user_id, note)
    values (v_equipment.id, 'interrupted', p_safety_officer_id, 'Returned for review after Safety review');
  end if;

  update event_requests
     set status = v_new_status
   where id = p_event_request_id
     and status = 'safety_review';

  if not found then
    raise exception 'Event % changed status during the safety review', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'safety_review', v_new_status, p_safety_officer_id, nullif(btrim(p_note), ''));

  insert into notifications (recipient_id, type, event_request_id, payload)
  select recipient.id, 'safety_review_response', p_event_request_id,
         jsonb_build_object(
           'eventName', v_event.event_name,
           'outcome', p_outcome,
           'note', nullif(btrim(p_note), ''),
           'responseId', v_response.id,
           'respondedAt', v_response.created_at
         )
    from (
      select v_event.organiser_id as id
      union
      select v_event.assigned_coordinator_id
       where v_event.assigned_coordinator_id is not null
    ) recipient;

  if cardinality(v_booking_ids) > 0 then
    insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
    select staff.id, 'safety_booking_flagged', booking.id, p_event_request_id,
           jsonb_build_object(
             'eventName', v_event.event_name,
             'venueName', venue.name,
             'startsAt', booking.starts_at,
             'endsAt', booking.ends_at,
             'reason', 'Safety review',
             'responseId', v_response.id
           )
      from bookings booking
      join venues venue on venue.id = booking.venue_id
      cross join profiles staff
     where booking.id = any(v_booking_ids)
       and staff.role = 'venue_staff';
  end if;

  if p_equipment_affected then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select staff.id, 'safety_equipment_review', p_event_request_id,
           jsonb_build_object(
             'eventName', v_event.event_name,
             'equipmentRequestId', v_equipment.id,
             'responseId', v_response.id
           )
      from profiles staff
     where staff.role = 'technical_support_staff';
  end if;

  return jsonb_build_object(
    'id', v_response.id,
    'eventRequestId', v_response.event_request_id,
    'outcome', v_response.outcome,
    'safetyOfficerId', v_response.safety_officer_id,
    'note', v_response.note,
    'affectedBookingIds', v_response.affected_booking_ids,
    'equipmentAffected', v_response.equipment_affected,
    'createdAt', v_response.created_at,
    'eventStatus', v_new_status
  );
end;
$$;

revoke execute on function safety_review_queue() from public, anon, authenticated;
revoke execute on function safety_review_detail(uuid) from public, anon, authenticated;
revoke execute on function respond_to_safety_review(uuid, uuid, text, text, uuid[], boolean)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
