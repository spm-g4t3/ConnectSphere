-- 043_release_event_arrangements.sql
-- SCRUM-372: release arrangements for a cancelled or rejected event.
--
-- Run after 011_venue_blocks.sql, 022_equipment_schema.sql,
-- 027_booking_request_statuses.sql and 038_equipment_review.sql.
-- Safe to re-run.
--
-- Present and released here:
--   * pending venue booking requests in bookings -> withdrawn
--   * approved and flagged_for_review bookings in bookings -> cancelled;
--     every row for the event is processed, including multi-venue bookings
--   * equipment_requests -> cancelled
--   * active equipment_reservations -> released with the supplied reason
--     (using the existing release fields; no N15 release function exists in
--     this repository)
--
-- Pending because no corresponding table exists in this repository:
--   * separate tentative venue holds
--   * on-site support assignments
--
-- This function does not change event_requests.status. Callers such as event
-- cancellation and event rejection own that transition and invoke this
-- function in the same transaction.

create or replace function release_event_arrangements(
  p_event_request_id uuid,
  p_reason           text
)
returns void
language plpgsql
as $$
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Release reason is required and cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  update bookings
     set status = case
       when status = 'pending' then 'withdrawn'::booking_status
       else 'cancelled'::booking_status
     end
   where event_request_id = p_event_request_id
     and status in ('pending', 'approved', 'flagged_for_review');

  update equipment_reservations
     set released_at = now(),
         released_by = null,
         release_reason = p_reason
   where event_request_id = p_event_request_id
     and released_at is null;

  update equipment_requests
     set status = 'cancelled'
   where event_request_id = p_event_request_id
     and status <> 'cancelled';
end;
$$;

notify pgrst, 'reload schema';
