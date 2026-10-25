-- Migration 018: an attendee withdraws a confirmed registration.
-- The row is kept and only its status changes; updated_at records when. The
-- registered total is derived, never stored: every reader counts status
-- 'registered', so this status change is what releases the place. Anything later
-- done with that place belongs after the count here, so it runs once per
-- withdrawal and rolls back with it.

create or replace function withdraw_registration(
  p_registration_id uuid,
  p_attendee_id     uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_checked record;
  v_registration event_registrations;
  v_count bigint;
begin
  -- Locks the event and the registration until this transaction ends, so a
  -- concurrent second request waits here and is then refused ALREADY_WITHDRAWN,
  -- and a registration for this event cannot count around this change.
  select * into v_checked
    from assert_registration_withdrawable(p_registration_id, p_attendee_id);
  v_registration := v_checked.registration;

  update event_registrations
     set status = 'withdrawn'
   where id = v_registration.id
     and status = 'registered'
  returning * into v_registration;

  if not found then
    raise exception 'Registration % changed while it was being withdrawn', p_registration_id
      using errcode = '40001';
  end if;

  select count(*) into v_count
    from event_registrations
   where event_request_id = v_registration.event_request_id and status = 'registered';

  return jsonb_build_object(
    'outcome', 'withdrawn',
    'registeredCount', v_count,
    'capacity', v_checked.capacity,
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'registeredAt', v_registration.registered_at,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;
revoke execute on function withdraw_registration(uuid, uuid) from public, anon, authenticated;
