-- SCRUM-39: eligibility, capacity and insertion share the event lock and transaction.
-- Requires 079, 080 and SCRUM-494's registration_capacity column (null = unlimited).

create or replace function register_for_event(
  p_event_request_id uuid,
  p_attendee_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_capacity integer;
  v_registration registrations%rowtype;
begin
  -- This checks the stored role/settings and takes FOR UPDATE on the event.
  -- The lock remains held through the count and insert until this RPC commits.
  perform assert_event_registration_eligible(p_event_request_id, p_attendee_id);

  if exists (
    select 1 from registrations
     where event_request_id = p_event_request_id
       and attendee_id = p_attendee_id
       and status = 'registered'
  ) then
    raise exception 'Already registered'
      using errcode = '55000', hint = 'ALREADY_REGISTERED';
  end if;

  select registration_capacity into v_capacity
    from event_requests where id = p_event_request_id;

  if v_capacity is not null and (
    select count(*) from registrations
     where event_request_id = p_event_request_id and status = 'registered'
  ) >= v_capacity then
    raise exception 'Event is full'
      using errcode = '55000', hint = 'EVENT_FULL';
  end if;

  insert into registrations (event_request_id, attendee_id, status)
  values (p_event_request_id, p_attendee_id, 'registered')
  on conflict (attendee_id, event_request_id) where status = 'registered'
    do nothing
  returning * into v_registration;

  -- Target only the active-registration index; other write failures must abort.
  if not found then
    raise exception 'Already registered'
      using errcode = '55000', hint = 'ALREADY_REGISTERED';
  end if;

  return jsonb_build_object('outcome', 'registered', 'registration', to_jsonb(v_registration));
end;
$$;

revoke execute on function register_for_event(uuid, uuid) from public, anon, authenticated;
grant execute on function register_for_event(uuid, uuid) to service_role;
