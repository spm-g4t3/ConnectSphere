-- Migration 048: the registration flows send their notices (SCRUM-177, SCRUM-239).
-- The 037 flows, restated with calls to the shared handlers (045-047) after
-- their own writes. Nothing else in them changes: the same eligibility, the
-- same event lock taken first, the same single promotion operation. Each
-- handler runs in the flow's transaction under the lock it already holds, so
-- a flow that fails or rolls back leaves no notice and no recorded state, and
-- a flow that commits has committed its notice with it.
--
-- Order in every flow: its write, then promotion, then capacity, then the
-- window (docs/SCRUM-177.md, section 5). Promotion keeps notifying each
-- attendee it promotes (registration_promoted); nothing here adds a second
-- notice for that, or one to the attendee who acted.
--
-- Re-runnable.

-- A new registration, or catch-up promotion of the queue, can fill the event.

create or replace function register_for_event(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_capacity integer;
  v_count bigint;
  v_registration event_registrations;
  v_status_before text;
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

  -- Stable under the event lock just taken: every registration writer takes it first.
  select status::text into v_status_before from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id;

  if promote_waitlisted_registrations(p_event_request_id) > 0 then
    perform announce_registration_capacity(p_event_request_id, 'promotion');
  end if;

  select * into v_registration from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id for update;
  if v_registration.status = 'registered' then
    if v_status_before = 'waitlisted' then
      return registered_outcome_json(v_registration);
    end if;
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

  perform announce_registration_capacity(p_event_request_id, 'registration');
  return registered_outcome_json(v_registration);
end;
$$;
revoke execute on function register_for_event(uuid, uuid) from public, anon, authenticated;

-- Joining: its catch-up promotion can fill the event; a join that finds room
-- registers through register_for_event, which announces that. Queueing itself
-- changes no availability and is the attendee's own act, so sends nothing.

create or replace function join_event_waitlist(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_event event_requests;
  v_count bigint;
  v_registration event_registrations;
  v_status_before text;
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

  select status::text into v_status_before from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id;

  -- Queued attendees take any free place first, so the capacity check below
  -- sees only places nobody is waiting for.
  if promote_waitlisted_registrations(p_event_request_id) > 0 then
    perform announce_registration_capacity(p_event_request_id, 'promotion');
  end if;

  select * into v_registration from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id for update;
  if v_registration.status = 'registered' then
    -- The catch-up gave the caller their place: that is this join succeeding.
    if v_status_before = 'waitlisted' then
      return registered_outcome_json(v_registration);
    end if;
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

-- Withdrawing releases a place: promoted, it reaches the next in the queue
-- (who is told); otherwise the managers are told a place is free.

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
  -- After the promotion, so a place the queue took is not reported free.
  perform announce_registration_capacity(v_registration.event_request_id, 'withdrawal');

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

-- Saving settings: a higher or removed capacity promotes, a lower one can
-- fill the event, and the dates or switch can open or close the window. The
-- Organiser who saved is not told; the coordinator and the queue are.

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
  -- An unchanged save changes neither state, so these send nothing.
  perform announce_registration_capacity(p_event_request_id, 'settings_changed');
  perform announce_registration_window(p_event_request_id, 'settings_changed');

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

-- A return to Confirmed can reopen registration with no registration write.

create or replace function promote_waitlist_on_confirmation()
returns trigger
language plpgsql
as $$
begin
  if promote_waitlisted_registrations(new.id) > 0 then
    perform announce_registration_capacity(new.id, 'promotion');
  end if;
  perform announce_registration_window(new.id, 'event_confirmed');
  return null;
end;
$$;
revoke execute on function promote_waitlist_on_confirmation() from public, anon, authenticated;

-- Leaving Confirmed closes registration with no registration write, so the
-- closure is announced as it happens rather than at the job's next run. A
-- cancellation is settled without a notice (the handler's rule).

create or replace function announce_registration_window_on_status_change()
returns trigger
language plpgsql
as $$
begin
  perform announce_registration_window(new.id, null);
  return null;
end;
$$;
revoke execute on function announce_registration_window_on_status_change() from public, anon, authenticated;

drop trigger if exists event_requests_announce_registration_closed_on_status_change on event_requests;
create trigger event_requests_announce_registration_closed_on_status_change
  after update of status on event_requests
  for each row
  when (old.status::text = 'confirmed' and new.status::text is distinct from 'confirmed')
  execute function announce_registration_window_on_status_change();

-- The promotion job: a place handed out once registration reopens can fill the event.

create or replace function process_waitlist_promotions()
returns integer
language plpgsql
as $$
declare
  v_event_id uuid;
  v_promoted integer := 0;
  v_count integer;
begin
  for v_event_id in
    select e.id
      from event_requests e
     where registration_closed_reason(e, clock_timestamp()) is null
       and exists (select 1 from event_registrations r
                    where r.event_request_id = e.id and r.status = 'waitlisted')
     -- Event locks are held to the end of the run; a fixed order keeps two
     -- concurrent runs from deadlocking on each other.
     order by e.id
  loop
    v_count := promote_waitlisted_registrations(v_event_id);
    if v_count > 0 then
      perform announce_registration_capacity(v_event_id, 'promotion');
    end if;
    v_promoted := v_promoted + v_count;
  end loop;
  return v_promoted;
end;
$$;
revoke execute on function process_waitlist_promotions() from public, anon, authenticated;
