-- Migration 017: whether an attendee may withdraw a registration (SCRUM-57).
-- The withdrawal writer calls this in its own transaction and changes only the
-- row it returns, so the check and the write see the same locked state.

create or replace function assert_registration_withdrawable(
  p_registration_id uuid,
  p_attendee_id     uuid
)
returns event_registrations
language plpgsql
as $$
declare
  v_owner uuid;
  v_event_id uuid;
  v_deadline timestamptz;
  v_registration event_registrations;
  v_now timestamptz;
begin
  if p_registration_id is null or p_attendee_id is null then
    raise exception 'An attendee and registration are required' using errcode = '22023';
  end if;

  perform assert_caller_role(
    p_attendee_id, array['attendee'],
    'This action is restricted to Attendees'
  );

  select attendee_id, event_request_id
    into v_owner, v_event_id
    from event_registrations
   where id = p_registration_id;

  -- The same message for both, so an attendee cannot probe for other people's
  -- registration ids; the hint tells the API which one it was.
  if not found then
    raise exception 'Registration not found'
      using errcode = 'P0002', hint = 'REGISTRATION_NOT_FOUND';
  end if;
  if v_owner is distinct from p_attendee_id then
    raise exception 'Registration not found'
      using errcode = 'P0002', hint = 'REGISTRATION_NOT_OWNED';
  end if;

  -- Event before registration, the order register_for_event takes them in, so
  -- the two cannot deadlock. The event lock also holds the deadline and the
  -- registered count still until the writer commits.
  select registration_withdrawal_deadline
    into v_deadline
    from event_requests
   where id = v_event_id
     for update;

  select *
    into v_registration
    from event_registrations
   where id = p_registration_id
     for update;

  -- Read the clock after waiting for the locks; transaction-start time can be stale.
  v_now := clock_timestamp();

  if v_registration.status = 'withdrawn' then
    raise exception 'This registration has already been withdrawn'
      using errcode = '55000', hint = 'ALREADY_WITHDRAWN';
  end if;
  if v_registration.status is distinct from 'registered' then
    raise exception 'Only a confirmed registration can be withdrawn'
      using errcode = '55000', hint = 'REGISTRATION_NOT_CONFIRMED';
  end if;

  -- The deadline is optional and nothing says what its absence allows, so
  -- withdrawal is refused rather than guessed at until that rule is decided.
  if v_deadline is null then
    raise exception 'This event has no withdrawal deadline, so registrations cannot be withdrawn'
      using errcode = '55000', hint = 'WITHDRAWAL_DEADLINE_NOT_SET';
  end if;
  if v_now >= v_deadline then
    raise exception 'The withdrawal deadline for this event has passed'
      using errcode = '55000', hint = 'WITHDRAWAL_DEADLINE_PASSED';
  end if;

  return v_registration;
end;
$$;
revoke execute on function assert_registration_withdrawable(uuid, uuid) from public, anon, authenticated;
