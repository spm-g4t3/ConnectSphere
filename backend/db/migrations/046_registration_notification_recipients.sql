-- Migration 046: who receives registration notices (SCRUM-177, SCRUM-238).
-- Every registration notice, promotion included, now finds its recipients in
-- registration_notification_recipients, from the event row and its
-- registrations; no caller ever supplies a user id. One person is told once
-- per notice whatever roles they hold, and the person who made a change can be
-- left out by id. The rules are in docs/SCRUM-177.md, section 5.
--
-- Re-runnable.

-- The audience list gains registrant, and the signature gains the
-- registrations it names and the actor to leave out.
drop function if exists registration_notification_recipients(uuid, text[]);

-- Audiences:
--   organiser   the event's organiser
--   coordinator the event's assigned coordinator now
--   waitlisted  the event's attendees on its waiting list now
--   registrant  the attendee of each of p_registration_ids, whatever their
--               status now: the person a change was about, still told after
--               it moved them (a promotion takes them off the queue)
-- One row per person: someone in several audiences is told once, as the first
-- of organiser, coordinator, registrant, waitlisted. Nobody outside the event
-- is ever returned, and an unknown audience, or a registration that is not
-- this event's, is refused rather than skipped.

create or replace function registration_notification_recipients(
  p_event_request_id uuid,
  p_audiences text[],
  p_registration_ids uuid[] default null,
  p_exclude_recipient_id uuid default null
)
returns table (recipient_id uuid, audience text)
language plpgsql
stable
as $$
declare
  v_event event_requests;
begin
  if p_audiences is null
     or not (p_audiences <@ array['organiser', 'coordinator', 'waitlisted', 'registrant']) then
    raise exception 'Unknown registration notification audience in %', p_audiences using errcode = '22023';
  end if;
  if 'registrant' = any (p_audiences) and coalesce(cardinality(p_registration_ids), 0) = 0 then
    raise exception 'The registrant audience needs the registrations it is about' using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  if 'registrant' = any (p_audiences) and exists (
    select 1 from unnest(p_registration_ids) as wanted(id)
     where not exists (select 1 from event_registrations r
                        where r.id = wanted.id and r.event_request_id = p_event_request_id)
  ) then
    raise exception 'A registration is not one of this event''s' using errcode = '22023';
  end if;

  return query
    select distinct on (c.recipient_id) c.recipient_id, c.audience
      from (
        select v_event.organiser_id as recipient_id, 'organiser'::text as audience, 1 as rank
         where 'organiser' = any (p_audiences)
        union all
        select v_event.assigned_coordinator_id, 'coordinator'::text, 2
         where 'coordinator' = any (p_audiences)
        union all
        select r.attendee_id, 'registrant'::text, 3
          from event_registrations r
         where 'registrant' = any (p_audiences)
           and r.event_request_id = p_event_request_id and r.id = any (p_registration_ids)
        union all
        select r.attendee_id, 'waitlisted'::text, 4
          from event_registrations r
         where 'waitlisted' = any (p_audiences)
           and r.event_request_id = p_event_request_id and r.status = 'waitlisted'
      ) c
     where c.recipient_id is not null
       and c.recipient_id is distinct from p_exclude_recipient_id
     order by c.recipient_id, c.rank;
end;
$$;
revoke execute on function registration_notification_recipients(uuid, text[], uuid[], uuid) from public, anon, authenticated;

-- 045's writer, now able to leave out the person who made the change.
drop function if exists notify_registration_change(uuid, text, text[], text, jsonb);

create or replace function notify_registration_change(
  p_event_request_id uuid,
  p_type text,
  p_audiences text[],
  p_occurrence_key text,
  p_details jsonb default '{}',
  p_exclude_recipient_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_event_name text;
  v_allowed text[];
  v_causes text[];
  v_inserted integer;
begin
  v_allowed := case p_type
    when 'registration_opened' then array['organiser', 'coordinator', 'waitlisted']
    when 'registration_closed' then array['organiser', 'coordinator', 'waitlisted']
    when 'registration_capacity_reached' then array['organiser', 'coordinator']
    when 'registration_place_released' then array['organiser', 'coordinator']
  end;
  if v_allowed is null then
    raise exception 'Unknown registration notification type %', p_type using errcode = '22023';
  end if;
  if p_audiences is null or cardinality(p_audiences) = 0 or not (p_audiences <@ v_allowed) then
    raise exception '% cannot be sent to %', p_type, p_audiences using errcode = '22023';
  end if;
  if coalesce(p_occurrence_key, '') = '' then
    raise exception 'An occurrence key is required' using errcode = '22023';
  end if;

  v_causes := case p_type
    when 'registration_opened' then array['opening_time', 'settings_changed', 'event_confirmed']
    when 'registration_closed' then array['closing_time', 'switched_off', 'settings_changed', 'event_started', 'event_not_confirmed']
    when 'registration_place_released' then array['withdrawal']
  end;
  if v_causes is not null and coalesce(p_details->>'cause', '') <> all (v_causes) then
    raise exception '% needs a cause of %', p_type, v_causes using errcode = '22023';
  end if;

  select event_name into v_event_name from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  with inserted as (
    insert into notifications (recipient_id, type, event_request_id, payload)
    select r.recipient_id, p_type, p_event_request_id,
           coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
             'audience', r.audience,
             'eventRequestId', p_event_request_id,
             'eventName', v_event_name,
             'occurrenceKey', p_occurrence_key)
      from registration_notification_recipients(
             p_event_request_id, p_audiences, null, p_exclude_recipient_id) r
    on conflict (recipient_id, event_request_id, type, (payload->>'occurrenceKey'))
      where type in ('registration_opened', 'registration_closed',
                     'registration_capacity_reached', 'registration_place_released')
      do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$$;
revoke execute on function notify_registration_change(uuid, text, text[], text, jsonb, uuid) from public, anon, authenticated;

-- 045's handlers, unchanged except that a settings save leaves out the
-- Organiser as a person, so an Organiser who is also on the queue is not told
-- of their own change either.

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
  update registration_notice_state set open_announced = v_open
   where event_request_id = p_event_request_id;

  if v_open then
    v_cause := coalesce(p_cause, 'opening_time');
    v_audiences := array['organiser', 'coordinator', 'waitlisted'];
    v_details := jsonb_build_object(
      'cause', v_cause,
      'opensAt', registration_notice_instant(v_event.registration_opens_at),
      'closesAt', registration_notice_instant(v_event.registration_closes_at));
  else
    if v_event.status::text = 'cancelled' then
      return 0;
    end if;
    v_cause := case v_reason
      when 'REGISTRATION_CLOSED' then 'closing_time'
      when 'REGISTRATION_DISABLED' then 'switched_off'
      when 'EVENT_STARTED' then 'event_started'
      when 'EVENT_NOT_CONFIRMED' then 'event_not_confirmed'
      else 'settings_changed'
    end;
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
    case when v_open then 'opened:' else 'closed:' end || registration_notice_instant(v_now),
    v_details,
    -- Only the Organiser saves registration settings.
    case when p_cause = 'settings_changed' then v_event.organiser_id end);
end;
$$;
revoke execute on function announce_registration_window(uuid, text) from public, anon, authenticated;

create or replace function announce_registration_capacity(
  p_event_request_id uuid,
  p_cause text
)
returns integer
language plpgsql
as $$
declare
  v_event event_requests;
  v_now timestamptz := clock_timestamp();
  v_registered bigint;
  v_full boolean;
  v_announced boolean;
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
  update registration_notice_state set full_announced = v_full
   where event_request_id = p_event_request_id;

  if not v_full and p_cause <> 'withdrawal' then
    return 0;
  end if;
  if p_cause = 'settings_changed' then
    v_actor := v_event.organiser_id;
  end if;

  if v_full then
    return notify_registration_change(
      p_event_request_id, 'registration_capacity_reached', array['organiser', 'coordinator'],
      'full:' || registration_notice_instant(v_now),
      jsonb_build_object('capacity', v_event.registration_capacity, 'registeredCount', v_registered),
      v_actor);
  end if;
  return notify_registration_change(
    p_event_request_id, 'registration_place_released', array['organiser', 'coordinator'],
    'released:' || registration_notice_instant(v_now),
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
