-- 060_equipment_reservation_topup.sql
-- SCRUM-300 "Reserve Equipment for an Event - Technical Support Staff"
--
-- Run after 056. Safe to run twice.
--
-- Reserving 2 of an item and then 2 more used to leave two reservation rows for
-- the same item and period. Now the second reservation is added to the first, so
-- the review shows one row per item.
--
--   * The history gets a new action, 'increased', for the top-up.
--   * reserve_equipment (055) is replaced. It adds to the item's live, unflagged
--     reservation for the event's current period when there is one, and creates a
--     new reservation otherwise (first reservation, or the old one is flagged,
--     released or for another period). Everything else is unchanged.


-- ---------------------------------------------------------------------
-- 1. The history can record a top-up
-- ---------------------------------------------------------------------
alter table equipment_reservation_events
  drop constraint if exists equipment_reservation_events_action_known;
alter table equipment_reservation_events
  add constraint equipment_reservation_events_action_known
    check (action in (
      'reserved', 'increased', 'reduced', 'released', 'moved', 'flagged', 'kept'
    ));


-- ---------------------------------------------------------------------
-- 2. Reserve adds to the existing reservation
-- ---------------------------------------------------------------------

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
  v_existing     equipment_reservations%rowtype;
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

  -- Reserving more of an item that already has a live reservation for this same
  -- period adds to that reservation instead of starting a second one, so the
  -- review shows one row per item. A flagged reservation is never topped up: it
  -- is waiting for a decision and its period may be the old one.
  select * into v_existing
    from equipment_reservations
   where equipment_line_id = v_line.id
     and released_at is null
     and not flagged
     and start_at = v_event.proposed_start
     and end_at   = v_event.proposed_end
   order by created_at, id
   limit 1
     for update;

  if found then
    update equipment_reservations
       set quantity = quantity + p_quantity
     where id = v_existing.id;

    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after,
       start_before, end_before, start_after, end_after)
    values
      (v_existing.id, p_event_request_id, v_line.id, 'increased', p_user_id,
       'Reserved more for the event', v_existing.quantity, v_existing.quantity + p_quantity,
       v_existing.start_at, v_existing.end_at, v_existing.start_at, v_existing.end_at);
  else
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
  end if;

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

