-- Migration 026: fixes to the confirmed save for lost equipment (SCRUM-310 review).
--
-- Replaces functions from 020, 021 and 023 in place, because those are already applied.
--
-- - One calculation. equipment_change_affected answers "usable before, usable after and
--    the reservations left short", with the rule for when a change can leave any short.
--    The preview and apply_equipment_change both call it. It was written twice (SQL and
--    JavaScript), and the rule skipped a retirement of a type with no usable units.
-- - A reservation already flagged for another reason (the event's date changed) is
--    flagged again as unavailable equipment when its equipment is lost: new reason, code
--    and 'flagged' event, which is what notifies the coordinator. One already flagged as
--    unavailable is left alone, and the date-change flow never overwrites it.
-- - The save lists the reservations it flagged, so its list and its count agree.
-- - A confirmation is accepted when everything the change leaves short was confirmed.
--    Extra ids are fine only for reservations of this type that have since ended or been
--    released; before, a reservation ending between preview and confirm refused the save.
-- - Backstop: a change to a type's quantities or retirement made outside
--    apply_equipment_change (a seed script, a fix in the SQL editor) still flags the
--    reservations it leaves short, newest first. 021 removed the old silent trigger.
--
-- Run after 020, 021 and 023. Re-runnable.

-- 1. One calculation. equipment_over_commitment_unchecked does the work with no caller
-- check, so the trigger below can use it; equipment_over_commitment is the same answer
-- for a Technical Support caller.

create or replace function equipment_over_commitment_unchecked(
  p_equipment_type_id uuid,
  p_usable_after      integer
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
  if p_usable_after is null or p_usable_after < 0 then
    raise exception 'The usable quantity must be zero or more'
      using errcode = '22023';
  end if;

  if not exists (select 1 from equipment_types where id = p_equipment_type_id) then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  -- Oldest reservation first, so the oldest keep their equipment. Only
  -- reservations still held and not yet ended count; a flagged one is still held,
  -- so it takes part in the pass like any other.
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

create or replace function equipment_over_commitment(
  p_equipment_type_id uuid,
  p_usable_after      integer,
  p_caller            uuid
)
returns jsonb
language plpgsql
stable
as $$
begin
  perform assert_caller_role(
    p_caller, array['technical_support_staff'],
    'Only Technical Support Staff can check what a change to equipment affects'
  );

  return equipment_over_commitment_unchecked(p_equipment_type_id, p_usable_after);
end;
$$;

-- The usable quantity before and after a change, and the reservations it leaves
-- short. Quantities left null stay as they are. Retiring takes every unit out of
-- use, so it is checked even when nothing was usable; any other change can only
-- leave a reservation short when it lowers the usable quantity.
create or replace function equipment_change_affected(
  p_equipment_type_id uuid,
  p_caller            uuid,
  p_total             integer default null,
  p_damaged           integer default null,
  p_under_maintenance integer default null,
  p_retire            boolean default false
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_type   equipment_types%rowtype;
  v_before integer;
  v_after  integer;
begin
  perform assert_caller_role(
    p_caller, array['technical_support_staff'],
    'Only Technical Support Staff can check what a change to equipment affects'
  );

  select * into v_type from equipment_types where id = p_equipment_type_id;
  if not found then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  v_before := v_type.total_quantity - v_type.damaged_quantity - v_type.under_maintenance_quantity;
  v_after  := case
                when coalesce(p_retire, false) then 0
                else coalesce(p_total, v_type.total_quantity)
                     - coalesce(p_damaged, v_type.damaged_quantity)
                     - coalesce(p_under_maintenance, v_type.under_maintenance_quantity)
              end;

  return jsonb_build_object(
    'usable_before', v_before,
    'usable_after',  v_after,
    'affected',      case
                       when coalesce(p_retire, false) or v_after < v_before
                         then equipment_over_commitment_unchecked(p_equipment_type_id, v_after)
                       else '[]'::jsonb
                     end
  );
end;
$$;

-- 2. Flagging returns the ids it flagged, and upgrades another kind of flag.

create or replace function flag_equipment_reservation_ids(
  p_reservation_ids uuid[],
  p_reason          text,
  p_user_id         uuid,
  p_code            text default 'equipment_lost'
)
returns uuid[]
language plpgsql
as $$
declare
  v_ids    uuid[];
  v_events uuid[];
begin
  -- Id order, so two bulk flags that overlap cannot wait on each other.
  -- A reservation is flagged if it is not flagged yet, or if it carries another kind of
  -- flag and this one has a code.
  perform 1
     from equipment_reservations
    where id = any (p_reservation_ids)
      and released_at is null
      and (not flagged or (p_code is not null and flag_code is distinct from p_code))
    order by id
      for update;

  with flagged as (
    update equipment_reservations
       set flagged = true,
           flag_reason = p_reason,
           flag_code = p_code,
           flagged_at = now()
     where id = any (p_reservation_ids)
       and released_at is null
       and (not flagged or (p_code is not null and flag_code is distinct from p_code))
    returning id, event_request_id, equipment_line_id, quantity, start_at, end_at
  ), written as (
    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after, start_before, end_before,
       start_after, end_after)
    select id, event_request_id, equipment_line_id, 'flagged', p_user_id,
           p_reason, quantity, quantity, start_at, end_at, start_at, end_at
      from flagged
    returning 1
  )
  select coalesce(array_agg(id), '{}'), array_agg(distinct event_request_id)
    into v_ids, v_events
    from flagged;

  if cardinality(v_ids) > 0 then
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

  return v_ids;
end;
$$;

create or replace function flag_equipment_reservations_by(
  p_reservation_ids uuid[],
  p_reason          text,
  p_user_id         uuid,
  p_code            text default 'equipment_lost'
)
returns integer
language plpgsql
as $$
begin
  return cardinality(flag_equipment_reservation_ids(p_reservation_ids, p_reason, p_user_id, p_code));
end;
$$;

-- 3. The confirmed save.

create or replace function equipment_loss_reason(p_retired boolean, p_note text)
returns text
language sql
immutable
as $$
  select case when p_retired then 'The equipment type was retired'
              else 'Fewer units of this equipment are usable' end
         || case when nullif(btrim(coalesce(p_note, '')), '') is not null
                 then ' (' || btrim(p_note) || ')' else '' end;
$$;

-- Returns jsonb:
--   { saved: false, affected: [...] }   what the change affects is not what was confirmed;
--                                        nothing was written
--   { saved: true, flagged_count, affected, equipment_type }
--                                        affected is the reservations this save flagged
--
-- p_confirmed_reservation_ids is the reservations the staff member was shown. Everything
-- the change leaves short must be on it. One on it that no longer needs flagging because
-- it ended or was released since the preview is fine: the save flags fewer than were
-- confirmed, never more.

create or replace function apply_equipment_change(
  p_equipment_type_id         uuid,
  p_caller                    uuid,
  p_total                     integer default null,
  p_damaged                   integer default null,
  p_under_maintenance         integer default null,
  p_retire                    boolean default false,
  p_fields                    jsonb   default '{}'::jsonb,
  p_note                      text    default null,
  p_confirmed_reservation_ids uuid[]  default '{}'
)
returns jsonb
language plpgsql
as $$
declare
  v_type          equipment_types%rowtype;
  v_saved         equipment_types%rowtype;
  v_retire        boolean := coalesce(p_retire, false);
  v_fields        jsonb   := coalesce(p_fields, '{}'::jsonb);
  v_note          text    := nullif(btrim(coalesce(p_note, '')), '');
  v_total         integer;
  v_damaged       integer;
  v_under         integer;
  v_affected      jsonb;
  v_current_ids   uuid[];
  v_confirmed_ids uuid[];
  v_flagged_ids   uuid[]  := '{}';
begin
  perform assert_caller_role(
    p_caller, array['technical_support_staff'],
    'Only Technical Support Staff can change equipment'
  );

  if p_confirmed_reservation_ids is null
     or array_position(p_confirmed_reservation_ids, null) is not null then
    raise exception 'The confirmed reservations must be a list of reservation ids'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_fields) <> 'object' then
    raise exception 'The fields to change must be an object' using errcode = '22023';
  end if;

  if p_total < 0 or p_damaged < 0 or p_under_maintenance < 0 then
    raise exception 'A quantity must be zero or more' using errcode = '22023';
  end if;

  if v_retire and (p_total is not null or p_damaged is not null
                   or p_under_maintenance is not null or v_fields <> '{}'::jsonb) then
    raise exception 'Retiring a type can not be combined with other changes'
      using errcode = '22023';
  end if;

  if not v_retire and p_total is null and p_damaged is null
     and p_under_maintenance is null and v_fields = '{}'::jsonb then
    raise exception 'There is nothing to change' using errcode = '22023';
  end if;

  if (p_damaged is not null or p_under_maintenance is not null) and v_note is null then
    raise exception 'A note is required when damaged or under-maintenance units change'
      using errcode = '22023';
  end if;

  -- The same lock reserve_equipment and the release and move functions take, so
  -- no reservation can be made or released between the recalculation and the save.
  select * into v_type from equipment_types where id = p_equipment_type_id for update;
  if not found then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  if v_retire and v_type.retired_at is not null then
    raise exception 'Equipment type is already retired'
      using errcode = 'PT409', hint = 'EQUIPMENT_ALREADY_RETIRED';
  end if;

  v_total   := coalesce(p_total, v_type.total_quantity);
  v_damaged := coalesce(p_damaged, v_type.damaged_quantity);
  v_under   := coalesce(p_under_maintenance, v_type.under_maintenance_quantity);

  if not v_retire and v_damaged + v_under > v_total then
    raise exception 'Damaged plus under maintenance (%) can not exceed the total (%)',
      v_damaged + v_under, v_total
      using errcode = '22023';
  end if;

  v_affected := equipment_change_affected(
    p_equipment_type_id, p_caller, p_total, p_damaged, p_under_maintenance, v_retire
  ) -> 'affected';

  select coalesce(array_agg((a ->> 'reservation_id')::uuid order by (a ->> 'reservation_id')::uuid), '{}')
    into v_current_ids
    from jsonb_array_elements(v_affected) a;

  select coalesce(array_agg(distinct c order by c), '{}')
    into v_confirmed_ids
    from unnest(p_confirmed_reservation_ids) c;

  -- Refuse and show the current list when something this change leaves short was not
  -- confirmed, or when a confirmed id is neither affected nor a reservation of this type
  -- that has since ended or been released.
  if not (v_current_ids <@ v_confirmed_ids)
     or exists (
          select 1
            from unnest(v_confirmed_ids) c
           where c <> all (v_current_ids)
             and not exists (
                   select 1
                     from equipment_reservations r
                    where r.id = c
                      and r.equipment_type_id = p_equipment_type_id
                      and (r.released_at is not null or r.end_at <= now())
                 )
        ) then
    return jsonb_build_object('saved', false, 'affected', v_affected);
  end if;

  -- Tells the backstop trigger in 4 that this change is the confirmed one.
  perform set_config('equipment.confirmed_change', 'on', true);

  update equipment_types
     set name = case when v_fields ? 'name' then v_fields ->> 'name' else name end,
         description = case when v_fields ? 'description' then v_fields ->> 'description' else description end,
         category = case when v_fields ? 'category' then v_fields ->> 'category' else category end,
         location = case when v_fields ? 'location' then v_fields ->> 'location' else location end,
         total_quantity = v_total,
         damaged_quantity = v_damaged,
         under_maintenance_quantity = v_under,
         retired_at = case when v_retire then now() else retired_at end,
         last_modified_by = p_caller,
         last_change_note = v_note
   where id = p_equipment_type_id
  returning * into v_saved;

  perform set_config('equipment.confirmed_change', '', true);

  if cardinality(v_current_ids) > 0 then
    v_flagged_ids := flag_equipment_reservation_ids(
      v_current_ids, equipment_loss_reason(v_retire, v_note), p_caller
    );
  end if;

  return jsonb_build_object(
    'saved',          true,
    'flagged_count',  cardinality(v_flagged_ids),
    'affected',       coalesce((
                        select jsonb_agg(a)
                          from jsonb_array_elements(v_affected) a
                         where (a ->> 'reservation_id')::uuid = any (v_flagged_ids)
                      ), '[]'::jsonb),
    'equipment_type', to_jsonb(v_saved)
  );
end;
$$;

-- 4. Backstop. A change that lowers a type's usable quantity outside apply_equipment_change
-- (a seed script, a fix in the SQL editor) still flags the reservations it leaves short,
-- newest first, so lost units never leave a reservation looking fine. It does nothing for
-- a change that apply_equipment_change is making.

create or replace function equipment_flag_unconfirmed_loss()
returns trigger
language plpgsql
as $$
declare
  v_retired boolean := new.retired_at is not null and old.retired_at is null;
  v_ids     uuid[];
begin
  if current_setting('equipment.confirmed_change', true) = 'on' then
    return null;
  end if;

  select coalesce(array_agg((a ->> 'reservation_id')::uuid), '{}')
    into v_ids
    from jsonb_array_elements(equipment_over_commitment_unchecked(
           new.id,
           case when v_retired then 0
                else new.total_quantity - new.damaged_quantity - new.under_maintenance_quantity end
         )) a;

  if cardinality(v_ids) > 0 then
    perform flag_equipment_reservation_ids(
      v_ids, equipment_loss_reason(v_retired, new.last_change_note), new.last_modified_by
    );
  end if;

  return null;
end;
$$;

drop trigger if exists equipment_types_flag_unconfirmed_loss on equipment_types;
create trigger equipment_types_flag_unconfirmed_loss
  after update of total_quantity, damaged_quantity, under_maintenance_quantity, retired_at
  on equipment_types
  for each row
  when (
    (new.total_quantity - new.damaged_quantity - new.under_maintenance_quantity)
      < (old.total_quantity - old.damaged_quantity - old.under_maintenance_quantity)
    or (new.retired_at is not null and old.retired_at is null)
  )
  execute function equipment_flag_unconfirmed_loss();
