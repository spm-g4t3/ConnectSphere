-- Migration 021: the confirmed save for a change that lowers a type's usable quantity
-- (SCRUM-313, a subtask of SCRUM-310).
--
-- Damage, maintenance, a smaller total and retiring all go through one function,
-- apply_equipment_change. It locks the type, recalculates which reservations the
-- change affects (equipment_over_commitment, 020), refuses if that list is not the
-- one the staff member confirmed, then saves the change and flags the affected
-- reservations in the same transaction. A refusal writes nothing and hands back
-- the new list.
--
-- This replaces the trigger that used to flag reservations silently on any update
-- of an equipment type. That trigger flagged every reservation in an over-committed
-- period, not the newest ones first, and it ran without anyone confirming.

-- 1. Flagging records who flagged (AC8).
-- flag_equipment_reservations keeps its signature, because other code and tests
-- call and replace it. The body moves to flag_equipment_reservations_by, which
-- also takes the user; the old name calls it with no user, as before.

create or replace function flag_equipment_reservations_by(
  p_reservation_ids uuid[],
  p_reason          text,
  p_user_id         uuid
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
    select id, event_request_id, equipment_line_id, 'flagged', p_user_id,
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

create or replace function flag_equipment_reservations(
  p_reservation_ids uuid[],
  p_reason          text
)
returns integer
language plpgsql
as $$
begin
  return flag_equipment_reservations_by(p_reservation_ids, p_reason, null);
end;
$$;

-- 2. The change history keeps the note on a total change and a retirement too.
-- Until now only damaged and under-maintenance changes had one.

create or replace function record_equipment_type_history()
returns trigger
language plpgsql
as $$
declare
  changed record;
begin
  if tg_op = 'INSERT' then
    insert into equipment_type_history (equipment_type_id, field_name, old_value, new_value, changed_by)
    values (new.id, 'created', null, new.name, new.last_modified_by);
    return new;
  end if;

  for changed in
    select field_name, old_value, new_value
    from (values
      ('name',                       old.name,                              new.name),
      ('description',                old.description,                       new.description),
      ('category',                   old.category,                          new.category),
      ('location',                   old.location,                          new.location),
      ('total_quantity',             old.total_quantity::text,              new.total_quantity::text),
      ('damaged_quantity',           old.damaged_quantity::text,            new.damaged_quantity::text),
      ('under_maintenance_quantity', old.under_maintenance_quantity::text,  new.under_maintenance_quantity::text),
      ('retired_at',                 old.retired_at::text,                  new.retired_at::text)
    ) as fields (field_name, old_value, new_value)
    where old_value is distinct from new_value
  loop
    insert into equipment_type_history
      (equipment_type_id, field_name, old_value, new_value, note, changed_by)
    values (
      new.id,
      changed.field_name,
      changed.old_value,
      changed.new_value,
      case
        when changed.field_name in
          ('damaged_quantity', 'under_maintenance_quantity', 'total_quantity', 'retired_at')
          then new.last_change_note
      end,
      new.last_modified_by
    );
  end loop;

  return new;
end;
$$;

-- 3. The silent flagging is gone. apply_equipment_change below is the only thing
-- that flags reservations when a type loses usable units.

drop trigger if exists equipment_types_flag_reservations_on_unusable on equipment_types;
drop function if exists equipment_flag_on_type_unusable();

-- 4. The confirmed save.
--
-- Returns jsonb:
--   { saved: false, affected: [...] }   the list differs from the confirmed one;
--                                        nothing was written
--   { saved: true, flagged_count, affected, equipment_type }
--
-- p_fields carries name, description, category and location for an ordinary edit
-- that comes with a total change, so the whole edit saves or none of it does.
-- p_confirmed_reservation_ids is exactly the reservations the staff member was
-- shown; a change that affects nothing is confirmed with an empty list.

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
  v_usable_before integer;
  v_usable_after  integer;
  v_affected      jsonb   := '[]'::jsonb;
  v_current_ids   uuid[];
  v_confirmed_ids uuid[];
  v_flagged       integer := 0;
  v_reason        text;
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

  v_usable_before := v_type.total_quantity - v_type.damaged_quantity - v_type.under_maintenance_quantity;
  v_usable_after  := case when v_retire then 0 else v_total - v_damaged - v_under end;

  -- Only a change that leaves fewer usable units can leave a reservation short.
  if v_usable_after < v_usable_before then
    v_affected := equipment_over_commitment(p_equipment_type_id, v_usable_after, p_caller);
  end if;

  select coalesce(array_agg((a ->> 'reservation_id')::uuid order by (a ->> 'reservation_id')::uuid), '{}')
    into v_current_ids
    from jsonb_array_elements(v_affected) a;

  select coalesce(array_agg(distinct c order by c), '{}')
    into v_confirmed_ids
    from unnest(p_confirmed_reservation_ids) c;

  -- The list moved since the preview: write nothing and show the new one.
  if v_current_ids is distinct from v_confirmed_ids then
    return jsonb_build_object('saved', false, 'affected', v_affected);
  end if;

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

  if cardinality(v_current_ids) > 0 then
    v_reason := case when v_retire then 'The equipment type was retired'
                     else 'Fewer units of this equipment are usable' end
                || case when v_note is not null then ' (' || v_note || ')' else '' end;
    v_flagged := flag_equipment_reservations_by(v_current_ids, v_reason, p_caller);
  end if;

  return jsonb_build_object(
    'saved',          true,
    'flagged_count',  v_flagged,
    'affected',       v_affected,
    'equipment_type', to_jsonb(v_saved)
  );
end;
$$;
