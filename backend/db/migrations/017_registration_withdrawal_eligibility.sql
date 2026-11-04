-- Migration 017: whether an attendee may withdraw a registration.
-- withdraw_registration (018) calls this in its own transaction and changes only
-- the row it returns, so the check and the write see the same locked state. The
-- capacity comes back too, read under the same event lock, so the caller need
-- not read the event again.

-- The return type changed while this was unreleased; a replace cannot change it.
drop function if exists assert_registration_withdrawable(uuid, uuid);

create or replace function assert_registration_withdrawable(
  p_registration_id uuid,
  p_attendee_id     uuid,
  out registration  event_registrations,
  out capacity      integer
)
language plpgsql
as $$
declare
  v_owner uuid;
  v_event_id uuid;
  v_event record;
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
  -- the two cannot deadlock. The event lock also holds the event's status,
  -- start, deadline and registered count still until the writer commits.
  select status, proposed_start, registration_withdrawal_deadline, registration_capacity
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  select *
    into registration
    from event_registrations
   where id = p_registration_id
     and attendee_id = p_attendee_id
     for update;

  -- Gone, or no longer theirs, while this waited for the locks.
  if not found then
    raise exception 'Registration not found'
      using errcode = 'P0002', hint = 'REGISTRATION_NOT_FOUND';
  end if;

  -- Read the clock after waiting for the locks; transaction-start time can be stale.
  v_now := clock_timestamp();

  if registration.status = 'withdrawn' then
    raise exception 'This registration has already been withdrawn'
      using errcode = '55000', hint = 'ALREADY_WITHDRAWN';
  end if;
  if registration.status is distinct from 'registered' then
    raise exception 'Only a confirmed registration can be withdrawn'
      using errcode = '55000', hint = 'REGISTRATION_NOT_CONFIRMED';
  end if;

  -- ACTIVE_EVENT_STATUSES (domain/eventRequestStatus.js). Cancelling, rejecting
  -- or completing an event leaves its registrations as they were, so the event's
  -- own status is what stops a withdrawal handing a place back. The message does
  -- not name the status: the attendee's event read keeps it private.
  if v_event.status::text <> all (array[
       'submitted', 'under_review', 'pending_clarification', 'approved',
       'safety_review', 'safety_approved', 'confirmed']) then
    raise exception 'Registrations for this event can no longer be withdrawn'
      using errcode = '55000', hint = 'EVENT_NOT_ACTIVE';
  end if;

  -- A change can move the start before a deadline set earlier; the start wins.
  if v_event.proposed_start is not null and v_now >= v_event.proposed_start then
    raise exception 'The event has started, so registrations can no longer be withdrawn'
      using errcode = '55000', hint = 'EVENT_STARTED';
  end if;

  -- The deadline is optional and nothing says what its absence allows, so
  -- withdrawal is refused rather than guessed at until that rule is decided.
  if v_event.registration_withdrawal_deadline is null then
    raise exception 'This event has no withdrawal deadline, so registrations cannot be withdrawn'
      using errcode = '55000', hint = 'WITHDRAWAL_DEADLINE_NOT_SET';
  end if;
  if v_now >= v_event.registration_withdrawal_deadline then
    raise exception 'The withdrawal deadline for this event has passed'
      using errcode = '55000', hint = 'WITHDRAWAL_DEADLINE_PASSED';
  end if;

  capacity := v_event.registration_capacity;
end;
$$;
revoke execute on function assert_registration_withdrawable(uuid, uuid) from public, anon, authenticated;
