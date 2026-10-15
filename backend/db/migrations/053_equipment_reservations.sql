-- 053_equipment_reservations.sql
-- SCRUM-300 "Reserve Equipment for an Event - Technical Support Staff"
-- SCRUM-301 (schema) and SCRUM-302 (reserve function).
--
-- Run after 052. Safe to run twice.
--
-- What this adds:
--   * equipment_reservation_events: an append-only history of every reservation
--     action (AC8). The database refuses to update or delete a row in it.
--   * two columns on equipment_reservations for AC6: why a reservation was
--     flagged, and when.
--   * equipment_event_allows_reservations(): the one place that says which event
--     statuses allow reserving (AC1). Compared as text, like 037, so the Week 7
--     safety statuses (SCRUM-488) are a one-line addition below.
--   * reserve_equipment(): reserve units against a line (AC2, AC3).
--   * arrange_equipment_request_if_complete(): 038's check, now also refusing
--     while any live reservation is flagged (AC7).
--
-- Lock order, as 037 and 038: event row, then the equipment request, then its
-- line, then (new here) the equipment type row. Taking the type row last is what
-- stops two reviewers both taking the last unit (AC3).


-- ---------------------------------------------------------------------
-- 1. Flag details on a reservation (AC6)
-- ---------------------------------------------------------------------
alter table equipment_reservations
  add column if not exists flag_reason text,
  add column if not exists flagged_at  timestamptz;


-- ---------------------------------------------------------------------
-- 2. The history (AC8)
-- ---------------------------------------------------------------------
-- user_id null means the system did it (an automatic release or flag). Period and
-- quantity are recorded before and after, so a move or a reduction can be read
-- back without comparing rows. Rows are never updated or deleted.

create table if not exists equipment_reservation_events (
  id                      bigint generated always as identity primary key,
  equipment_reservation_id uuid not null references equipment_reservations(id),
  event_request_id        uuid not null references event_requests(id),
  equipment_line_id       uuid references equipment_lines(id),
  action                  text not null,
  user_id                 uuid references auth.users(id),
  reason                  text,
  quantity_before         integer,
  quantity_after          integer,
  start_before            timestamptz,
  end_before              timestamptz,
  start_after             timestamptz,
  end_after               timestamptz,
  created_at              timestamptz not null default now(),

  constraint equipment_reservation_events_action_known
    check (action in (
      'reserved', 'reduced', 'released', 'moved', 'flagged', 'kept'
    ))
);

create index if not exists equipment_reservation_events_reservation_idx
  on equipment_reservation_events (equipment_reservation_id, id);
create index if not exists equipment_reservation_events_event_idx
  on equipment_reservation_events (event_request_id, id);

alter table equipment_reservation_events enable row level security;

create or replace function equipment_reservation_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'The reservation history cannot be changed or deleted'
    using errcode = '55000';
end;
$$;

drop trigger if exists equipment_reservation_events_no_change
  on equipment_reservation_events;
create trigger equipment_reservation_events_no_change
  before update or delete on equipment_reservation_events
  for each row execute function equipment_reservation_events_append_only();


-- ---------------------------------------------------------------------
-- 3. Which event statuses allow reserving (AC1)
-- ---------------------------------------------------------------------
-- The single list. To let reviewers reserve during the safety statuses once
-- SCRUM-488 adds them, add 'safety_review' and 'safety_approved' to the array.
-- Text, not the enum, so this runs before those statuses exist.

create or replace function equipment_reservable_event_statuses()
returns text[]
language sql
immutable
as $$
  select array['approved', 'confirmed']::text[];
$$;

-- The event's status in words a reviewer knows, for the refusal message.
create or replace function equipment_event_status_words(p_status text)
returns text
language sql
immutable
as $$
  select case p_status
           when 'draft'                 then 'a Draft'
           when 'submitted'             then 'Submitted'
           when 'under_review'          then 'Under review'
           when 'pending_clarification' then 'Pending clarification'
           when 'approved'              then 'Approved'
           when 'confirmed'             then 'Confirmed'
           when 'safety_review'         then 'in Safety review'
           when 'safety_approved'       then 'Safety approved'
           when 'rejected'              then 'Rejected'
           when 'cancelled'             then 'Cancelled'
           when 'completed'             then 'Completed'
           else p_status
         end;
$$;

-- Refuses unless the event is in a status that allows reserving. The caller
-- already holds the event row's lock.
create or replace function assert_event_allows_reservations(p_event_request_id uuid)
returns void
language plpgsql
as $$
declare
  v_status text;
begin
  select status::text into v_status
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  if not (v_status = any (equipment_reservable_event_statuses())) then
    raise exception
      'Equipment can only be reserved while the event is Approved or Confirmed. This event is %.',
      equipment_event_status_words(v_status)
      using errcode = '55000';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. Reserve equipment (AC1, AC2, AC3)
-- ---------------------------------------------------------------------
-- One transaction: checks, the reservation, its history row, and the Arranged
-- check. Reserves for the event's current start to end, exactly (no buffers,
-- 024). Reserving less than the line needs is allowed; the line stays short.
--
-- The availability counted here is every other live reservation that overlaps
-- the period, including this event's own, so two lines of the same type cannot
-- between them take more than exists. Availability is read after the type row is
-- locked, so a second reviewer waits and then sees the updated figure.

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
     quantity_after, start_after, end_after)
  values
    (v_id, p_event_request_id, v_line.id, 'reserved', p_user_id,
     p_quantity, v_event.proposed_start, v_event.proposed_end);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. The Arranged check, now refusing while a reservation is flagged (AC7)
-- ---------------------------------------------------------------------
-- 038's function with one added condition. Same name and arguments, so this
-- replaces it.

create or replace function arrange_equipment_request_if_complete(
  p_equipment_request_id uuid,
  p_user_id              uuid
)
returns boolean
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_lines   integer;
  v_short   integer;
  v_flagged integer;
begin
  select * into v_request
    from equipment_requests
   where id = p_equipment_request_id
     for update;

  if not found or v_request.status <> 'under_review' then
    return false;
  end if;

  select count(*),
         count(*) filter (where equipment_line_reserved(l.id) < l.quantity)
    into v_lines, v_short
    from equipment_lines l
   where l.equipment_request_id = v_request.id
     and l.removed_at is null;

  if v_lines = 0 or v_short > 0 then
    return false;
  end if;

  select count(*) into v_flagged
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where l.equipment_request_id = v_request.id
     and r.released_at is null
     and r.flagged;

  if v_flagged > 0 then
    return false;
  end if;

  update equipment_lines
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where equipment_request_id = v_request.id
     and outcome is not null;

  update equipment_requests
     set status = 'arranged'
   where id = v_request.id
     and status = 'under_review';

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'arranged', p_user_id);

  return true;
end;
$$;
