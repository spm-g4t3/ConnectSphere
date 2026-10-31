-- Migration 049: registration notices are idempotent end to end (SCRUM-177, SCRUM-240).
-- 047 gave window notices keys from a stored counter; capacity notices still
-- took theirs from the clock, so a retry or an overlapping worker could have
-- minted a second key for one occurrence. They now count too.
--
-- How a registration notice is sent exactly once (docs/SCRUM-177.md, section 6):
-- - The transition is recorded in registration_notice_state, under the event
--   row lock, in the same transaction as its notifications. Both commit or
--   neither does, so a failed attempt leaves nothing done and is retried whole.
-- - The occurrence is (event, type, occurrenceKey), the key being the
--   transition's number from that row: the same transition always gets the same
--   number, a later one (a reopening, a refill) a higher one.
-- - notifications_one_per_registration_change, unique on (recipient, event,
--   type, occurrenceKey), makes a second row for the same occurrence and
--   recipient impossible, whatever path or worker writes it.
--
-- Re-runnable.

alter table registration_notice_state
  add column if not exists capacity_generation integer not null default 0;

-- 046's handler, with keys full:<n> and released:<n> from capacity_generation
-- instead of the clock.

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
