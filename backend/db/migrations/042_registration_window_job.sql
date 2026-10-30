-- Migration 042: the registration opening/closing job (SCRUM-177, SCRUM-237).
-- Registration opens and closes when a time passes, with no write to notice it.
-- process_registration_window_notices, called once a minute by the API's job
-- (backend/src/jobs/registrationWindowScheduler.js), finds every event whose
-- window is not what was last announced and hands it to
-- announce_registration_window, the one path the registration flows use too.
--
-- Boundaries and clock: registration_closed_reason, the rule registering uses,
-- read with the database clock after the event lock: open from
-- registration_opens_at inclusive, closed from registration_closes_at (or the
-- start) inclusive; a null closing time stays open until switched off or the
-- start; a null opening time or start is closed. timestamptz throughout, so no
-- time zone is involved, and nothing compares a time for equality: the job asks
-- "open now?" against what was announced, so a late run still sees a boundary.
--
-- Re-runnable.

-- Counts each event's window transitions, so an occurrence key is derived from
-- stored state: a retry of a rolled-back transition reuses its key, and a later
-- reopening can never collide with an earlier one, whatever the dates.
alter table registration_notice_state
  add column if not exists window_generation integer not null default 0;

-- 041's handler, with keys opened:<n> and closed:<n> from window_generation
-- instead of the clock.

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
    case when v_open then 'opened:' else 'closed:' end || v_generation,
    v_details,
    -- Only the Organiser saves registration settings.
    case when p_cause = 'settings_changed' then v_event.organiser_id end);
end;
$$;
revoke execute on function announce_registration_window(uuid, text) from public, anon, authenticated;

-- One run of the job. Every event whose window differs from what was announced
-- is due, however long ago its boundary passed, so a run after downtime catches
-- up. A window that opened and closed again while nobody ran is not announced
-- at all: both notices would be stale, and nothing is open to act on.
--
-- Each event is decided again under its lock by announce_registration_window,
-- from the dates as they are now, so a date moved or registration switched off
-- since the boundary sends nothing obsolete. A change a flow already announced
-- has recorded its state, so the job finds nothing to do for it.
--
-- Before announcing an opening, it hands any free places to the waiting list
-- (as the flows do) so a queued attendee who gets one is told that instead,
-- and announces a capacity that promotion filled.
--
-- One event failing (its own subtransaction is rolled back) does not stop the
-- rest; it stays due and is retried next run. Returns
-- { notified, events, failures: [{ eventRequestId, message }] }.

create or replace function process_registration_window_notices()
returns jsonb
language plpgsql
as $$
declare
  v_event_id uuid;
  v_notified integer := 0;
  v_events integer := 0;
  v_failures jsonb := '[]'::jsonb;
begin
  for v_event_id in
    select e.id
      from event_requests e
      left join registration_notice_state s on s.event_request_id = e.id
     where (registration_closed_reason(e, clock_timestamp()) is null)
           is distinct from coalesce(s.open_announced, false)
     -- Event locks are held to the end of the run; a fixed order keeps two
     -- concurrent runs from deadlocking on each other.
     order by e.id
  loop
    begin
      if promote_waitlisted_registrations(v_event_id) > 0 then
        v_notified := v_notified + announce_registration_capacity(v_event_id, 'promotion');
      end if;
      v_notified := v_notified + announce_registration_window(v_event_id, null);
      v_events := v_events + 1;
    exception when others then
      v_failures := v_failures || jsonb_build_object('eventRequestId', v_event_id, 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('notified', v_notified, 'events', v_events, 'failures', v_failures);
end;
$$;
revoke execute on function process_registration_window_notices() from public, anon, authenticated;
