-- 055_equipment_reservation_guards.sql
-- SCRUM-300 "Reserve Equipment for an Event - Technical Support Staff"
-- SCRUM-309: three gaps found reviewing the implementation against AC5 and AC8.
--
-- Run after 054. Safe to run twice.
--
--   * AC5: a request that is cancelled releases its reservations, whoever
--     cancels it. Until now the two paths that cancel a request (removing its
--     last line, cancelling the event) released first, so a third path would
--     have left the units held.
--   * AC8: reservations are never deleted. The tables only said so in a comment.
--   * AC8: every record carries a reason. A new reservation had none, so it now
--     records "Reserved for the event". reserve_equipment (053) is replaced with
--     that one change, so do not run 053 again after this file.


-- ---------------------------------------------------------------------
-- 1. A cancelled request releases its reservations (AC5)
-- ---------------------------------------------------------------------
-- Only this request's lines. An event can have a cancelled request and a newer
-- live one, and cancelling the old one must not touch the new one's units.

create or replace function equipment_release_on_request_cancelled()
returns trigger
language plpgsql
as $$
begin
  perform release_equipment_reservations(new.event_request_id, l.id, 'request cancelled', null)
     from equipment_lines l
    where l.equipment_request_id = new.id;
  return null;
end;
$$;

drop trigger if exists equipment_requests_release_on_cancelled on equipment_requests;
create trigger equipment_requests_release_on_cancelled
  after update of status on equipment_requests
  for each row
  when (new.status = 'cancelled' and old.status <> 'cancelled')
  execute function equipment_release_on_request_cancelled();


-- ---------------------------------------------------------------------
-- 2. Reservations are never deleted (AC8)
-- ---------------------------------------------------------------------

create or replace function equipment_reservations_no_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'A reservation cannot be deleted. Release it instead.'
    using errcode = '55000';
end;
$$;

drop trigger if exists equipment_reservations_never_deleted on equipment_reservations;
create trigger equipment_reservations_never_deleted
  before delete on equipment_reservations
  for each row execute function equipment_reservations_no_delete();


-- ---------------------------------------------------------------------
-- 3. A new reservation records a reason (AC8)
-- ---------------------------------------------------------------------
-- 053's reserve_equipment with the reason added to its history row.

create or replace function reserve_equipment(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid,
  p_quantity         integer
)
returns jsonb
language plpgsql
as $$
declare
  v_request      equipment_requests%rowtype;
  v_line         equipment_lines%rowtype;
  v_event        event_requests%rowtype;
  v_availability jsonb;
  v_unreserved   integer;
  v_available    integer;
  v_id           uuid;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  select * into v_event from event_requests where id = p_event_request_id;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'This event has no start and end yet, so there is no period to reserve for'
      using errcode = '55000';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  -- The type row's lock: whoever holds it recalculates availability alone.
  perform 1
     from equipment_types
    where id = v_line.equipment_type_id
      for update;

  v_unreserved := v_line.quantity - equipment_line_reserved(v_line.id);

  if p_quantity > v_unreserved then
    raise exception
      'Only % more can be reserved on this line (it needs % and % is already reserved)',
      greatest(v_unreserved, 0), v_line.quantity, equipment_line_reserved(v_line.id)
      using errcode = '22023';
  end if;

  v_availability := equipment_availability(
    v_line.equipment_type_id, v_event.proposed_start, v_event.proposed_end, null);

  if not coalesce((v_availability ->> 'found')::boolean, false) then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    raise exception 'This equipment type has been retired and cannot be reserved'
      using errcode = '55000';
  end if;

  v_available := (v_availability ->> 'available')::integer;

  if p_quantity > greatest(v_available, 0) then
    raise exception
      'Only % available for this period, so % cannot be reserved',
      greatest(v_available, 0), p_quantity
      using errcode = '22023';
  end if;

  insert into equipment_reservations
    (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
  values
    (v_line.equipment_type_id, p_event_request_id, v_line.id, p_quantity,
     v_event.proposed_start, v_event.proposed_end)
  returning id into v_id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_after, start_after, end_after)
  values
    (v_id, p_event_request_id, v_line.id, 'reserved', p_user_id,
     'Reserved for the event', p_quantity, v_event.proposed_start, v_event.proposed_end);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

