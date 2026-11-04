-- Baseline 07: the operational safety check: submissions, responses and closures, the
-- readiness check, the review functions and the safety-status trigger on event_requests.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

create table safety_review_submissions (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  submitted_by uuid not null,
  note text,
  no_equipment_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint safety_review_submissions_pkey primary key (id),
  constraint safety_review_submissions_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint safety_review_submissions_submitted_by_fkey foreign key (submitted_by) references auth.users(id),
  constraint safety_review_submissions_note_check check ((note is null) or ((length(btrim(note)) >= 1) and (length(btrim(note)) <= 2000)))
);
create index idx_safety_review_submissions_event_created on safety_review_submissions (event_request_id, created_at);
alter table safety_review_submissions enable row level security;

create table safety_review_responses (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  safety_officer_id uuid not null,
  outcome text not null,
  note text,
  affected_booking_ids uuid[] not null default '{}'::uuid[],
  equipment_affected boolean not null default false,
  created_at timestamptz not null default now(),
  constraint safety_review_responses_pkey primary key (id),
  constraint safety_review_responses_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint safety_review_responses_safety_officer_id_fkey foreign key (safety_officer_id) references auth.users(id) on delete restrict,
  constraint safety_review_response_note_required check ((outcome = 'approved'::text) or ((note is not null) and (length(btrim(note)) > 0))),
  constraint safety_review_responses_outcome_check check (outcome = any (array['approved'::text, 'changes_requested'::text, 'rejected'::text]))
);
create index safety_review_responses_event_created_idx on safety_review_responses (event_request_id, created_at, id);
alter table safety_review_responses enable row level security;

create table safety_review_closures (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  safety_review_submission_id uuid not null,
  closed_by uuid not null,
  reason text not null,
  closed_at timestamptz not null default now(),
  constraint safety_review_closures_pkey primary key (id),
  constraint safety_review_closure_submission_once unique (safety_review_submission_id),
  constraint safety_review_closures_closed_by_fkey foreign key (closed_by) references auth.users(id) on delete restrict,
  constraint safety_review_closures_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint safety_review_closures_safety_review_submission_id_fkey foreign key (safety_review_submission_id) references safety_review_submissions(id) on delete restrict,
  constraint safety_review_closure_reason_nonblank check ((reason = btrim(reason)) and ((length(reason) >= 1) and (length(reason) <= 4000)))
);
alter table safety_review_closures enable row level security;

-- Who is told, and whether an event is ready to submit.

create or replace function safety_officer_recipients()
returns setof uuid
language sql
stable
as $$
  select p.id from profiles p where p.role = 'safety_officer'
$$;
revoke execute on function safety_officer_recipients() from public, anon, authenticated;

create or replace function event_readiness(
  p_event_request_id       uuid,
  p_no_equipment_confirmed boolean default false
)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_event        event_requests;
  v_items        jsonb := '[]'::jsonb;
  v_booking      record;
  v_equipment    record;
  v_any_booking  boolean := false;
  v_any_request  boolean := false;
  v_covers       boolean;
  v_now          timestamptz;
begin
  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  for v_booking in
    select b.id, b.status::text as status, b.starts_at, b.ends_at, v.name as venue_name
      from bookings b
      join venues v on v.id = b.venue_id
     where b.event_request_id = p_event_request_id
       and b.status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
     order by b.starts_at, b.id
  loop
    v_any_booking := true;
    v_covers := v_event.proposed_start is not null and v_event.proposed_end is not null
                and v_booking.starts_at <= v_event.proposed_start
                and v_booking.ends_at >= v_event.proposed_end;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key',       'venue',
      'met',       v_booking.status = 'approved' and v_covers,
      'detail',    case
                     when v_booking.status = 'pending'            then 'Awaiting approval'
                     when v_booking.status = 'conflicting'        then 'Conflicting, awaiting a decision'
                     when v_booking.status = 'flagged_for_review' then 'Flagged for review'
                     when not v_covers                            then 'Does not cover the event''s start to end'
                     else 'Approved'
                   end,
      'bookingId', v_booking.id,
      'venueName', v_booking.venue_name,
      'startsAt',  v_booking.starts_at,
      'endsAt',    v_booking.ends_at
    ));
  end loop;

  if not v_any_booking then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key', 'venue', 'met', false, 'detail', 'No venue booking'));
  end if;

  for v_equipment in
    select r.id, r.status::text as status
      from equipment_requests r
     where r.event_request_id = p_event_request_id
       and r.status::text <> 'cancelled'
     order by r.created_at, r.id
  loop
    v_any_request := true;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key',                'equipment',
      'met',                v_equipment.status = 'arranged',
      'detail',             equipment_request_status_words(v_equipment.status),
      'equipmentRequestId', v_equipment.id
    ));
  end loop;

  if not v_any_request then
    -- btrim alone misses tabs and line breaks in otherwise blank requirements.
    if coalesce(v_event.equipment_requirements, '') !~ '[^[:space:]]' then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key', 'equipment', 'met', true, 'detail', 'No equipment requested'));
    else
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key',                   'no_equipment_confirmation',
        'met',                   coalesce(p_no_equipment_confirmed, false),
        'detail',                'Confirm that this event needs no equipment',
        'organiserRequirements', v_event.equipment_requirements
      ));
    end if;
  end if;

  -- Recheck the wall clock when called inside a transaction that may have waited.
  v_now := clock_timestamp();
  v_items := v_items || jsonb_build_array(jsonb_build_object(
    'key',    'date',
    'met',    v_event.proposed_start is not null and v_event.proposed_end is not null
              and v_now < v_event.proposed_start,
    'detail', case
                when v_event.proposed_start is null then 'The event has no start date'
                when v_event.proposed_end is null   then 'The event has no end date'
                when v_event.proposed_start <= v_now then 'The event''s start has passed'
                else 'Starts in the future'
              end
  ));

  return jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'ready',          not exists (select 1 from jsonb_array_elements(v_items) i where not (i ->> 'met')::boolean),
    'items',          v_items
  );
end;
$$;
revoke execute on function event_readiness(uuid, boolean) from public, anon, authenticated;

-- Submitting for review; submissions and responses are records and never change.

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
revoke execute on function submit_event_for_safety_review(uuid, uuid, text, boolean) from public, anon, authenticated;

create or replace function refuse_safety_review_submission_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'safety review submissions cannot be changed or deleted' using errcode = '42501';
end;
$$;

create trigger safety_review_submissions_immutable
  before delete or update on safety_review_submissions
  for each row
  execute function refuse_safety_review_submission_mutation();

-- The safety officer's queue, detail, history and response.

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
revoke execute on function safety_review_queue() from public, anon, authenticated;

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
revoke execute on function safety_review_detail(uuid) from public, anon, authenticated;

create or replace function safety_review_history()
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
revoke execute on function safety_review_history() from public, anon, authenticated;

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
revoke execute on function respond_to_safety_review(uuid, uuid, text, text, uuid[], boolean) from public, anon, authenticated;

create or replace function reject_safety_review_response_edits()
returns trigger
language plpgsql
as $$
begin
  raise exception 'safety review responses are immutable'
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create trigger safety_review_responses_immutable
  before delete or update on safety_review_responses
  for each row
  execute function reject_safety_review_response_edits();

-- Guards every status change: only allowed transitions, and the safety statuses only
-- with the matching submission or response on record.

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
  v_change_closure_exists boolean;
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
    select exists (
      select 1
        from safety_review_submissions submission
        join safety_review_closures closure
          on closure.safety_review_submission_id = submission.id
       where submission.event_request_id = old.id
         and submission.id = (
           select latest.id
             from safety_review_submissions latest
            where latest.event_request_id = old.id
            order by latest.created_at desc, latest.id desc
            limit 1
         )
         and new.status::text = 'approved'
    ) into v_change_closure_exists;

    if v_change_closure_exists then
      return new;
    end if;

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
revoke execute on function enforce_event_safety_transitions() from public, anon, authenticated;

create trigger event_requests_safety_transitions
  before insert or update of status on event_requests
  for each row
  execute function enforce_event_safety_transitions();
