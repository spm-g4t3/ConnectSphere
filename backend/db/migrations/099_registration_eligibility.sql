-- Shared eligibility guard used by register_for_event inside its transaction.
-- Requires SCRUM-494 settings; the event lock is held through capacity checks and insertion.

create or replace function assert_event_registration_eligible(
  p_event_request_id uuid,
  p_attendee_id uuid
)
returns void
language plpgsql
as $$
declare
  v_event record;
  v_now timestamptz;
begin
  if p_attendee_id is null or p_event_request_id is null then
    raise exception 'An attendee and event are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from profiles where id = p_attendee_id and role = 'attendee'
  ) then
    raise exception 'This action is restricted to Attendees' using errcode = '42501';
  end if;

  select e.status, e.registration_enabled, e.registration_opens_at,
         e.registration_closes_at, e.proposed_start
    into v_event
    from event_requests e
   where e.id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;

  -- Read the clock after waiting for the lock; transaction-start time can be stale.
  v_now := clock_timestamp();

  if v_event.status::text is distinct from 'confirmed' then
    raise exception 'Registration requires a Confirmed event'
      using errcode = '55000', hint = 'EVENT_NOT_CONFIRMED';
  end if;
  if v_event.registration_enabled is distinct from true then
    raise exception 'Registration is disabled for this event'
      using errcode = '55000', hint = 'REGISTRATION_DISABLED';
  end if;
  if v_event.registration_opens_at is null or v_event.proposed_start is null then
    raise exception 'Registration dates are not configured for this event'
      using errcode = '55000', hint = 'REGISTRATION_DATES_MISSING';
  end if;
  if v_now < v_event.registration_opens_at then
    raise exception 'Registration has not opened yet'
      using errcode = '55000', hint = 'REGISTRATION_NOT_OPEN';
  end if;
  -- SCRUM-494 permits no closing time: registration then ends when disabled or at the event start.
  if v_event.registration_closes_at is not null and v_now >= v_event.registration_closes_at then
    raise exception 'Registration has closed for this event'
      using errcode = '55000', hint = 'REGISTRATION_CLOSED';
  end if;
  if v_now >= v_event.proposed_start then
    raise exception 'Registration is closed because the event has started'
      using errcode = '55000', hint = 'EVENT_STARTED';
  end if;

  -- No additional eligibility rules are configured; authenticated Attendees qualify.
end;
$$;

revoke execute on function assert_event_registration_eligible(uuid, uuid)
  from public, anon, authenticated;
grant execute on function assert_event_registration_eligible(uuid, uuid) to service_role;
