-- Migration 027: event waiting lists.
-- The Organiser switches a waiting list on with the other registration settings.
-- While the event is full, an attendee can join it; a released place (a
-- withdrawal, a higher capacity) goes to the longest-waiting attendee, who is
-- notified. Every writer takes the event row lock first, so promotions are
-- serialised with registrations and with each other: one place, one promotion.
-- A position is derived from waitlisted_at, never stored.

-- Off by default: an existing event gains no waiting list until its Organiser
-- switches one on, through setup_event_registration like the other settings.
alter table event_requests
  add column if not exists registration_waitlist_enabled boolean not null default false;

alter table event_registrations
  add column if not exists waitlisted_at timestamptz;

-- No row should be waitlisted yet; any that is keeps its place by registered_at.
update event_registrations
   set waitlisted_at = registered_at
 where status = 'waitlisted' and waitlisted_at is null;

-- Entering the list stamps the queue time, whoever writes the row; leaving
-- keeps it as history. An explicit time (a backfill, a test) is kept.
create or replace function stamp_event_registration_waitlisted_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'waitlisted'
     and (tg_op = 'INSERT' and new.waitlisted_at is null
          or tg_op = 'UPDATE' and old.status is distinct from 'waitlisted'
             and new.waitlisted_at is not distinct from old.waitlisted_at) then
    new.waitlisted_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists event_registrations_stamp_waitlisted_at on event_registrations;
create trigger event_registrations_stamp_waitlisted_at
  before insert or update of status on event_registrations
  for each row
  execute function stamp_event_registration_waitlisted_at();

alter table event_registrations drop constraint if exists event_registrations_waitlisted_has_time;
alter table event_registrations
  add constraint event_registrations_waitlisted_has_time
  check ((status <> 'waitlisted') or (waitlisted_at is not null));

-- Queue order within an event: waitlisted_at, then id. Joins take the event
-- lock and read the clock after it, so times rise in join order; id only breaks
-- an exact tie, and never changes, so the order is total and stable. One row per
-- attendee and event (event_registrations_attendee_once) keeps duplicates out.
create index if not exists idx_event_registrations_waitlist
  on event_registrations (event_request_id, waitlisted_at, id)
  where status = 'waitlisted';

-- An attendee's own places, for My Registrations.
create index if not exists idx_event_registrations_attendee_waitlist
  on event_registrations (attendee_id, waitlisted_at desc)
  where status = 'waitlisted';

-- The registration-window rule, shared by registering and by promotion so a
-- place is only ever handed out while registration is open.

create or replace function registration_closed_reason(p_event event_requests, p_now timestamptz)
returns text
language plpgsql
stable
as $$
begin
  if p_event.status::text is distinct from 'confirmed' then
    return 'EVENT_NOT_CONFIRMED';
  end if;
  if p_event.registration_enabled is distinct from true then
    return 'REGISTRATION_DISABLED';
  end if;
  if p_event.registration_opens_at is null or p_event.proposed_start is null then
    return 'REGISTRATION_DATES_MISSING';
  end if;
  if p_now < p_event.registration_opens_at then
    return 'REGISTRATION_NOT_OPEN';
  end if;
  -- SCRUM-494 permits no closing time: registration then ends when disabled or at the event start.
  if p_event.registration_closes_at is not null and p_now >= p_event.registration_closes_at then
    return 'REGISTRATION_CLOSED';
  end if;
  if p_now >= p_event.proposed_start then
    return 'EVENT_STARTED';
  end if;
  return null;
end;
$$;
revoke execute on function registration_closed_reason(event_requests, timestamptz) from public, anon, authenticated;

create or replace function assert_event_registration_eligible(
  p_event_request_id uuid,
  p_attendee_id uuid
)
returns void
language plpgsql
as $$
declare
  v_event event_requests;
  v_reason text;
begin
  if p_attendee_id is null or p_event_request_id is null then
    raise exception 'An attendee and event are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from profiles where id = p_attendee_id and role = 'attendee'
  ) then
    raise exception 'This action is restricted to Attendees' using errcode = '42501';
  end if;

  select * into v_event
    from event_requests e
   where e.id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  -- Read the clock after waiting for the lock; transaction-start time can be stale.
  v_reason := registration_closed_reason(v_event, clock_timestamp());
  if v_reason is not null then
    raise exception '%', case v_reason
        when 'EVENT_NOT_CONFIRMED' then 'Registration requires a Confirmed event'
        when 'REGISTRATION_DISABLED' then 'Registration is disabled for this event'
        when 'REGISTRATION_DATES_MISSING' then 'Registration dates are not configured for this event'
        when 'REGISTRATION_NOT_OPEN' then 'Registration has not opened yet'
        when 'REGISTRATION_CLOSED' then 'Registration has closed for this event'
        else 'Registration is closed because the event has started'
      end
      using errcode = '55000', hint = v_reason;
  end if;

  -- No additional eligibility rules are configured; authenticated Attendees qualify.
end;
$$;
revoke execute on function assert_event_registration_eligible(uuid, uuid) from public, anon, authenticated;

-- 1-based place in the queue: earlier waitlisted_at first, id breaking ties.
-- Null for a registration that is not waitlisted.

create or replace function waitlist_position(p_registration event_registrations)
returns bigint
language sql
stable
as $$
  select case when p_registration.status = 'waitlisted' then (
    select count(*)
      from event_registrations w
     where w.event_request_id = p_registration.event_request_id
       and w.status = 'waitlisted'
       and (w.waitlisted_at, w.id) <= (p_registration.waitlisted_at, p_registration.id)
  ) end;
$$;
revoke execute on function waitlist_position(event_registrations) from public, anon, authenticated;

-- Fills free places from the head of the queue and notifies each promoted
-- attendee. Callers hold the event lock; it is taken again here so the count
-- and the promotion can never see different registered totals. Promotes
-- nobody while registration is closed: the place waits until it reopens.
-- A list switched off still promotes those already on it; it only stops joins.

create or replace function promote_waitlisted_registrations(p_event_request_id uuid)
returns integer
language plpgsql
as $$
declare
  v_event event_requests;
  v_free bigint;
  v_promoted integer;
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id
     for update;

  if not found or registration_closed_reason(v_event, clock_timestamp()) is not null then
    return 0;
  end if;

  -- Null capacity means no limit, and a null LIMIT promotes everyone waiting.
  if v_event.registration_capacity is not null then
    select v_event.registration_capacity - count(*)
      into v_free
      from event_registrations
     where event_request_id = p_event_request_id and status = 'registered';
    if v_free <= 0 then
      return 0;
    end if;
  end if;

  with next_in_line as (
    select id
      from event_registrations
     where event_request_id = p_event_request_id and status = 'waitlisted'
     order by waitlisted_at, id
     limit v_free
       for update
  ), promoted as (
    update event_registrations r
       set status = 'registered', registered_at = clock_timestamp()
      from next_in_line n
     where r.id = n.id and r.status = 'waitlisted'
    returning r.id, r.attendee_id
  )
  insert into notifications (recipient_id, type, event_request_id, payload)
  select attendee_id, 'registration_promoted', p_event_request_id,
         jsonb_build_object('eventRequestId', p_event_request_id,
                            'eventName', v_event.event_name,
                            'registrationId', id)
    from promoted;

  get diagnostics v_promoted = row_count;
  return v_promoted;
end;
$$;
revoke execute on function promote_waitlisted_registrations(uuid) from public, anon, authenticated;

-- The attendee-facing shape of a waiting-list row, shared by join and its repeat.

create or replace function waitlist_registration_json(p_registration event_registrations)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_registration.id, 'eventRequestId', p_registration.event_request_id,
    'attendeeId', p_registration.attendee_id, 'status', p_registration.status,
    'waitlistedAt', p_registration.waitlisted_at,
    'waitlistPosition', waitlist_position(p_registration),
    'createdAt', p_registration.created_at, 'updatedAt', p_registration.updated_at
  );
$$;
revoke execute on function waitlist_registration_json(event_registrations) from public, anon, authenticated;

-- Joining. Explicit, never a fallback of register_for_event, so nobody who
-- asked for a place is queued without choosing to be. The other way round is
-- safe: a join that finds a free place registers, exactly as register_for_event
-- would, rather than queueing for a place nobody holds. A repeat join answers
-- with the entry already held and leaves its queue time alone.
-- Outcomes: 'waitlisted' (created true or false) or 'registered', else a refusal.

create or replace function join_event_waitlist(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_event event_requests;
  v_count bigint;
  v_registration event_registrations;
begin
  -- The same eligibility, event lock and refusals as register_for_event: every
  -- join, registration, departure and promotion for this event queues here.
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
  if v_registration.status = 'cancelled' then
    return jsonb_build_object('outcome', 'registration_cancelled');
  end if;
  if v_registration.status = 'waitlisted' then
    return jsonb_build_object(
      'outcome', 'waitlisted', 'created', false,
      'registration', waitlist_registration_json(v_registration)
    );
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  select count(*) into v_count from event_registrations
   where event_request_id = p_event_request_id and status = 'registered';
  if v_event.registration_capacity is null or v_count < v_event.registration_capacity then
    return register_for_event(p_event_request_id, p_attendee_id);
  end if;

  if not v_event.registration_waitlist_enabled then
    return jsonb_build_object('outcome', 'waitlist_disabled');
  end if;

  if v_registration.id is not null then
    update event_registrations
       set status = 'waitlisted'
     where id = v_registration.id and status = 'withdrawn'
    returning * into v_registration;
  else
    insert into event_registrations (event_request_id, attendee_id, status)
    values (p_event_request_id, p_attendee_id, 'waitlisted')
    on conflict (event_request_id, attendee_id) do nothing
    returning * into v_registration;
  end if;
  -- Unreachable while every writer takes the event lock first; refused, not
  -- guessed at, if one ever does not.
  if v_registration.id is null or v_registration.status is distinct from 'waitlisted' then
    raise exception 'Registration changed while joining the waiting list' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'outcome', 'waitlisted', 'created', true,
    'registration', waitlist_registration_json(v_registration)
  );
end;
$$;
revoke execute on function join_event_waitlist(uuid, uuid) from public, anon, authenticated;

-- Leaving. Not a withdrawal: no deadline, window or event status applies,
-- because giving up a queue place takes no place from anyone. The row becomes
-- withdrawn, so the attendee can come back later, at the back of the queue.

create or replace function leave_event_waitlist(p_registration_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_owner uuid;
  v_event_id uuid;
  v_registration event_registrations;
begin
  if p_registration_id is null or p_attendee_id is null then
    raise exception 'An attendee and registration are required' using errcode = '22023';
  end if;

  perform assert_caller_role(
    p_attendee_id, array['attendee'],
    'This action is restricted to Attendees'
  );

  select attendee_id, event_request_id into v_owner, v_event_id
    from event_registrations
   where id = p_registration_id;

  -- One message for both, as in assert_registration_withdrawable.
  if not found or v_owner is distinct from p_attendee_id then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;

  -- Event before registration, the order every registration writer uses, so a
  -- departure waits for a promotion in flight and then sees its result.
  perform 1 from event_requests where id = v_event_id for update;

  select * into v_registration
    from event_registrations
   where id = p_registration_id and attendee_id = p_attendee_id
     for update;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;

  -- Promoted while this waited: withdrawing is the way out now.
  if v_registration.status = 'registered' then
    raise exception 'You have been given a place, so you are no longer on the waiting list'
      using errcode = '55000', hint = 'ALREADY_REGISTERED';
  end if;
  if v_registration.status is distinct from 'waitlisted' then
    raise exception 'This registration is not on the waiting list'
      using errcode = '55000', hint = 'NOT_WAITLISTED';
  end if;

  update event_registrations
     set status = 'withdrawn'
   where id = v_registration.id
  returning * into v_registration;

  return jsonb_build_object(
    'outcome', 'left_waitlist',
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;
revoke execute on function leave_event_waitlist(uuid, uuid) from public, anon, authenticated;

-- Withdrawing (018) now hands the released place on before counting, inside
-- the same transaction, so a rolled-back withdrawal promotes nobody.

create or replace function withdraw_registration(
  p_registration_id uuid,
  p_attendee_id     uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_checked record;
  v_registration event_registrations;
  v_count bigint;
begin
  -- Locks the event and the registration until this transaction ends, so a
  -- concurrent second request waits here and is then refused ALREADY_WITHDRAWN,
  -- and a registration for this event cannot count around this change.
  select * into v_checked
    from assert_registration_withdrawable(p_registration_id, p_attendee_id);
  v_registration := v_checked.registration;

  update event_registrations
     set status = 'withdrawn'
   where id = v_registration.id
     and status = 'registered'
  returning * into v_registration;

  if not found then
    raise exception 'Registration % changed while it was being withdrawn', p_registration_id
      using errcode = '40001';
  end if;

  perform promote_waitlisted_registrations(v_registration.event_request_id);

  select count(*) into v_count
    from event_registrations
   where event_request_id = v_registration.event_request_id and status = 'registered';

  return jsonb_build_object(
    'outcome', 'withdrawn',
    'registeredCount', v_count,
    'capacity', v_checked.capacity,
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'registeredAt', v_registration.registered_at,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;
revoke execute on function withdraw_registration(uuid, uuid) from public, anon, authenticated;

-- Settings gain the waiting-list switch. A null switch keeps the saved value,
-- so a client that does not know about waiting lists cannot turn one off.
-- Saving promotes into any places the new settings free (a higher capacity,
-- no limit, or registration reopened).

drop function if exists setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz);

create or replace function setup_event_registration(
  p_event_request_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_capacity integer,
  p_withdrawal_deadline timestamptz,
  p_waitlist_enabled boolean default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_registered integer;
  v_waitlisted integer;
  v_waitlist_enabled boolean;
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

  v_waitlist_enabled := coalesce(p_waitlist_enabled, v_event.registration_waitlist_enabled);

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
    'withdrawalDeadline', v_event.registration_withdrawal_deadline,
    'waitlistEnabled', v_event.registration_waitlist_enabled
  );
  v_new := jsonb_build_object(
    'enabled', p_enabled,
    'opensAt', p_opens_at,
    'closesAt', p_closes_at,
    'capacity', p_capacity,
    'withdrawalDeadline', p_withdrawal_deadline,
    'waitlistEnabled', v_waitlist_enabled
  );

  update event_requests
     set registration_enabled = p_enabled,
         registration_opens_at = p_opens_at,
         registration_closes_at = p_closes_at,
         registration_capacity = p_capacity,
         registration_withdrawal_deadline = p_withdrawal_deadline,
         registration_waitlist_enabled = v_waitlist_enabled
   where id = p_event_request_id;

  if v_old is distinct from v_new then
    insert into event_registration_settings_history (
      event_request_id, changed_by, old_values, new_values
    ) values (
      p_event_request_id, p_user_id, v_old, v_new
    );
  end if;

  v_registered := v_registered + promote_waitlisted_registrations(p_event_request_id);

  select count(*)::integer into v_waitlisted
    from event_registrations
   where event_request_id = p_event_request_id
     and status = 'waitlisted';

  return jsonb_build_object(
    'outcome', 'saved',
    'settings', v_new,
    'registeredCount', v_registered,
    'waitlistCount', v_waitlisted
  );
end;
$$;
revoke execute on function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean) from public, anon, authenticated;

-- The browse state gains the caller's own queue position. The return type
-- changes, so the function is dropped first.

drop function if exists open_event_registration_state(uuid[], uuid);

create function open_event_registration_state(p_event_ids uuid[], p_attendee_id uuid)
returns table (
  event_request_id uuid, active_count bigint, is_registered boolean,
  registration_status text, waitlist_position bigint
)
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
           max(r.status) filter (where r.attendee_id = p_attendee_id),
           max(waitlist_position(r)) filter (where r.attendee_id = p_attendee_id)
      from event_registrations r
     where r.event_request_id = any(coalesce(p_event_ids, '{}'::uuid[]))
       and (r.status = 'registered'
            or (r.attendee_id = p_attendee_id and r.status in ('waitlisted', 'cancelled')))
     group by r.event_request_id;
end;
$fn$;
revoke execute on function open_event_registration_state(uuid[], uuid) from public, anon, authenticated;

-- My Registrations: the caller's own waiting-list places, newest first.

create or replace function list_attendee_waitlist(p_attendee_id uuid)
returns table (
  registration_id uuid, event_request_id uuid, event_name text,
  waitlist_position bigint, waitlisted_at timestamptz
)
language plpgsql
stable
as $fn$
begin
  perform assert_caller_role(
    p_attendee_id, array['attendee'],
    'This action is restricted to Attendees'
  );

  return query
    select r.id, r.event_request_id, e.event_name::text, waitlist_position(r), r.waitlisted_at
      from event_registrations r
      join event_requests e on e.id = r.event_request_id
     where r.attendee_id = p_attendee_id and r.status = 'waitlisted'
     order by r.waitlisted_at desc, r.id;
end;
$fn$;
revoke execute on function list_attendee_waitlist(uuid) from public, anon, authenticated;

-- Registration totals for the event's Organiser and its assigned Coordinator,
-- the two the route's requireRole admits.

create or replace function event_registration_counts(p_event_request_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event event_requests;
begin
  if p_event_request_id is null then
    raise exception 'An event is required' using errcode = '22023';
  end if;

  perform assert_caller_role(
    p_user_id, array['event_organiser', 'event_coordinator'],
    'Only the event''s Organiser or assigned Coordinator can view its registrations'
  );

  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if p_user_id is distinct from v_event.organiser_id
     and p_user_id is distinct from v_event.assigned_coordinator_id then
    raise exception 'Only the event''s Organiser or assigned Coordinator can view its registrations'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'eventRequestId', v_event.id,
    'capacity', v_event.registration_capacity,
    'waitlistEnabled', v_event.registration_waitlist_enabled,
    'registeredCount', (select count(*) from event_registrations
                         where event_request_id = v_event.id and status = 'registered'),
    'waitlistCount', (select count(*) from event_registrations
                       where event_request_id = v_event.id and status = 'waitlisted')
  );
end;
$$;
revoke execute on function event_registration_counts(uuid, uuid) from public, anon, authenticated;

-- The whole list, restated from 016_overnight_operating_hours.sql with the new type.
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
    'registration_promoted'
  ]));

alter table notifications drop constraint if exists notifications_registration_promoted_needs_event;
alter table notifications
  add constraint notifications_registration_promoted_needs_event
  check ((type <> 'registration_promoted') or (event_request_id is not null));
