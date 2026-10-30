-- Migration 040: when the registration notices of 039 are sent (SCRUM-177).
-- Two handlers decide whether a registration change is a transition worth a
-- notice, and send it through notify_registration_change. The opening/closing
-- job and the registration flows will both call these; nothing does yet.
--
-- Each handler compares the event's state now with the state last announced,
-- kept in registration_notice_state. Only a difference sends anything, so a
-- refused operation (which rolls back or changes nothing), an unchanged save
-- and a repeated call all send nothing. The rules are in docs/SCRUM-177.md.
--
-- Re-runnable.

-- What was last announced for each event. Kept off event_requests so that
-- recording it fires none of that table's triggers. Built once: a re-run must
-- not overwrite it, or a transition not yet announced would be lost.
do $$
begin
  if to_regclass('public.registration_notice_state') is null then
    create table registration_notice_state (
      event_request_id uuid primary key references event_requests(id) on delete cascade,
      open_announced boolean not null default false,
      full_announced boolean not null default false
    );
    -- Today's state counts as announced, so going live sends no burst of
    -- notices about events that opened or filled before this migration.
    insert into registration_notice_state (event_request_id, open_announced, full_announced)
    select e.id,
           registration_closed_reason(e, now()) is null,
           e.registration_capacity is not null and (
             select count(*) from event_registrations r
              where r.event_request_id = e.id and r.status = 'registered'
           ) >= e.registration_capacity
      from event_requests e;
  end if;
end;
$$;
alter table registration_notice_state enable row level security;
revoke all on registration_notice_state from public, anon, authenticated;

-- Recipient resolution (SCRUM-238 builds on this). Only the named audiences of
-- this event: there is no broadcast and no fallback, and an audience it does
-- not know is refused rather than ignored.
--   organiser   the event's organiser
--   coordinator the assigned coordinator, unless also the organiser
--   waitlisted  attendees on the event's waiting list now

create or replace function registration_notification_recipients(
  p_event_request_id uuid,
  p_audiences text[]
)
returns table (recipient_id uuid, audience text)
language plpgsql
stable
as $$
declare
  v_event event_requests;
begin
  if p_audiences is null
     or not (p_audiences <@ array['organiser', 'coordinator', 'waitlisted']) then
    raise exception 'Unknown registration notification audience in %', p_audiences using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  return query
    select v_event.organiser_id, 'organiser'::text
     where 'organiser' = any (p_audiences) and v_event.organiser_id is not null
    union all
    select v_event.assigned_coordinator_id, 'coordinator'::text
     where 'coordinator' = any (p_audiences)
       and v_event.assigned_coordinator_id is not null
       and v_event.assigned_coordinator_id is distinct from v_event.organiser_id
    union all
    select r.attendee_id, 'waitlisted'::text
      from event_registrations r
     where 'waitlisted' = any (p_audiences)
       and r.event_request_id = p_event_request_id and r.status = 'waitlisted';
end;
$$;
revoke execute on function registration_notification_recipients(uuid, text[]) from public, anon, authenticated;

-- 039's writer, now resolving recipients above, and with settings_changed as a
-- closing cause (an opening time moved later closes an open window).

create or replace function notify_registration_change(
  p_event_request_id uuid,
  p_type text,
  p_audiences text[],
  p_occurrence_key text,
  p_details jsonb default '{}'
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
      from registration_notification_recipients(p_event_request_id, p_audiences) r
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
revoke execute on function notify_registration_change(uuid, text, text[], text, jsonb) from public, anon, authenticated;

-- UTC text for keys and payload times, as 037 does, so neither depends on the
-- session's TimeZone.
create or replace function registration_notice_instant(p_at timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;
revoke execute on function registration_notice_instant(timestamptz) from public, anon, authenticated;

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
--   paused. A cancelled event sends nothing; its cancellation is the notice.
-- - settings_changed: the Organiser made the change, so is not told of it.
-- Call it after any promotion, so a queued attendee who just got a place is
-- told that, not that the queue moves. Returns how many notices were sent.

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

  if p_cause = 'settings_changed' then
    v_audiences := array_remove(v_audiences, 'organiser');
  end if;

  return notify_registration_change(
    p_event_request_id,
    case when v_open then 'registration_opened' else 'registration_closed' end,
    v_audiences,
    case when v_open then 'opened:' else 'closed:' end || registration_notice_instant(v_now),
    v_details);
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
-- - stopped being full through a withdrawal: staff are told a place is free
--   (place_released). Call it after the withdrawal's promotion, so a place a
--   queued attendee took is not reported as free.
-- - stopped being full any other way (a raised or removed capacity): nothing;
--   the Organiser made that change.
-- - settings_changed: the Organiser is not told of their own change.
-- Returns how many notices were sent.

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
  v_audiences text[] := array['organiser', 'coordinator'];
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
    v_audiences := array_remove(v_audiences, 'organiser');
  end if;

  if v_full then
    return notify_registration_change(
      p_event_request_id, 'registration_capacity_reached', v_audiences,
      'full:' || registration_notice_instant(v_now),
      jsonb_build_object('capacity', v_event.registration_capacity, 'registeredCount', v_registered));
  end if;
  return notify_registration_change(
    p_event_request_id, 'registration_place_released', v_audiences,
    'released:' || registration_notice_instant(v_now),
    jsonb_build_object('cause', 'withdrawal',
                       'capacity', v_event.registration_capacity, 'registeredCount', v_registered));
end;
$$;
revoke execute on function announce_registration_capacity(uuid, text) from public, anon, authenticated;
