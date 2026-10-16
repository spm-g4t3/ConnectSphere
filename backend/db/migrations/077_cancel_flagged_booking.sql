-- The event's assigned coordinator or Venue Staff resolve a booking flagged for
-- review by cancelling it. Only this booking changes; the coordinator can then
-- request another venue or period. 076's trigger and booking_resolutions
-- already allow the move and the outcome.


-- ---------------------------------------------------------------------
-- cancel_flagged_booking
-- ---------------------------------------------------------------------
-- withdraw_booking_request's (066) lock order and coordinator check, with
-- Venue Staff allowed too. Any flag can be cancelled, a safety flag included.
-- No venue lock: cancelling only frees occupancy, so it cannot cause a clash.

create or replace function cancel_flagged_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_event       event_requests;
  v_booking     bookings;
  v_resolution  booking_resolutions;
begin
  -- 1. A reason is required, checked as 076 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to cancel a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event, unlocked as in 066; then the event, locked.
  select b.event_request_id
    into v_event_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 3. The event's assigned coordinator, or Venue Staff. A null caller is
  --    refused explicitly (see 018).
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null
     or (v_event.assigned_coordinator_id is distinct from p_caller
         and v_role is distinct from 'venue_staff') then
    raise exception 'only the coordinator assigned to event request % or Venue Staff can cancel a flagged booking',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. Lock the booking and read its status as it is now.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be cancelled',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  -- 5. The record, with the flag as it stood.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by)
  values (p_booking_id, 'cancelled', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by)
  returning * into v_resolution;

  -- 6. Cancelled, guarded so it only ever moves a flagged booking. The flag
  --    stays on the booking, so it still shows why it was flagged.
  update bookings
     set status = 'cancelled'
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being cancelled', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  return jsonb_build_object('outcome', 'cancelled',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;

-- As 066: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function cancel_flagged_booking(uuid, uuid, text)
  from public, anon, authenticated;
