-- 054_equipment_reservation_actions.sql
-- SCRUM-300 "Reserve Equipment for an Event - Technical Support Staff"
-- SCRUM-303 (reduce and release), SCRUM-304 (move and keep),
-- SCRUM-305 (automatic release), SCRUM-306 (flagging).
--
-- Run after 053. Safe to run twice.
--
-- Replaces three existing functions with the same names and arguments, each with
-- one change, so do not run the older files again after this one:
--   * remove_equipment_line (037): releases through release_equipment_reservations
--   * release_event_arrangements (048): the same
--   * equipment_review_for_event (038): each line also lists its live reservations
--
-- The history rows (053) are written by the functions below. The four automatic
-- paths (event period change, line change, equipment unusable, event completed)
-- are triggers, because the changes arrive from several places and a function
-- called from each place would miss one.


-- ---------------------------------------------------------------------
-- 1. Release reservations, with history (AC5, AC8)
-- ---------------------------------------------------------------------
-- p_line null releases every live reservation of the event. p_user null means
-- the system. Returns how many were released.

create or replace function release_equipment_reservations(
  p_event_request_id uuid,
  p_line_id          uuid,
  p_reason           text,
  p_user_id          uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  with released as (
    update equipment_reservations
       set released_at = now(),
           released_by = p_user_id,
           release_reason = p_reason
     where event_request_id = p_event_request_id
       and (p_line_id is null or equipment_line_id = p_line_id)
       and released_at is null
    returning id, event_request_id, equipment_line_id, quantity, start_at, end_at
  ), written as (
    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after, start_before, end_before)
    select id, event_request_id, equipment_line_id, 'released', p_user_id,
           p_reason, quantity, 0, start_at, end_at
      from released
    returning 1
  )
  select count(*) into v_count from released;

  return v_count;
end;
$$;


-- 037's remove_equipment_line, releasing through the function above.
create or replace function remove_equipment_line(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_line_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_line   equipment_lines%rowtype;
  v_others integer;
  v_reason text;
begin
  perform assert_equipment_editable(p_event_request_id, p_coordinator_id);

  select l.* into v_line
    from equipment_lines l
    join equipment_requests r on r.id = l.equipment_request_id
   where l.id = p_line_id
     and r.event_request_id = p_event_request_id
     and r.status <> 'cancelled'
     and l.removed_at is null
     for update of l;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  select count(*) into v_others
    from equipment_lines
   where equipment_request_id = v_line.equipment_request_id
     and removed_at is null
     and id <> v_line.id;

  v_reason := case when v_others = 0 then 'request cancelled' else 'line removed' end;

  update equipment_lines
     set removed_at = now(),
         removed_by = p_coordinator_id
   where id = v_line.id;

  perform release_equipment_reservations(p_event_request_id, v_line.id, v_reason, null);

  update equipment_requests
     set status = case when v_others = 0 then 'cancelled'::equipment_request_status
                       else 'pending_review'::equipment_request_status end
   where id = v_line.equipment_request_id
     and status <> case when v_others = 0 then 'cancelled'::equipment_request_status
                        else 'pending_review'::equipment_request_status end;

  return equipment_for_event(p_event_request_id);
end;
$$;


-- 048's release_event_arrangements, releasing the reservations through the
-- function above so the history records the system release (AC5).
create or replace function release_event_arrangements(
  p_event_request_id uuid,
  p_reason text,
  p_released_by uuid default null
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

  perform release_equipment_reservations(p_event_request_id, null, p_reason, null);

  update equipment_requests
     set status = 'cancelled'
   where event_request_id = p_event_request_id
     and status <> 'cancelled';

  update venue_holds
     set status = 'released',
         released_at = now(),
         released_by = p_released_by
   where event_request_id = p_event_request_id
     and status = 'active';
end;
$$;


-- An event that is completed no longer needs its equipment held (AC5).
create or replace function equipment_release_on_event_completed()
returns trigger
language plpgsql
as $$
begin
  perform release_equipment_reservations(new.id, null, 'event completed', null);
  return null;
end;
$$;

drop trigger if exists event_requests_release_equipment_on_completed on event_requests;
create trigger event_requests_release_equipment_on_completed
  after update of status on event_requests
  for each row
  when (new.status::text = 'completed' and old.status::text is distinct from 'completed')
  execute function equipment_release_on_event_completed();


-- ---------------------------------------------------------------------
-- 2. Flagging (AC6)
-- ---------------------------------------------------------------------
-- A flagged reservation keeps its period and quantity. The request goes back to
-- Pending review, which also clears its reviewer (038's trigger). Called by the
-- triggers below with the system as the actor.

create or replace function flag_equipment_reservations(
  p_reservation_ids uuid[],
  p_reason          text
)
returns integer
language plpgsql
as $$
declare
  v_count  integer;
  v_events uuid[];
begin
  with flagged as (
    update equipment_reservations
       set flagged = true,
           flag_reason = p_reason,
           flagged_at = now()
     where id = any (p_reservation_ids)
       and released_at is null
       and not flagged
    returning id, event_request_id, equipment_line_id, quantity, start_at, end_at
  ), written as (
    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after, start_before, end_before,
       start_after, end_after)
    select id, event_request_id, equipment_line_id, 'flagged', null,
           p_reason, quantity, quantity, start_at, end_at, start_at, end_at
      from flagged
    returning 1
  )
  select count(*), array_agg(distinct event_request_id)
    into v_count, v_events
    from flagged;

  if v_count > 0 then
    update equipment_requests
       set status = 'pending_review'
     where event_request_id = any (v_events)
       and status not in ('pending_review', 'cancelled');
  end if;

  return v_count;
end;
$$;

-- The event's date or time changed: reservations for the old period are flagged.
create or replace function equipment_flag_on_event_period_change()
returns trigger
language plpgsql
as $$
begin
  perform flag_equipment_reservations(
    array(
      select id
        from equipment_reservations
       where event_request_id = new.id
         and released_at is null
         and (start_at is distinct from new.proposed_start
              or end_at is distinct from new.proposed_end)
    ),
    'The event date or time changed'
  );
  return null;
end;
$$;

drop trigger if exists event_requests_flag_equipment_on_period_change on event_requests;
create trigger event_requests_flag_equipment_on_period_change
  after update of proposed_start, proposed_end on event_requests
  for each row
  when (new.proposed_start is distinct from old.proposed_start
        or new.proposed_end is distinct from old.proposed_end)
  execute function equipment_flag_on_event_period_change();

-- A line's quantity or notes were amended.
create or replace function equipment_flag_on_line_change()
returns trigger
language plpgsql
as $$
begin
  perform flag_equipment_reservations(
    array(
      select id
        from equipment_reservations
       where equipment_line_id = new.id
         and released_at is null
    ),
    'The line quantity or notes were changed'
  );
  return null;
end;
$$;

drop trigger if exists equipment_lines_flag_reservations_on_change on equipment_lines;
create trigger equipment_lines_flag_reservations_on_change
  after update of quantity, technical_notes on equipment_lines
  for each row
  when (new.removed_at is null
        and (new.quantity is distinct from old.quantity
             or new.technical_notes is distinct from old.technical_notes))
  execute function equipment_flag_on_line_change();

-- Equipment became unusable: the type was retired, or fewer units are usable. A
-- reservation is flagged when its period is now over-committed.
create or replace function equipment_flag_on_type_unusable()
returns trigger
language plpgsql
as $$
declare
  v_ids uuid[];
begin
  if new.retired_at is not null then
    select array_agg(id) into v_ids
      from equipment_reservations
     where equipment_type_id = new.id
       and released_at is null;

    perform flag_equipment_reservations(coalesce(v_ids, '{}'), 'The equipment type was retired');
    return null;
  end if;

  select array_agg(r.id) into v_ids
    from equipment_reservations r
   where r.equipment_type_id = new.id
     and r.released_at is null
     and (equipment_availability(new.id, r.start_at, r.end_at, null) ->> 'available')::integer < 0;

  perform flag_equipment_reservations(coalesce(v_ids, '{}'), 'Fewer units of this equipment are usable');
  return null;
end;
$$;

drop trigger if exists equipment_types_flag_reservations_on_unusable on equipment_types;
create trigger equipment_types_flag_reservations_on_unusable
  after update of total_quantity, damaged_quantity, under_maintenance_quantity, retired_at
  on equipment_types
  for each row
  when ((new.retired_at is not null and old.retired_at is null)
        or (new.total_quantity - new.damaged_quantity - new.under_maintenance_quantity)
           < (old.total_quantity - old.damaged_quantity - old.under_maintenance_quantity))
  execute function equipment_flag_on_type_unusable();


-- ---------------------------------------------------------------------
-- 3. Shared pieces for the reviewer's actions
-- ---------------------------------------------------------------------

-- Why a reservation cannot simply stay as it is, or null when it can (AC7 Keep).
create or replace function equipment_reservation_keep_problem(
  p_reservation equipment_reservations,
  p_event       event_requests,
  p_line        equipment_lines
)
returns text
language plpgsql
as $$
declare
  v_availability jsonb;
begin
  if p_reservation.start_at is distinct from p_event.proposed_start
     or p_reservation.end_at is distinct from p_event.proposed_end then
    return 'Its period no longer matches the event. Move it, reduce it or release it.';
  end if;

  if p_reservation.quantity > p_line.quantity then
    return 'It holds more than the line now needs. Reduce it or release it.';
  end if;

  v_availability := equipment_availability(
    p_reservation.equipment_type_id, p_reservation.start_at, p_reservation.end_at, null);

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    return 'This equipment type has been retired. Release it.';
  end if;

  if (v_availability ->> 'available')::integer < 0 then
    return 'This equipment is over-committed for the period. Reduce it or release it.';
  end if;

  return null;
end;
$$;

-- Locks and returns a live reservation of the current request, in the order
-- 053 uses: line, then equipment type, then the reservation.
create or replace function lock_equipment_reservation(
  p_request        equipment_requests,
  p_reservation_id uuid
)
returns equipment_reservations
language plpgsql
as $$
declare
  v_line_id uuid;
  v_type_id uuid;
  v_res     equipment_reservations%rowtype;
begin
  select r.equipment_line_id, r.equipment_type_id
    into v_line_id, v_type_id
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where r.id = p_reservation_id
     and l.equipment_request_id = p_request.id;

  if not found then
    raise exception 'Reservation not found' using errcode = 'P0002';
  end if;

  perform 1 from equipment_lines where id = v_line_id for update;
  perform 1 from equipment_types where id = v_type_id for update;

  select * into v_res
    from equipment_reservations
   where id = p_reservation_id
     for update;

  if v_res.released_at is not null then
    raise exception 'This reservation has already been released'
      using errcode = '55000';
  end if;

  return v_res;
end;
$$;

create or replace function require_reservation_reason(p_reason text)
returns text
language plpgsql
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_reason is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. Reduce a reservation (AC4, AC7)
-- ---------------------------------------------------------------------
-- A flagged reservation that this fixes loses its flag; one that is still wrong
-- (its period no longer matches, say) stays flagged.

create or replace function reduce_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_quantity         integer,
  p_reason           text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_event   event_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_res     equipment_reservations%rowtype;
  v_reason  text;
  v_before  integer;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);
  v_reason := require_reservation_reason(p_reason);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);
  v_before := v_res.quantity;

  if p_quantity is null or p_quantity <= 0 or p_quantity >= v_res.quantity then
    raise exception
      'The new quantity must be a whole number above zero and below the % reserved. To give all of it back, release it.',
      v_res.quantity
      using errcode = '22023';
  end if;

  update equipment_reservations
     set quantity = p_quantity
   where id = v_res.id;

  v_res.quantity := p_quantity;

  if v_res.flagged then
    select * into v_event from event_requests where id = p_event_request_id;
    select * into v_line from equipment_lines where id = v_res.equipment_line_id;

    if equipment_reservation_keep_problem(v_res, v_event, v_line) is null then
      update equipment_reservations
         set flagged = false, flag_reason = null, flagged_at = null
       where id = v_res.id;
    end if;
  end if;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'reduced', p_user_id,
     v_reason, v_before, p_quantity, v_res.start_at, v_res.end_at, v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Release a reservation (AC4, AC7)
-- ---------------------------------------------------------------------

create or replace function release_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_res     equipment_reservations%rowtype;
  v_reason  text;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);
  v_reason := require_reservation_reason(p_reason);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  update equipment_reservations
     set released_at = now(),
         released_by = p_user_id,
         release_reason = v_reason
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'released', p_user_id,
     v_reason, v_res.quantity, 0, v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Resolve a flag: move (AC7)
-- ---------------------------------------------------------------------
-- Moves the reservation to the event's current period. Needs the units
-- available there, not counting the reservation itself, and not more than the
-- line now needs.

create or replace function move_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_request      equipment_requests%rowtype;
  v_event        event_requests%rowtype;
  v_line         equipment_lines%rowtype;
  v_res          equipment_reservations%rowtype;
  v_availability jsonb;
  v_available    integer;
  v_reason       text := coalesce(nullif(btrim(p_reason), ''),
                                  'Moved to the event''s current date and time');
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  if not v_res.flagged then
    raise exception 'Only a flagged reservation can be moved' using errcode = '55000';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  select * into v_line from equipment_lines where id = v_res.equipment_line_id;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'This event has no start and end yet, so there is no period to move to'
      using errcode = '55000';
  end if;

  if v_res.quantity > v_line.quantity then
    raise exception
      'This reservation holds % but the line now needs %. Reduce it first.',
      v_res.quantity, v_line.quantity
      using errcode = '22023';
  end if;

  v_availability := equipment_availability(
    v_res.equipment_type_id, v_event.proposed_start, v_event.proposed_end, null);

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    raise exception 'This equipment type has been retired and cannot be reserved'
      using errcode = '55000';
  end if;

  v_available := (v_availability ->> 'available')::integer;

  -- The reservation does not compete with itself.
  if exists (
    select 1
      from jsonb_array_elements(v_availability -> 'reservations') x
     where x ->> 'id' = v_res.id::text
  ) then
    v_available := v_available + v_res.quantity;
  end if;

  if v_res.quantity > greatest(v_available, 0) then
    raise exception
      'Only % available for the event''s current period, so % cannot be moved there',
      greatest(v_available, 0), v_res.quantity
      using errcode = '22023';
  end if;

  update equipment_reservations
     set start_at = v_event.proposed_start,
         end_at = v_event.proposed_end,
         flagged = false, flag_reason = null, flagged_at = null
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'moved', p_user_id,
     v_reason, v_res.quantity, v_res.quantity, v_res.start_at, v_res.end_at,
     v_event.proposed_start, v_event.proposed_end);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 7. Resolve a flag: keep (AC7)
-- ---------------------------------------------------------------------
-- Allowed only when the reservation's period already matches the event, it
-- holds no more than the line needs, and the type is not over-committed.

create or replace function keep_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_event   event_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_res     equipment_reservations%rowtype;
  v_problem text;
  v_reason  text := coalesce(nullif(btrim(p_reason), ''), 'Kept as it is');
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  if not v_res.flagged then
    raise exception 'Only a flagged reservation can be kept' using errcode = '55000';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  select * into v_line from equipment_lines where id = v_res.equipment_line_id;

  v_problem := equipment_reservation_keep_problem(v_res, v_event, v_line);
  if v_problem is not null then
    raise exception 'This reservation cannot be kept. %', v_problem using errcode = '55000';
  end if;

  update equipment_reservations
     set flagged = false, flag_reason = null, flagged_at = null
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'kept', p_user_id,
     v_reason, v_res.quantity, v_res.quantity, v_res.start_at, v_res.end_at,
     v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 8. The review read, with each line's live reservations
-- ---------------------------------------------------------------------
-- 038's equipment_review_for_event with one addition: each line carries its live
-- reservations (id, quantity, period, flag and flag reason), so the screen can
-- act on them. Same name and argument, so this replaces it.

create or replace function equipment_review_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event   event_requests%rowtype;
  v_request equipment_requests%rowtype;
  v_has_period boolean;
begin
  select * into v_event from event_requests where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  -- Order is not checked here: event_requests already refuses an end that is not
  -- after the start (001, event_requests_dates_ordered).
  v_has_period := v_event.proposed_start is not null
              and v_event.proposed_end is not null;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id',                      v_event.id,
      'name',                    v_event.event_name,
      'proposed_start',          v_event.proposed_start,
      'proposed_end',            v_event.proposed_end,
      'assigned_coordinator_id', v_event.assigned_coordinator_id
    ),
    'request', jsonb_build_object(
      'id',                v_request.id,
      'status',            v_request.status,
      'reviewer_id',       v_request.reviewer_id,
      'review_started_at', v_request.review_started_at,
      'created_at',        v_request.created_at,
      'updated_at',        v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'outcome_by',        l.outcome_by,
                   'outcome_at',        l.outcome_at,
                   'reservations',      coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',          r.id,
                                'quantity',    r.quantity,
                                'start_at',    r.start_at,
                                'end_at',      r.end_at,
                                'flagged',     r.flagged,
                                'flag_reason', r.flag_reason,
                                'flagged_at',  r.flagged_at
                              )
                              order by r.start_at, r.id
                            )
                       from equipment_reservations r
                      where r.equipment_line_id = l.id
                        and r.released_at is null
                   ), '[]'::jsonb),
                   'availability',      case when v_has_period then
                                          equipment_availability(
                                            l.equipment_type_id,
                                            v_event.proposed_start,
                                            v_event.proposed_end,
                                            v_event.id)
                                        end
                 )
                 order by t.name, l.id
               )
          from equipment_lines l
          join equipment_types t on t.id = l.equipment_type_id
         where l.equipment_request_id = v_request.id
           and l.removed_at is null
      ), '[]'::jsonb)
    )
  );
end;
$$;

