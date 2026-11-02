-- Migration 051: the registration notification contract (SCRUM-177).
-- Four notification types, the state each event last announced, who receives
-- a registration notice and the one writer every notice goes through. The
-- handlers that decide when to send are 052; the rules are docs/SCRUM-177.md.
--
-- Payloads (every one also carries audience, eventRequestId, eventName and
-- occurrenceKey; event_request_id is always set on the row):
-- - registration_opened:  { opensAt, closesAt, cause }
--     cause: opening_time | settings_changed | event_confirmed
-- - registration_closed:  { closedAt, cause }
--     cause: closing_time | switched_off | settings_changed | event_started | event_not_confirmed
-- - registration_capacity_reached: { capacity, registeredCount }
-- - registration_place_released:   { capacity, registeredCount, cause }
--     cause: withdrawal
-- registration_promoted (037) stays as it is; it is the waiting-list status change.
--
-- Only counts are sent, never another attendee's name, id or registration.
-- occurrenceKey names one occurrence of a transition, so a retried or repeated
-- writer sends nothing twice while a later occurrence (a reopening) still does.
--
-- Re-runnable.

-- Several branches add types, so the live list is read back and widened by
-- what it lacks (042's idiom); restating a fixed list would drop the others'.
do $notify$
declare
  v_def text;
  v_types text[];
  v_missing text[];
  v_check text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'notifications_type_known'
     and conrelid = 'notifications'::regclass;
  if v_def is null then
    raise exception 'notifications_type_known is missing; restore it before 051';
  end if;

  v_types := array(select m[1] from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m);
  v_missing := array(
    select t from unnest(array['registration_opened', 'registration_closed', 'registration_capacity_reached', 'registration_place_released']) as t
     where not (t = any (v_types))
  );
  if cardinality(v_missing) > 0 then
    v_check := format(
      'check (type = any (array[%s]))',
      (select string_agg(quote_literal(t), ', ') from unnest(v_types || v_missing) as t)
    );
    alter table notifications drop constraint notifications_type_known;
    execute 'alter table notifications add constraint notifications_type_known ' || v_check;
  end if;
end;
$notify$;

-- Enforced on the row as well as in the writer, so a later direct insert cannot
-- send a staff-only notice to an attendee or lose its event.
alter table notifications drop constraint if exists notifications_registration_change_shape;
alter table notifications
  add constraint notifications_registration_change_shape check (
    type <> all (array['registration_opened', 'registration_closed',
                       'registration_capacity_reached', 'registration_place_released'])
    or (event_request_id is not null
        and coalesce(payload->>'occurrenceKey', '') <> ''
        -- coalesce: a missing audience must fail the check, not pass it as null.
        and case when type in ('registration_opened', 'registration_closed')
                 then coalesce(payload->>'audience', '') in ('organiser', 'coordinator', 'waitlisted')
                 else coalesce(payload->>'audience', '') in ('organiser', 'coordinator') end)
  );

create unique index if not exists notifications_one_per_registration_change
  on notifications (recipient_id, event_request_id, type, (payload->>'occurrenceKey'))
  where type in ('registration_opened', 'registration_closed',
                 'registration_capacity_reached', 'registration_place_released');

-- What was last announced for each event. Kept off event_requests so that
-- recording it fires none of that table's triggers. Built once: a re-run must
-- not overwrite it, or a transition not yet announced would be lost.
do $$
begin
  if to_regclass('public.registration_notice_state') is null then
    create table registration_notice_state (
      event_request_id uuid primary key references event_requests(id) on delete cascade,
      open_announced boolean not null default false,
      full_announced boolean not null default false,
      -- Transition counters: an occurrence key is taken from stored state, so a
      -- retry of a rolled-back transition reuses its key and a later one (a
      -- reopening, a refill) gets a higher one, whatever the dates or clock.
      window_generation integer not null default 0,
      capacity_generation integer not null default 0
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

-- Sends one registration notice to each requested audience of an event, as
-- registration_notification_recipients resolves them, leaving out the person
-- who made the change when named. p_details holds the type's own fields; the
-- shared ones are set here and win over it. Runs in the caller's transaction
-- and takes no lock, so a flow calls it after its own writes, under the event
-- lock it already holds. Returns how many were inserted; a repeated occurrence
-- inserts none.

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
