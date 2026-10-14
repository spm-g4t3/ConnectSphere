-- 061_equipment_review_gaps.sql
-- SCRUM-300 "Reserve Equipment for an Event - Technical Support Staff"
--
-- Gaps found reviewing 053 and 054. Redefines functions only, so it is safe to
-- run twice and on top of 038, 053, 054, 055 and 060.
--
--   complete_equipment_review   refuses while a live reservation is flagged (AC7).
--                               053 gave arrange_equipment_request_if_complete that
--                               check but not this function, so a review could be
--                               completed over reservations nobody had decided on.
--   start_equipment_review      runs the Arranged check once the review is Under
--                               review. Removing the one short line leaves a request
--                               with everything reserved; with no reservation action
--                               left to run the check, it stuck Under review and
--                               complete_equipment_review refused it.
--   equipment_review_for_event  each live reservation carries can_keep: flagged and
--                               equipment_reservation_keep_problem finds nothing
--                               wrong. A date change flags a reservation whose
--                               period then never matches the event, so Keep can
--                               never work for it; the screen offers Keep only
--                               where it can.
--   Keep and Move              count every live reservation on the line against
--                               what it needs, not just the one being decided.
--   Reserve, Reduce, Release,  lock the equipment type first, the same order an
--   Move and Keep              inventory change takes it, so the two cannot
--                               deadlock. Rows flagged together are locked in id
--                               order.
--   the review history         says why a flag ended a review, instead of "the
--                               lines were changed".

-- ---------------------------------------------------------------------
-- 1. Complete review (038), refusing while a reservation is flagged
-- ---------------------------------------------------------------------
create or replace function complete_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_short   integer;
  v_missing text[];
  v_flagged integer;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select count(*) into v_flagged
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where l.equipment_request_id = v_request.id
     and r.released_at is null
     and r.flagged;

  if v_flagged > 0 then
    raise exception
      'Decide on each flagged reservation before completing the review. Still to decide: %.',
      v_flagged
      using errcode = '55000';
  end if;

  select count(*),
         coalesce(array_agg(t.name order by t.name) filter (where l.outcome is null), '{}')
    into v_short, v_missing
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.equipment_request_id = v_request.id
     and l.removed_at is null
     and equipment_line_reserved(l.id) < l.quantity;

  if v_short = 0 then
    raise exception
      'Every line is fully reserved, so there is nothing to complete. Reserve the last line to arrange the request.'
      using errcode = '55000';
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'Add a note to each line that cannot be provided. Missing a note: %',
      array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  update equipment_lines l
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where l.equipment_request_id = v_request.id
     and l.outcome is not null
     and (l.removed_at is not null or equipment_line_reserved(l.id) >= l.quantity);

  update equipment_requests
     set status = 'cannot_be_fully_arranged'
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being completed'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'completed', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Start review (038), arranging at once when nothing is short
-- ---------------------------------------------------------------------
create or replace function start_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'Only Technical Support Staff can review equipment requests'
      using errcode = '42501';
  end if;

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status = 'under_review' then
    raise exception
      'This equipment request is already Under review. Take over the review instead.'
      using errcode = '55000';
  end if;

  if v_request.status not in ('pending_review', 'cannot_be_fully_arranged') then
    raise exception
      'A review can only start when the request is Pending review or Cannot be fully arranged. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  update equipment_requests
     set status = 'under_review',
         reviewer_id = p_user_id,
         review_started_at = now()
   where id = v_request.id
     and status in ('pending_review', 'cannot_be_fully_arranged');

  if not found then
    raise exception 'The equipment request changed while the review was being started'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'started', p_user_id);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. The review read (054), with can_keep on each reservation
-- ---------------------------------------------------------------------
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
                                'flagged_at',  r.flagged_at,
                                'can_keep',    r.flagged
                                               and equipment_reservation_keep_problem(r, v_event, l) is null
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


-- ---------------------------------------------------------------------
-- 4. Lock the equipment type before anything else
-- ---------------------------------------------------------------------
-- An inventory change holds the type row and then, through the flagging
-- triggers, wants the request. These actions used to hold the request and then
-- want the type. Taking the type first removes the cycle.

create or replace function lock_equipment_type_of_line(p_line_id uuid)
returns void
language plpgsql
as $$
declare
  v_type_id uuid;
begin
  select equipment_type_id into v_type_id from equipment_lines where id = p_line_id;
  if found then
    perform 1 from equipment_types where id = v_type_id for update;
  end if;
end;
$$;

create or replace function lock_equipment_type_of_reservation(p_reservation_id uuid)
returns void
language plpgsql
as $$
declare
  v_type_id uuid;
begin
  select equipment_type_id into v_type_id
    from equipment_reservations
   where id = p_reservation_id;
  if found then
    perform 1 from equipment_types where id = v_type_id for update;
  end if;
end;
$$;

-- The caller has already locked the type, then the event and request.
create or replace function lock_equipment_reservation(
  p_request        equipment_requests,
  p_reservation_id uuid
)
returns equipment_reservations
language plpgsql
as $$
declare
  v_line_id uuid;
  v_res     equipment_reservations%rowtype;
begin
  select r.equipment_line_id
    into v_line_id
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where r.id = p_reservation_id
     and l.equipment_request_id = p_request.id;

  if not found then
    raise exception 'Reservation not found' using errcode = 'P0002';
  end if;

  perform 1 from equipment_lines where id = v_line_id for update;

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


-- ---------------------------------------------------------------------
-- 5. Why a flag ended a review
-- ---------------------------------------------------------------------

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
  -- Id order, so two bulk flags that overlap cannot wait on each other.
  perform 1
     from equipment_reservations
    where id = any (p_reservation_ids)
      and released_at is null
      and not flagged
    order by id
      for update;

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
    perform 1
       from equipment_requests
      where event_request_id = any (v_events)
        and status not in ('pending_review', 'cancelled')
      order by id
        for update;

    -- Read by equipment_request_review_fields for the history note.
    perform set_config('equipment.interrupt_reason',
      'A reservation was flagged during the review. ' || p_reason || '.', true);

    update equipment_requests
       set status = 'pending_review'
     where event_request_id = any (v_events)
       and status not in ('pending_review', 'cancelled');

    perform set_config('equipment.interrupt_reason', '', true);
  end if;

  return v_count;
end;
$$;

create or replace function equipment_request_review_fields()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'under_review' then
    if old.status = 'under_review' and new.status in ('pending_review', 'cancelled') then
      insert into equipment_review_history
        (equipment_request_id, action, user_id, from_user_id, note)
      values (
        new.id, 'interrupted', null, old.reviewer_id,
        case new.status
          when 'cancelled' then 'The request was cancelled during the review'
          else coalesce(nullif(current_setting('equipment.interrupt_reason', true), ''),
                        'The lines were changed during the review')
        end
      );
    end if;
    new.reviewer_id := null;
    new.review_started_at := null;
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Keep and Move count every reservation on the line
-- ---------------------------------------------------------------------
-- A line can hold two flagged reservations that each fit its need on their own
-- (a date change, then the line cut down). Together they hold too much, so none
-- is kept or moved until some are reduced or released.

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

  if equipment_line_reserved(p_line.id) > p_line.quantity then
    return 'The reservations on this line hold more than the line now needs. Reduce or release some.';
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


-- ---------------------------------------------------------------------
-- 7. The five actions, type first
-- ---------------------------------------------------------------------
-- Order: equipment type, event, request, line, reservation. Whoever holds the
-- type recalculates availability alone, so two reviewers cannot both take the
-- last unit.

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
  perform lock_equipment_type_of_line(p_line_id);
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
  perform lock_equipment_type_of_reservation(p_reservation_id);
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
  perform lock_equipment_type_of_reservation(p_reservation_id);
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
  perform lock_equipment_type_of_reservation(p_reservation_id);
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

  if equipment_line_reserved(v_line.id) > v_line.quantity then
    raise exception
      'The reservations on this line hold % but the line now needs %. Reduce or release some first.',
      equipment_line_reserved(v_line.id), v_line.quantity
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
  perform lock_equipment_type_of_reservation(p_reservation_id);
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
