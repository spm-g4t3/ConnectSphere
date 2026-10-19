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

  -- An open-ended window (no closing time) is allowed: the Organiser closes it by hand.
  alter table event_requests drop constraint if exists event_requests_registration_window_ordered;
  alter table event_requests
    add constraint event_requests_registration_window_ordered
    check (
      registration_closes_at is null
      or (registration_opens_at is not null and registration_opens_at < registration_closes_at)
    );

  alter table event_requests drop constraint if exists event_requests_enabled_registration_has_window;
  alter table event_requests
    add constraint event_requests_enabled_registration_has_window
    check (not registration_enabled or registration_opens_at is not null);

  -- A start change must go through and notify (see the trigger at the end), so
  -- the dates are checked against the start when saved, not by these constraints.
  alter table event_requests drop constraint if exists event_requests_registration_closes_before_start;
  alter table event_requests drop constraint if exists event_requests_withdrawal_before_start;
end
$$;

create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete restrict,
  attendee_id uuid not null references auth.users (id) on delete restrict,
  registered_at timestamptz not null default now(),
  constraint event_registrations_attendee_once unique (event_request_id, attendee_id)
);

alter table event_registrations
  add column if not exists status text not null default 'registered';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'event_registrations_status_known'
       and conrelid = 'public.event_registrations'::regclass
  ) then
    alter table event_registrations
      add constraint event_registrations_status_known
      check (status in ('registered', 'withdrawn', 'waitlisted'));
  end if;
end
$$;

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
  v_existing_status text;
begin
  if p_attendee_id is null or not exists (
    select 1 from profiles p
     where p.id = p_attendee_id
       and p.role = 'attendee'
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
  if v_event.status <> 'confirmed' then
    return jsonb_build_object('outcome', 'event_not_confirmed', 'status', v_event.status);
  end if;
  if not v_event.registration_enabled
     or v_event.registration_opens_at is null
     or now() < v_event.registration_opens_at
     or (v_event.registration_closes_at is not null and now() >= v_event.registration_closes_at)
     or v_event.proposed_start is null
     or now() >= v_event.proposed_start then
    return jsonb_build_object('outcome', 'registration_closed');
  end if;

  select status into v_existing_status
    from event_registrations
   where event_request_id = p_event_request_id
     and attendee_id = p_attendee_id
   for update;

  if v_existing_status = 'registered' or v_existing_status = 'waitlisted' then
    return jsonb_build_object('outcome', 'already_registered');
  end if;

  select count(*)::integer into v_registered
    from event_registrations
   where event_request_id = p_event_request_id
     and status = 'registered';
  if v_event.registration_capacity is not null
     and v_registered >= v_event.registration_capacity then
    return jsonb_build_object('outcome', 'capacity_reached');
  end if;

  if v_existing_status = 'withdrawn' then
    update event_registrations
       set status = 'registered', registered_at = now()
     where event_request_id = p_event_request_id
       and attendee_id = p_attendee_id
    returning * into v_registration;
  else
    insert into event_registrations (event_request_id, attendee_id)
    values (p_event_request_id, p_attendee_id)
    returning * into v_registration;
  end if;

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

revoke all on function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz) from public, anon, authenticated;
revoke all on function register_for_event(uuid, uuid) from public, anon, authenticated;

grant execute on function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz) to service_role;
grant execute on function register_for_event(uuid, uuid) to service_role;

drop function if exists list_open_registration_events(uuid);

create or replace function open_event_registration_state(
  p_event_ids   uuid[],
  p_attendee_id uuid
)
returns table (
  event_request_id uuid,
  active_count     bigint,
  is_registered    boolean
)
language plpgsql
stable
as $fn$
begin
  if p_attendee_id is null then
    raise exception 'An attendee is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from profiles p
     where p.id = p_attendee_id
       and p.role = 'attendee'
  ) then
    raise exception 'Only an attendee may read registration state'
      using errcode = '42501';
  end if;

  return query
    select r.event_request_id,
           count(*),
           coalesce(bool_or(r.attendee_id = p_attendee_id), false)
      from event_registrations r
     where r.event_request_id = any (coalesce(p_event_ids, '{}'::uuid[]))
       and r.status = 'registered'
     group by r.event_request_id;
end;
$fn$;

revoke execute on function open_event_registration_state(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function open_event_registration_state(uuid[], uuid) to service_role;

-- An earlier version refused a clashing start change; changes flag and notify
-- instead, so a database that ran it is cleaned up here.
drop trigger if exists event_requests_guard_registration_schedule on event_requests;
drop function if exists guard_registration_schedule_on_start_change();

-- The full list from 097 plus registration_schedule_conflict, merged with the
-- live constraint so a migration applied out of order keeps its types.
do $$
declare
  v_def   text;
  v_known text[] := '{}';
  v_ours  text[] := array[
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
    'registration_schedule_conflict'
  ];
  v_item  text;
begin
  select pg_get_constraintdef(c.oid)
    into v_def
    from pg_constraint c
   where c.conrelid = 'notifications'::regclass
     and c.conname = 'notifications_type_known';

  if v_def is not null then
    select coalesce(array_agg(t.m[1] order by t.ord), '{}')
      into v_known
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;

  foreach v_item in array v_ours loop
    if not v_item = any (v_known) then
      v_known := v_known || v_item;
    end if;
  end loop;

  alter table notifications drop constraint if exists notifications_type_known;

  execute format(
    'alter table notifications add constraint notifications_type_known check (type in (%s))',
    (select string_agg(quote_literal(x.item), ', ' order by x.ord)
       from unnest(v_known) with ordinality as x(item, ord))
  );
end;
$$;

-- A start that moves before the registration dates goes through; the Organiser
-- and the coordinator are told which dates now clash so they can adjust them.
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

drop trigger if exists event_requests_notify_registration_schedule_conflict on event_requests;
create trigger event_requests_notify_registration_schedule_conflict
  after update of proposed_start on event_requests
  for each row
  when (new.proposed_start is distinct from old.proposed_start)
  execute function notify_registration_schedule_conflict();

notify pgrst, 'reload schema';
