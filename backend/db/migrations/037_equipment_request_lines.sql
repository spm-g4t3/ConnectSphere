-- 037_equipment_request_lines.sql
-- SCRUM-245 and SCRUM-246: record, amend and remove equipment lines
--
-- Part of SCRUM-21 "Record Equipment Requirements for an Event - Event
-- Coordinator". Run this once in the Supabase SQL Editor, after
-- 022_equipment_schema.sql and 024_equipment_availability.sql, and after the
-- migrations that give event_requests its assigned_coordinator_id and its
-- approved status (014 and 020). Safe to re-run: columns are guarded, the
-- constraint is dropped only if present, and every function is create or
-- replace.
--
-- Every change to a line also changes the request it belongs to, and may
-- change reservations. Separate supabase-js calls cannot be rolled back, so
-- each change is one function, called through rpc, and the whole change
-- succeeds or fails together:
--
--   add_equipment_line      adds a line, creating the request if the event has
--                           none (or only a cancelled one). AC2 to AC5, AC9.
--   amend_equipment_line    changes a line's quantity or technical notes, and
--                           flags the line's live reservations. AC6, AC7.
--   remove_equipment_line   removes a line and releases its reservations; the
--                           last line cancels the request. AC6, AC7, AC8.
--   equipment_for_event     reads the event's current request and its lines.
--                           stable, so a read can never change anything.
--
-- What every change checks, under the event row's lock, so the answer cannot
-- change before the write (assert_equipment_editable):
--   * the caller is the event's assigned coordinator          42501  AC1
--   * the event is approved                                   55000  AC1, AC10
--   * the event exists                                        P0002
-- A refused call changes nothing.
--
-- Lock order, for 290 and 300 to follow so they cannot deadlock with this:
-- the event row first, then the request row, then line and reservation rows.
--
-- Lines are removed softly. 022 says a line that still has a reservation
-- cannot be deleted, and equipment_reservations.equipment_line_id has no
-- cascade, so even a released reservation blocks the delete. Reservations are
-- kept as history (022), which means the line they name has to stay too. A
-- removed line therefore keeps its row, with removed_at and removed_by set,
-- and every read ignores it. The "one line per type per request" rule becomes
-- a partial unique index over lines that are not removed, so a type can be
-- added again after it was removed. The index keeps the old constraint's name,
-- so a duplicate still answers 23505 naming equipment_lines_one_per_type.
--
-- Deliberately not done:
--   * No outcome fields. SCRUM-290 adds reviewer and line outcome columns, and
--     must clear a changed line's outcome when it does (subtask 245).
--   * No reservations are created here. SCRUM-300 does that. This migration
--     only flags and releases reservations that already exist.
--   * No notifications. Technical Support Staff are told by SCRUM-176.
--   * No change history table. No acceptance criterion asks for one.
--   * Nothing here moves the event's own status.


-- ---------------------------------------------------------------------
-- 1. Soft removal of lines
-- ---------------------------------------------------------------------

alter table equipment_lines
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references auth.users(id);

alter table equipment_lines
  drop constraint if exists equipment_lines_removed_consistent;
alter table equipment_lines
  add constraint equipment_lines_removed_consistent
  check (removed_at is not null or removed_by is null);

alter table equipment_lines
  drop constraint if exists equipment_lines_one_per_type;

create unique index if not exists equipment_lines_one_per_type
  on equipment_lines (equipment_request_id, equipment_type_id)
  where removed_at is null;


-- ---------------------------------------------------------------------
-- 2. The guard every change goes through
-- ---------------------------------------------------------------------
-- Locks the event row, then refuses anyone but the assigned coordinator, then
-- refuses any status but approved. The refusal names the status in words a
-- coordinator knows, not the internal name. A confirmed event, and the safety
-- statuses SCRUM-488 adds, get the significant-change message (AC10). They are
-- compared as text so this runs before those statuses exist.

create or replace function assert_equipment_editable(
  p_event_request_id uuid,
  p_coordinator_id   uuid
)
returns void
language plpgsql
as $$
declare
  v_assigned uuid;
  v_status   text;
begin
  select assigned_coordinator_id, status::text
    into v_assigned, v_status
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  if v_assigned is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned coordinator can change its equipment'
      using errcode = '42501';
  end if;

  if v_status = 'approved' then
    return;
  end if;

  if v_status in ('confirmed', 'safety_review', 'safety_approved') then
    raise exception
      'Equipment on this event can only be changed as a significant change'
      using errcode = '55000';
  end if;

  raise exception
    'Equipment can only be changed while the event is Approved. This event is %.',
    case v_status
      when 'draft'                 then 'a Draft'
      when 'submitted'             then 'Submitted'
      when 'under_review'          then 'Under review'
      when 'pending_clarification' then 'Pending clarification'
      when 'rejected'              then 'Rejected'
      when 'cancelled'             then 'Cancelled'
      when 'completed'             then 'Completed'
      else v_status
    end
    using errcode = '55000';
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Reading an event's equipment
-- ---------------------------------------------------------------------
-- The current request is the latest one that is not cancelled. An event whose
-- only requests are cancelled shows the latest cancelled one, so the screen can
-- say so. Removed lines are left out. Returns {"request": null} for an event
-- that has never asked for equipment.

create or replace function equipment_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_request equipment_requests%rowtype;
begin
  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id',         v_request.id,
      'status',     v_request.status,
      'created_at', v_request.created_at,
      'updated_at', v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'created_at',        l.created_at,
                   'updated_at',        l.updated_at
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
-- 4. Add a line
-- ---------------------------------------------------------------------
-- The first line creates the request as pending_review (AC5). A line added to
-- an event whose request is cancelled creates a new request and leaves the
-- cancelled one as history (AC9). Any addition returns the request to
-- pending_review, whatever it was (AC7).

create or replace function add_equipment_line(
  p_event_request_id  uuid,
  p_coordinator_id    uuid,
  p_equipment_type_id uuid,
  p_quantity          integer,
  p_technical_notes   text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_type    equipment_types%rowtype;
  v_request equipment_requests%rowtype;
begin
  perform assert_equipment_editable(p_event_request_id, p_coordinator_id);

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  select * into v_type from equipment_types where id = p_equipment_type_id;

  if not found then
    raise exception 'That equipment type does not exist' using errcode = '22023';
  end if;

  if v_type.retired_at is not null then
    raise exception 'That equipment type is retired and cannot be chosen'
      using errcode = '22023';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
     and status <> 'cancelled'
   order by created_at desc, id desc
   limit 1
     for update;

  if not found then
    insert into equipment_requests (event_request_id)
    values (p_event_request_id)
    returning * into v_request;
  end if;

  if exists (
    select 1
      from equipment_lines
     where equipment_request_id = v_request.id
       and equipment_type_id = p_equipment_type_id
       and removed_at is null
  ) then
    raise exception 'That equipment type is already on this event'
      using errcode = '23505';
  end if;

  insert into equipment_lines (equipment_request_id, equipment_type_id, quantity, technical_notes)
  values (v_request.id, p_equipment_type_id, p_quantity, nullif(btrim(p_technical_notes), ''));

  update equipment_requests
     set status = 'pending_review'
   where id = v_request.id
     and status <> 'pending_review';

  return equipment_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Amend a line
-- ---------------------------------------------------------------------
-- Changes only quantity and technical notes (AC6). Changing a line's type is a
-- remove followed by an add. p_change_notes says the notes were sent, because a
-- null p_technical_notes alone cannot tell "clear them" from "leave them".
--
-- A real change returns the request to pending_review and flags the line's live
-- reservations. They keep holding the equipment until Technical Support Staff
-- act on them (AC7, subtask 246). A call that changes nothing is not an
-- amendment: no status change and no flag.

create or replace function amend_equipment_line(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_line_id          uuid,
  p_quantity         integer default null,
  p_technical_notes  text    default null,
  p_change_notes     boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_line      equipment_lines%rowtype;
  v_quantity  integer;
  v_notes     text;
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

  if p_quantity is null and not p_change_notes then
    raise exception 'Nothing to change: give a quantity, technical notes, or both'
      using errcode = '22023';
  end if;

  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  v_quantity := coalesce(p_quantity, v_line.quantity);
  v_notes := case
               when p_change_notes then nullif(btrim(p_technical_notes), '')
               else v_line.technical_notes
             end;

  if v_quantity = v_line.quantity and v_notes is not distinct from v_line.technical_notes then
    return equipment_for_event(p_event_request_id);
  end if;

  update equipment_lines
     set quantity = v_quantity,
         technical_notes = v_notes
   where id = v_line.id;

  update equipment_reservations
     set flagged = true
   where equipment_line_id = v_line.id
     and released_at is null
     and flagged = false;

  update equipment_requests
     set status = 'pending_review'
   where id = v_line.equipment_request_id
     and status <> 'pending_review';

  return equipment_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Remove a line
-- ---------------------------------------------------------------------
-- The line's live reservations are released, never deleted: released_at,
-- released_by and release_reason keep the history (022). The reason is "line
-- removed", or "request cancelled" when this was the last line, in which case
-- the request is cancelled too (AC8). Otherwise the request returns to
-- pending_review (AC7).

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

  update equipment_reservations
     set released_at = now(),
         released_by = p_coordinator_id,
         release_reason = v_reason
   where equipment_line_id = v_line.id
     and released_at is null;

  update equipment_requests
     set status = case when v_others = 0 then 'cancelled'::equipment_request_status
                       else 'pending_review'::equipment_request_status end
   where id = v_line.equipment_request_id
     and status <> case when v_others = 0 then 'cancelled'::equipment_request_status
                        else 'pending_review'::equipment_request_status end;

  return equipment_for_event(p_event_request_id);
end;
$$;
