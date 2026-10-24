-- Migration 018: an attendee withdraws a confirmed registration (SCRUM-59).
-- The row is kept and only its status changes; updated_at records when. Later
-- seat-release effects belong in this function, after the update, so they run
-- once per withdrawal and roll back with it.

create or replace function withdraw_registration(
  p_registration_id uuid,
  p_attendee_id     uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_registration event_registrations;
begin
  -- Locks the event and the registration until this transaction ends, so a
  -- concurrent second request waits here and is then refused ALREADY_WITHDRAWN.
  v_registration := assert_registration_withdrawable(p_registration_id, p_attendee_id);

  update event_registrations
     set status = 'withdrawn'
   where id = v_registration.id
     and status = 'registered'
  returning * into v_registration;

  if not found then
    raise exception 'Registration % changed while it was being withdrawn', p_registration_id
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'outcome', 'withdrawn',
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
