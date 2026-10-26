-- Migration 020: which reservations a lower usable quantity would affect (SCRUM-311,
-- a subtask of SCRUM-310).
-- Damage, maintenance, a smaller total or retiring a type all leave fewer usable
-- units. This function answers which of the type's reservations that cannot keep
-- their equipment, so Technical Support can see them before anything is saved.
-- It only reads. The confirmed save (SCRUM-313) is the one that writes.

create or replace function equipment_over_commitment(
  p_equipment_type_id uuid,
  p_usable_after      integer,
  p_caller            uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_res        record;
  v_kept_start timestamptz[] := '{}';
  v_kept_end   timestamptz[] := '{}';
  v_kept_qty   integer[]     := '{}';
  v_peak       integer;
  v_affected   jsonb         := '[]'::jsonb;
begin
  perform assert_caller_role(
    p_caller, array['technical_support_staff'],
    'Only Technical Support Staff can check what a change to equipment affects'
  );

  if p_usable_after is null or p_usable_after < 0 then
    raise exception 'The usable quantity must be zero or more'
      using errcode = '22023';
  end if;

  if not exists (select 1 from equipment_types where id = p_equipment_type_id) then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  -- Oldest reservation first, so the oldest keep their equipment (AC3). Only
  -- reservations that are still held and have not yet ended count (AC1); a
  -- flagged one is still held, so it takes part in the pass like any other.
  for v_res in
    select r.id,
           r.event_request_id,
           r.equipment_line_id,
           r.quantity,
           r.start_at,
           r.end_at,
           r.flagged,
           r.created_at,
           e.event_name,
           e.assigned_coordinator_id,
           c.full_name as coordinator_name
      from equipment_reservations r
      join event_requests e on e.id = r.event_request_id
      left join profiles c on c.id = e.assigned_coordinator_id
     where r.equipment_type_id = p_equipment_type_id
       and r.released_at is null
       and r.end_at > now()
     order by r.created_at, r.id
  loop
    -- The kept quantity only changes where a kept reservation starts, so the
    -- peak over this reservation's period is found at its own start and at each
    -- kept start inside it. A period is half-open: one that ends at the moment
    -- another starts does not overlap it.
    select coalesce(max(load), 0)
      into v_peak
      from (
        select (
                 select coalesce(sum(k.qty), 0)
                   from unnest(v_kept_start, v_kept_end, v_kept_qty) as k(s, e, qty)
                  where k.s <= t.at
                    and k.e >  t.at
               ) as load
          from (
            select v_res.start_at as at
            union
            select k.s
              from unnest(v_kept_start, v_kept_end, v_kept_qty) as k(s, e, qty)
             where k.s > v_res.start_at
               and k.s < v_res.end_at
          ) t
      ) peaks;

    if v_peak + v_res.quantity > p_usable_after then
      v_affected := v_affected || jsonb_build_array(jsonb_build_object(
        'reservation_id',       v_res.id,
        'event_request_id',     v_res.event_request_id,
        'event_name',           v_res.event_name,
        'equipment_line_id',    v_res.equipment_line_id,
        'quantity',             v_res.quantity,
        'start_at',             v_res.start_at,
        'end_at',               v_res.end_at,
        'coordinator_id',       v_res.assigned_coordinator_id,
        'coordinator_name',     v_res.coordinator_name,
        'flagged',              v_res.flagged,
        'reserved_at',          v_res.created_at
      ));
    else
      v_kept_start := v_kept_start || v_res.start_at;
      v_kept_end   := v_kept_end   || v_res.end_at;
      v_kept_qty   := v_kept_qty   || v_res.quantity;
    end if;
  end loop;

  return v_affected;
end;
$$;
