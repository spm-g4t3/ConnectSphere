-- Baseline 08: attendee registration: registrations, settings history, the registrations
-- view and the registration functions. Only the API (service_role) reads or writes them.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

create table event_registrations (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  attendee_id uuid not null,
  registered_at timestamptz not null default now(),
  status text not null default 'registered',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_registrations_pkey primary key (id),
  constraint event_registrations_attendee_once unique (event_request_id, attendee_id),
  constraint event_registrations_attendee_id_fkey foreign key (attendee_id) references auth.users(id) on delete restrict,
  constraint event_registrations_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint event_registrations_status_known check (status = any (array['registered'::text, 'withdrawn'::text, 'waitlisted'::text, 'cancelled'::text]))
);
create index idx_event_registrations_event on event_registrations (event_request_id, registered_at);
alter table event_registrations enable row level security;

create trigger event_registrations_set_updated_at
  before update on event_registrations
  for each row
  execute function set_updated_at();

revoke all on event_registrations from public, anon, authenticated;

create table event_registration_settings_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  changed_by uuid not null,
  old_values jsonb not null,
  new_values jsonb not null,
  changed_at timestamptz not null default now(),
  constraint event_registration_settings_history_pkey primary key (id),
  constraint event_registration_settings_history_changed_by_fkey foreign key (changed_by) references auth.users(id) on delete restrict,
  constraint event_registration_settings_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict
);
create index idx_registration_settings_history_event on event_registration_settings_history (event_request_id, changed_at desc);
alter table event_registration_settings_history enable row level security;

revoke all on event_registration_settings_history from public, anon, authenticated;

-- The old table name, kept as a read-only view for callers that still use it.
create view registrations with (security_invoker = true) as
  select id, event_request_id, attendee_id, status, created_at, updated_at
    from event_registrations;
revoke all on registrations from public, anon, authenticated, service_role;
grant select on registrations to service_role;

-- Registration settings and their history.

create or replace function setup_event_registration(
  p_event_request_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_capacity integer,
  p_withdrawal_deadline timestamptz
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_registered integer;
  v_details jsonb := '[]'::jsonb;
  v_old jsonb;
  v_new jsonb;
begin
  if p_user_id is null or not exists (
    select 1 from profiles p
     where p.id = p_user_id
       and p.role = 'event_organiser'
  ) then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_event.organiser_id is distinct from p_user_id then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    return jsonb_build_object('outcome', 'status_not_allowed', 'status', v_event.status);
  end if;

  if p_enabled is null then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationEnabled', 'message', 'Choose whether registration is on or off.'
    ));
  end if;
  -- The opening time is required while registration is on. The closing time is
  -- optional: with none, registration stays open until the Organiser switches it off.
  if p_opens_at is null and (p_enabled or p_closes_at is not null) then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationOpensAt', 'message', 'An opening date and time is required.'
    ));
  end if;
  if p_opens_at is not null and p_closes_at is not null and p_opens_at >= p_closes_at then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationOpensAt', 'message', 'Must be before the closing date and time.'
    ));
  end if;
  -- Checked only while registration is on: a start change can leave the dates
  -- clashing, and switching registration off must still be allowed then.
  if p_enabled then
    -- With a closing time, opening before closing before the start already holds;
    -- an open-ended window still has to open before the event starts.
    if p_opens_at is not null and p_closes_at is null and v_event.proposed_start is null then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'proposedStart', 'message', 'Set the event start before setting the registration opening time.'
      ));
    elsif p_opens_at is not null and p_closes_at is null and p_opens_at >= v_event.proposed_start then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'registrationOpensAt', 'message', 'Must be before the event start.'
      ));
    end if;
    if p_closes_at is not null and v_event.proposed_start is null then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'proposedStart', 'message', 'Set the event start before setting the registration closing time.'
      ));
    elsif p_closes_at is not null and p_closes_at > v_event.proposed_start then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'registrationClosesAt', 'message', 'Must be no later than the event start.'
      ));
    end if;
    if p_withdrawal_deadline is not null and v_event.proposed_start is null then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'proposedStart', 'message', 'Set the event start before setting the withdrawal deadline.'
      ));
    elsif p_withdrawal_deadline is not null and p_withdrawal_deadline > v_event.proposed_start then
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'field', 'registrationWithdrawalDeadline', 'message', 'Must be no later than the event start.'
      ));
    end if;
  end if;

  select count(*)::integer into v_registered
    from event_registrations
   where event_request_id = p_event_request_id
     and status = 'registered';

  if p_capacity is not null and p_capacity <= 0 then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationCapacity', 'message', 'Must be a whole number above zero.'
    ));
  elsif p_capacity is not null and p_capacity < v_registered then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationCapacity',
      'message', format('Cannot be below the %s attendees already registered.', v_registered)
    ));
  end if;

  if jsonb_array_length(v_details) > 0 then
    return jsonb_build_object('outcome', 'invalid', 'details', v_details);
  end if;

  v_old := jsonb_build_object(
    'enabled', v_event.registration_enabled,
    'opensAt', v_event.registration_opens_at,
    'closesAt', v_event.registration_closes_at,
    'capacity', v_event.registration_capacity,
    'withdrawalDeadline', v_event.registration_withdrawal_deadline
  );
  v_new := jsonb_build_object(
    'enabled', p_enabled,
    'opensAt', p_opens_at,
    'closesAt', p_closes_at,
    'capacity', p_capacity,
    'withdrawalDeadline', p_withdrawal_deadline
  );

  update event_requests
     set registration_enabled = p_enabled,
         registration_opens_at = p_opens_at,
         registration_closes_at = p_closes_at,
         registration_capacity = p_capacity,
         registration_withdrawal_deadline = p_withdrawal_deadline
   where id = p_event_request_id;

  if v_old is distinct from v_new then
    insert into event_registration_settings_history (
      event_request_id, changed_by, old_values, new_values
    ) values (
      p_event_request_id, p_user_id, v_old, v_new
    );
  end if;

  return jsonb_build_object(
    'outcome', 'saved',
    'settings', v_new,
    'registeredCount', v_registered
  );
end;
$$;
revoke execute on function setup_event_registration(uuid, uuid, boolean, timestamp with time zone, timestamp with time zone, integer, timestamp with time zone) from public, anon, authenticated;

-- Attendees are told when a registered event moves.

create or replace function notify_registration_schedule_conflict()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_fields  jsonb := '[]'::jsonb;
  v_payload jsonb;
begin
  if not new.registration_enabled or new.proposed_start is null then
    return null;
  end if;

  if new.registration_opens_at >= new.proposed_start then
    v_fields := v_fields || to_jsonb('registrationOpensAt'::text);
  end if;
  if new.registration_closes_at > new.proposed_start then
    v_fields := v_fields || to_jsonb('registrationClosesAt'::text);
  end if;
  if new.registration_withdrawal_deadline > new.proposed_start then
    v_fields := v_fields || to_jsonb('registrationWithdrawalDeadline'::text);
  end if;

  if jsonb_array_length(v_fields) = 0 then
    return null;
  end if;

  v_payload := jsonb_build_object(
    'eventName', new.event_name,
    'newStart', new.proposed_start,
    'fields', v_fields
  );

  insert into notifications (recipient_id, type, event_request_id, payload)
  values (new.organiser_id, 'registration_schedule_conflict', new.id, v_payload);

  if new.assigned_coordinator_id is not null
     and new.assigned_coordinator_id is distinct from new.organiser_id then
    insert into notifications (recipient_id, type, event_request_id, payload)
    values (new.assigned_coordinator_id, 'registration_schedule_conflict', new.id, v_payload);
  end if;

  return null;
end;
$fn$;

create trigger event_requests_notify_registration_schedule_conflict
  after update of proposed_start on event_requests
  for each row
  when ((new.proposed_start is distinct from old.proposed_start))
  execute function notify_registration_schedule_conflict();

-- Registering, and the state the attendee pages read.

create or replace function assert_event_registration_eligible(
  p_event_request_id uuid,
  p_attendee_id uuid
)
returns void
language plpgsql
as $$
declare
  v_event record;
  v_now timestamptz;
begin
  if p_attendee_id is null or p_event_request_id is null then
    raise exception 'An attendee and event are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from profiles where id = p_attendee_id and role = 'attendee'
  ) then
    raise exception 'This action is restricted to Attendees' using errcode = '42501';
  end if;

  select e.status, e.registration_enabled, e.registration_opens_at,
         e.registration_closes_at, e.proposed_start
    into v_event
    from event_requests e
   where e.id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  -- Read the clock after waiting for the lock; transaction-start time can be stale.
  v_now := clock_timestamp();

  if v_event.status::text is distinct from 'confirmed' then
    raise exception 'Registration requires a Confirmed event'
      using errcode = '55000', hint = 'EVENT_NOT_CONFIRMED';
  end if;
  if v_event.registration_enabled is distinct from true then
    raise exception 'Registration is disabled for this event'
      using errcode = '55000', hint = 'REGISTRATION_DISABLED';
  end if;
  if v_event.registration_opens_at is null or v_event.proposed_start is null then
    raise exception 'Registration dates are not configured for this event'
      using errcode = '55000', hint = 'REGISTRATION_DATES_MISSING';
  end if;
  if v_now < v_event.registration_opens_at then
    raise exception 'Registration has not opened yet'
      using errcode = '55000', hint = 'REGISTRATION_NOT_OPEN';
  end if;
  -- SCRUM-494 permits no closing time: registration then ends when disabled or at the event start.
  if v_event.registration_closes_at is not null and v_now >= v_event.registration_closes_at then
    raise exception 'Registration has closed for this event'
      using errcode = '55000', hint = 'REGISTRATION_CLOSED';
  end if;
  if v_now >= v_event.proposed_start then
    raise exception 'Registration is closed because the event has started'
      using errcode = '55000', hint = 'EVENT_STARTED';
  end if;

  -- No additional eligibility rules are configured; authenticated Attendees qualify.
end;
$$;
revoke execute on function assert_event_registration_eligible(uuid, uuid) from public, anon, authenticated;

create or replace function register_for_event(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_capacity integer;
  v_count bigint;
  v_registration event_registrations;
begin
  -- This takes the event lock and reads the clock after any wait. Refusals
  -- reveal no more about an unavailable event than the browse read does.
  begin
    perform assert_event_registration_eligible(p_event_request_id, p_attendee_id);
  exception
    when no_data_found or object_not_in_prerequisite_state then
      return jsonb_build_object('outcome', 'not_found');
    when insufficient_privilege then
      return jsonb_build_object('outcome', 'forbidden');
  end;

  select * into v_registration from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id for update;
  if v_registration.status = 'registered' then
    return jsonb_build_object('outcome', 'already_registered');
  end if;

  if v_registration.status = 'waitlisted' then
    return jsonb_build_object('outcome', 'already_waitlisted');
  end if;
  if v_registration.status = 'cancelled' then
    return jsonb_build_object('outcome', 'registration_cancelled');
  end if;

  select registration_capacity into v_capacity from event_requests where id = p_event_request_id;
  select count(*) into v_count from event_registrations
   where event_request_id = p_event_request_id and status = 'registered';
  if v_capacity is not null and v_count >= v_capacity then
    return jsonb_build_object('outcome', 'capacity_reached');
  end if;

  if v_registration.id is not null then
    update event_registrations set status = 'registered', registered_at = clock_timestamp()
     where id = v_registration.id and status = 'withdrawn' returning * into v_registration;
    if not found then
      return jsonb_build_object('outcome', 'registration_cancelled');
    end if;
  else
    insert into event_registrations (event_request_id, attendee_id)
    values (p_event_request_id, p_attendee_id)
    on conflict (event_request_id, attendee_id) do nothing
    returning * into v_registration;
    if not found then
      return jsonb_build_object('outcome', 'already_registered');
    end if;
  end if;

  return jsonb_build_object(
    'outcome', 'registered', 'registeredCount', v_count + 1,
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'registeredAt', v_registration.registered_at,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;
revoke execute on function register_for_event(uuid, uuid) from public, anon, authenticated;

create function open_event_registration_state(p_event_ids uuid[], p_attendee_id uuid)
returns table (event_request_id uuid, active_count bigint, is_registered boolean, registration_status text)
language plpgsql
stable
as $fn$
begin
  if p_attendee_id is null then
    raise exception 'An attendee is required' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_attendee_id and role = 'attendee') then
    raise exception 'Only an attendee may read registration state' using errcode = '42501';
  end if;

  return query
    select r.event_request_id,
           count(*) filter (where r.status = 'registered'),
           coalesce(bool_or(r.attendee_id = p_attendee_id and r.status = 'registered'), false),
           max(r.status) filter (where r.attendee_id = p_attendee_id)
      from event_registrations r
     where r.event_request_id = any(coalesce(p_event_ids, '{}'::uuid[]))
       and (r.status = 'registered'
            or (r.attendee_id = p_attendee_id and r.status in ('waitlisted', 'cancelled')))
     group by r.event_request_id;
end;
$fn$;
revoke execute on function open_event_registration_state(uuid[], uuid) from public, anon, authenticated;
