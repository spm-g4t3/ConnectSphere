-- 024_equipment_availability.sql
-- SCRUM-67: Build backend logic to calculate available quantity
--
-- Part of SCRUM-23 "Check Equipment Availability for a Period - Technical
-- Support Staff". Run this once in the Supabase SQL Editor, after
-- 022_equipment_schema.sql (it reads equipment_types, equipment_reservations
-- and event_requests). Safe to re-run: create or replace.
--
-- One function, equipment_availability, holds the calculation, so the check
-- (SCRUM-23), the review of an equipment request (SCRUM-290) and reserving
-- equipment (SCRUM-300) can never disagree about what "available" means. The
-- reservation functions call it inside their own locked transaction.
--
-- For an equipment type and a period it returns one jsonb object:
--   found, retired     false/false for an unknown type, true/true for a
--                      retired one. Nothing else is returned in either case,
--                      and the caller turns it into "Unavailable" (AC11)
--   total, damaged, under_maintenance, reserved
--   available          total - damaged - under_maintenance - reserved, as it
--                      is: NEGATIVE when the type is over-committed for the
--                      period, which reserving and the equipment-lost check
--                      need to see. Flooring at zero is for display only and
--                      is done by the service wrapper (AC8)
--   reservations       the overlapping reservations, each with its event name,
--                      period, quantity and flagged marker (AC10)
--
-- Which reservations count (AC3 to AC7):
--   * overlap is strict on both sides: a reservation overlaps the period when
--     it starts before the period ends AND ends after the period starts, so
--     one that ends exactly when the period starts, or starts exactly when it
--     ends, does not (AC4)
--   * a flagged reservation still counts (AC6)
--   * a released reservation does not
--   * when an event is given, that event's own reservations are left out, so
--     an event is never blocked by what it already holds (AC7)
--
-- The function is `stable`, and for plpgsql Postgres enforces that: an insert,
-- update or delete added to it later fails. That is AC12, running a check
-- changes nothing, held by the database and not only by convention. It is not
-- security definer, so it runs with the caller's permissions, as 015 does.
--
-- Deliberately not done:
--   * no lock. A caller that reserves takes its own lock first
--   * no setup or return buffer around a reservation, which covers exactly the
--     event's period (a team decision recorded on SCRUM-23)
--   * no flooring, no result label and no message: those are the wrapper's


create or replace function equipment_availability(
  p_equipment_type_id uuid,
  p_start_at          timestamptz,
  p_end_at            timestamptz,
  p_event_request_id  uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_type         equipment_types%rowtype;
  v_reserved     integer;
  v_reservations jsonb;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'The period must end after it starts'
      using errcode = '22023';
  end if;

  select * into v_type from equipment_types where id = p_equipment_type_id;

  if not found then
    return jsonb_build_object('found', false, 'retired', false);
  end if;

  if v_type.retired_at is not null then
    return jsonb_build_object('found', true, 'retired', true);
  end if;

  select
    coalesce(sum(r.quantity), 0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',               r.id,
          'event_request_id', r.event_request_id,
          'event_name',       e.event_name,
          'quantity',         r.quantity,
          'start_at',         r.start_at,
          'end_at',           r.end_at,
          'flagged',          r.flagged
        )
        order by r.start_at, r.id
      ),
      '[]'::jsonb
    )
  into v_reserved, v_reservations
  from equipment_reservations r
  join event_requests e on e.id = r.event_request_id
  where r.equipment_type_id = p_equipment_type_id
    and r.released_at is null
    and r.start_at < p_end_at
    and r.end_at > p_start_at
    and (p_event_request_id is null or r.event_request_id <> p_event_request_id);

  return jsonb_build_object(
    'found',             true,
    'retired',           false,
    'total',             v_type.total_quantity,
    'damaged',           v_type.damaged_quantity,
    'under_maintenance', v_type.under_maintenance_quantity,
    'reserved',          v_reserved,
    'available',         v_type.total_quantity
                           - v_type.damaged_quantity
                           - v_type.under_maintenance_quantity
                           - v_reserved,
    'reservations',      v_reservations
  );
end;
$$;
