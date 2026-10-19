-- Settings live on the event row so a status change, including a return from
-- confirmed to approved, cannot discard them.

alter table event_requests
  add column if not exists registration_enabled boolean not null default false,
  add column if not exists registration_opens_at timestamptz,
  add column if not exists registration_closes_at timestamptz,
  add column if not exists registration_capacity integer,
  add column if not exists registration_withdrawal_deadline timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_registration_capacity_positive'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_registration_capacity_positive
      check (registration_capacity is null or registration_capacity > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_registration_window_ordered'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_registration_window_ordered
      check (
        (registration_opens_at is null and registration_closes_at is null)
        or (
          registration_opens_at is not null
          and registration_closes_at is not null
          and registration_opens_at < registration_closes_at
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_enabled_registration_has_window'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_enabled_registration_has_window
      check (
        not registration_enabled
        or (registration_opens_at is not null and registration_closes_at is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_registration_closes_before_start'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_registration_closes_before_start
      check (
        registration_closes_at is null
        or (
          proposed_start is not null
          and registration_closes_at <= proposed_start
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_withdrawal_before_start'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_withdrawal_before_start
      check (
        registration_withdrawal_deadline is null
        or (
          proposed_start is not null
          and registration_withdrawal_deadline <= proposed_start
        )
      );
  end if;
end
$$;

create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete restrict,
  attendee_id uuid not null references auth.users (id) on delete restrict,
  registered_at timestamptz not null default now(),
  constraint event_registrations_attendee_once unique (event_request_id, attendee_id)
);

create index if not exists idx_event_registrations_event
  on event_registrations (event_request_id, registered_at);

alter table event_registrations enable row level security;

create table if not exists event_registration_settings_history (
  id uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete restrict,
  changed_by uuid not null references auth.users (id) on delete restrict,
  old_values jsonb not null,
  new_values jsonb not null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_registration_settings_history_event
  on event_registration_settings_history (event_request_id, changed_at desc);

alter table event_registration_settings_history enable row level security;

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
  select * into v_event
    from event_requests
  where id = p_event_request_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_event.organiser_id <> p_user_id then
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
  if p_opens_at is null then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationOpensAt', 'message', 'An opening date and time is required.'
    ));
  end if;
  if p_closes_at is null then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationClosesAt', 'message', 'A closing date and time is required.'
    ));
  end if;
  if p_opens_at is not null and p_closes_at is not null and p_opens_at >= p_closes_at then
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'field', 'registrationOpensAt', 'message', 'Must be before the closing date and time.'
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

  select count(*)::integer into v_registered
    from event_registrations
  where event_request_id = p_event_request_id;

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

create or replace function register_for_event(
  p_event_request_id uuid,
  p_attendee_id uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_registered integer;
  v_registration event_registrations%rowtype;
begin
  select * into v_event
    from event_requests
  where id = p_event_request_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_event.status <> 'confirmed' then
    return jsonb_build_object('outcome', 'event_not_confirmed', 'status', v_event.status);
  end if;
  if not v_event.registration_enabled
    or v_event.registration_opens_at is null
    or v_event.registration_closes_at is null
    or now() < v_event.registration_opens_at
    or now() >= v_event.registration_closes_at then
    return jsonb_build_object('outcome', 'registration_closed');
  end if;

  if exists (
    select 1 from event_registrations
    where event_request_id = p_event_request_id
      and attendee_id = p_attendee_id
  ) then
    return jsonb_build_object('outcome', 'already_registered');
  end if;

  select count(*)::integer into v_registered
    from event_registrations
  where event_request_id = p_event_request_id;
  if v_event.registration_capacity is not null
    and v_registered >= v_event.registration_capacity then
    return jsonb_build_object('outcome', 'capacity_reached');
  end if;

  insert into event_registrations (event_request_id, attendee_id)
  values (p_event_request_id, p_attendee_id)
  returning * into v_registration;

  return jsonb_build_object(
    'outcome', 'registered',
    'registration', jsonb_build_object(
      'id', v_registration.id,
      'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id,
      'registeredAt', v_registration.registered_at
    ),
    'registeredCount', v_registered + 1
  );
end;
$$;

create or replace function list_open_registration_events(p_attendee_id uuid)
returns table (
  id uuid,
  event_name text,
  description text,
  proposed_start timestamptz,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  registration_capacity integer,
  registered_count integer,
  is_registered boolean
)
language sql
stable
set search_path = public
as $$
  select
    er.id,
    er.event_name,
    er.description,
    er.proposed_start,
    er.registration_opens_at,
    er.registration_closes_at,
    er.registration_capacity,
    counts.registered_count,
    exists (
      select 1 from event_registrations own
      where own.event_request_id = er.id
        and own.attendee_id = p_attendee_id
    )
  from event_requests er
  cross join lateral (
    select count(*)::integer as registered_count
      from event_registrations r
    where r.event_request_id = er.id
  ) counts
  where er.status = 'confirmed'
    and er.registration_enabled
    and er.registration_opens_at <= now()
    and er.registration_closes_at > now()
    and (er.registration_capacity is null or counts.registered_count < er.registration_capacity)
  order by er.proposed_start, er.event_name;
$$;

revoke all on function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz) from public, anon, authenticated;
revoke all on function register_for_event(uuid, uuid) from public, anon, authenticated;
revoke all on function list_open_registration_events(uuid) from public, anon, authenticated;

grant execute on function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz) to service_role;
grant execute on function register_for_event(uuid, uuid) to service_role;
grant execute on function list_open_registration_events(uuid) to service_role;
