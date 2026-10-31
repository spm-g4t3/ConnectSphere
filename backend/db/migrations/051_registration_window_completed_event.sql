-- Migration 051: a completed event settles its registration window silently (SCRUM-177, SCRUM-242).
-- Completion (034) is allowed only after the event ends, by when registration
-- closed at the start. If the opening/closing job was off or down across the
-- start, the window was still recorded open, and completing the event then sent
-- "registration has closed: the event is no longer confirmed" to the managers
-- and the queue after the event. A completed event is now final like a
-- cancelled one: the state is recorded and nothing is sent.
--
-- Re-runnable.

-- 047's handler, with completed beside cancelled.

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
    -- Both are final. A cancellation sends its own notice to the managers and
    -- to registered and queued attendees (042); a completed event has ended,
    -- so a closing notice would only be stale.
    if v_event.status::text in ('cancelled', 'completed') then
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
