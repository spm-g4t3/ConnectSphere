-- Only withdrawn registrations may reactivate; inactive caller states cannot offer Register.
-- Requires registration migrations 091-094. Apply in one transaction before deploying the API.

create or replace function register_for_event(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_capacity integer;
  v_count bigint;
  v_registration event_registrations;
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

  select * into v_registration from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id for update;
  if v_registration.status = 'registered' then
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

  return jsonb_build_object(
    'outcome', 'registered', 'registeredCount', v_count + 1,
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'registeredAt', v_registration.registered_at,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;

revoke execute on function register_for_event(uuid, uuid) from public, anon, authenticated;
grant execute on function register_for_event(uuid, uuid) to service_role;

-- Extend the private RPC with only the caller's status; the HTTP allowlist stays unchanged.
drop function if exists open_event_registration_state(uuid[], uuid);
create function open_event_registration_state(p_event_ids uuid[], p_attendee_id uuid)
returns table (event_request_id uuid, active_count bigint, is_registered boolean, registration_status text)
language plpgsql
stable
as $fn$
begin
  if p_attendee_id is null then
    raise exception 'An attendee is required' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_attendee_id and role = 'attendee') then
    raise exception 'Only an attendee may read registration state' using errcode = '42501';
  end if;

  return query
    select r.event_request_id,
           count(*) filter (where r.status = 'registered'),
           coalesce(bool_or(r.attendee_id = p_attendee_id and r.status = 'registered'), false),
           max(r.status) filter (where r.attendee_id = p_attendee_id)
      from event_registrations r
     where r.event_request_id = any(coalesce(p_event_ids, '{}'::uuid[]))
       and (r.status = 'registered'
            or (r.attendee_id = p_attendee_id and r.status in ('waitlisted', 'cancelled')))
     group by r.event_request_id;
end;
$fn$;

revoke execute on function open_event_registration_state(uuid[], uuid) from public, anon, authenticated;
grant execute on function open_event_registration_state(uuid[], uuid) to service_role;
notify pgrst, 'reload schema';
