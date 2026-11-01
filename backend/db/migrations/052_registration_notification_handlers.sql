-- Migration 052: when the registration notices of 051 are sent (SCRUM-177).
-- Each handler locks the event, compares its state now with the state last
-- announced in registration_notice_state, and sends through
-- notify_registration_change only when the two differ, recording the new state
-- in the same transaction. So a refused operation, an unchanged save and a
-- repeated call all send nothing. The rules are in docs/SCRUM-177.md.
--
-- Re-runnable.

-- Opening and closing. Open means registration_closed_reason finds nothing, the
-- rule registering and promotion already use. p_cause names what the caller
-- changed: settings_changed (the Organiser saved settings), event_confirmed
-- (the event returned to Confirmed), or null when only time has passed.
--
-- Rules:
-- - same as announced: nothing.
-- - opened: staff and the waiting list, cause opening_time unless named.
-- - closed: staff and the waiting list, cause from the closing reason.
--   An event that started is not reopening, so its queue is not told it is
--   paused. A finished event sends nothing.
-- - settings_changed: the Organiser made the change, so is not told of it.
-- Keys are opened:<n> and closed:<n> from window_generation. Call it after any
-- promotion, so a queued attendee who just got a place is told that, not that
-- the queue moves. Returns how many notices were sent.

create or replace function announce_registration_window(
  p_event_request_id uuid,
  p_cause text default null
)
returns integer
language plpgsql
as $$
declare
  v_event event_requests;
  v_now timestamptz := clock_timestamp();
  v_reason text;
  v_open boolean;
  v_announced boolean;
  v_generation integer;
  v_cause text;
  v_audiences text[];
  v_details jsonb;
begin
  if p_cause is not null and p_cause not in ('settings_changed', 'event_confirmed') then
    raise exception 'Unknown registration window cause %', p_cause using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  v_reason := registration_closed_reason(v_event, v_now);
  v_open := v_reason is null;

  insert into registration_notice_state (event_request_id) values (p_event_request_id)
  on conflict (event_request_id) do nothing;
  select open_announced into v_announced
    from registration_notice_state where event_request_id = p_event_request_id for update;

  if v_open = v_announced then
    return 0;
  end if;
  update registration_notice_state
     set open_announced = v_open, window_generation = window_generation + 1
   where event_request_id = p_event_request_id
  returning window_generation into v_generation;

  if v_open then
    v_cause := coalesce(p_cause, 'opening_time');
    v_audiences := array['organiser', 'coordinator', 'waitlisted'];
    v_details := jsonb_build_object(
      'cause', v_cause,
      'opensAt', registration_notice_instant(v_event.registration_opens_at),
      'closesAt', registration_notice_instant(v_event.registration_closes_at));
  else
    -- A finished event (any status outside ACTIVE_EVENT_STATUSES in
    -- domain/eventRequestStatus.js) never reopens: a cancellation sends its own
    -- notice (042) and a completed event has ended, so a closing notice would
    -- only be stale. Naming the active ones keeps a status added later silent
    -- until it is listed there too.
    if v_event.status::text <> all (array[
         'submitted', 'under_review', 'pending_clarification', 'approved',
         'safety_review', 'safety_approved', 'confirmed']) then
      return 0;
    end if;
    -- A moved opening time or cleared dates are only ever written by a settings
    -- save. Without one there is no true cause to give, so nothing is sent.
    v_cause := case
      when v_reason = 'REGISTRATION_CLOSED' then 'closing_time'
      when v_reason = 'REGISTRATION_DISABLED' then 'switched_off'
      when v_reason = 'EVENT_STARTED' then 'event_started'
      when v_reason = 'EVENT_NOT_CONFIRMED' then 'event_not_confirmed'
      when p_cause = 'settings_changed' then 'settings_changed'
    end;
    if v_cause is null then
      return 0;
    end if;
    v_audiences := case when v_cause = 'event_started'
      then array['organiser', 'coordinator']
      else array['organiser', 'coordinator', 'waitlisted'] end;
    v_details := jsonb_build_object(
      'cause', v_cause,
      'closedAt', registration_notice_instant(case v_cause
        when 'closing_time' then v_event.registration_closes_at
        when 'event_started' then v_event.proposed_start
        else v_now end));
  end if;

  return notify_registration_change(
    p_event_request_id,
    case when v_open then 'registration_opened' else 'registration_closed' end,
    v_audiences,
    case when v_open then 'opened:' else 'closed:' end || v_generation,
    v_details,
    -- Only the Organiser saves registration settings.
    case when p_cause = 'settings_changed' then v_event.organiser_id end);
end;
$$;
revoke execute on function announce_registration_window(uuid, text) from public, anon, authenticated;

-- Capacity. Full means a capacity is set and the registered count has reached
-- it. p_cause names the change the caller made: registration, promotion,
-- withdrawal or settings_changed.
--
-- Rules:
-- - same as announced: nothing.
-- - became full: staff are told (capacity_reached).
-- - stopped being full through a withdrawal with nobody queued: staff are told
--   a place is free (place_released). Call it after the withdrawal's
--   promotion, so a place a queued attendee took is not reported as free. With
--   someone still queued (registration closed): nothing, and nothing recorded.
-- - stopped being full any other way (a raised or removed capacity): nothing;
--   the Organiser made that change.
-- - settings_changed: the Organiser is not told of their own change.
-- Keys are full:<n> and released:<n> from capacity_generation. Returns how many
-- notices were sent.

create or replace function announce_registration_capacity(
  p_event_request_id uuid,
  p_cause text
)
returns integer
language plpgsql
as $$
declare
  v_event event_requests;
  v_registered bigint;
  v_full boolean;
  v_announced boolean;
  v_generation integer;
  v_actor uuid;
begin
  if p_cause is null or p_cause not in ('registration', 'promotion', 'withdrawal', 'settings_changed') then
    raise exception 'Unknown registration capacity cause %', p_cause using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  select count(*) into v_registered from event_registrations
   where event_request_id = p_event_request_id and status = 'registered';
  v_full := v_event.registration_capacity is not null and v_registered >= v_event.registration_capacity;

  insert into registration_notice_state (event_request_id) values (p_event_request_id)
  on conflict (event_request_id) do nothing;
  select full_announced into v_announced
    from registration_notice_state where event_request_id = p_event_request_id for update;

  if v_full = v_announced then
    return 0;
  end if;
  -- A place someone is queued for is not free: while registration is closed
  -- promotion hands out nothing, and the queue takes it when it reopens. It
  -- stays recorded full, so that refill does not tell the managers "full" again.
  if not v_full and p_cause = 'withdrawal' and exists (
       select 1 from event_registrations
        where event_request_id = p_event_request_id and status = 'waitlisted') then
    return 0;
  end if;
  update registration_notice_state
     set full_announced = v_full, capacity_generation = capacity_generation + 1
   where event_request_id = p_event_request_id
  returning capacity_generation into v_generation;

  if not v_full and p_cause <> 'withdrawal' then
    return 0;
  end if;
  if p_cause = 'settings_changed' then
    v_actor := v_event.organiser_id;
  end if;

  if v_full then
    return notify_registration_change(
      p_event_request_id, 'registration_capacity_reached', array['organiser', 'coordinator'],
      'full:' || v_generation,
      jsonb_build_object('capacity', v_event.registration_capacity, 'registeredCount', v_registered),
      v_actor);
  end if;
  return notify_registration_change(
    p_event_request_id, 'registration_place_released', array['organiser', 'coordinator'],
    'released:' || v_generation,
    jsonb_build_object('cause', 'withdrawal',
                       'capacity', v_event.registration_capacity, 'registeredCount', v_registered),
    v_actor);
end;
$$;
revoke execute on function announce_registration_capacity(uuid, text) from public, anon, authenticated;

-- 037's promotion, unchanged except that the notice goes to the registrant the
-- resolver finds for each promoted registration. That is the attendee who
-- queued: managers are not told of a promotion (no rule asks for it). The
-- resolver reads the statement's snapshot, where the row is still queued; the
-- registrant audience does not depend on status, so either way it is them.

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

  -- The notification is a row in the same transaction, so a rollback leaves
  -- none. One queue entry is identified by its registration and waitlisted_at;
  -- the unique index makes a second notice for the same promotion impossible.
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
    returning r.id, r.waitlisted_at
  ), notified as (
    insert into notifications (recipient_id, type, event_request_id, payload)
    select who.recipient_id, 'registration_promoted', p_event_request_id,
           jsonb_build_object('eventRequestId', p_event_request_id,
                              'eventName', v_event.event_name,
                              'registrationId', p.id,
                              -- UTC text, so the duplicate key does not depend on the session's TimeZone.
                              'waitlistedAt', registration_notice_instant(p.waitlisted_at))
      from promoted p
     cross join lateral registration_notification_recipients(
             p_event_request_id, array['registrant'], array[p.id]) who
    on conflict ((payload->>'registrationId'), (payload->>'waitlistedAt'))
      where type = 'registration_promoted'
      do nothing
  )
  select count(*)::integer into v_promoted from promoted;

  return v_promoted;
end;
$$;
revoke execute on function promote_waitlisted_registrations(uuid) from public, anon, authenticated;
