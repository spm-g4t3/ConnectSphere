-- Migration 023: the coordinator's side of lost equipment (SCRUM-315, a subtask of
-- SCRUM-310 "Handle Equipment Lost After Reservation").
--
-- 1. A flagged reservation says what kind of flag it is.
-- equipment_reservations.flag_reason is free text for a person to read. The
-- screens also need to tell "equipment was lost" from the other reasons a
-- reservation gets flagged (the event's date or time changed, a line was
-- edited), so they do not call every flag "equipment lost". flag_code is that
-- kind: 'equipment_lost' or null (any other flag). It is set where the flag is
-- set and cleared whenever the flag is cleared, by the trigger below.
--
-- flag_equipment_reservations_by takes the code as a fourth argument that
-- defaults to 'equipment_lost', so apply_equipment_change (021), which only
-- ever flags for lost equipment, keeps calling it with three. The older
-- flag_equipment_reservations, used by the date-change flow, passes null.
--
-- Flags set before this migration are given a code from their reason, once:
-- the two reasons the silent trigger and 021 wrote.
--
-- 2. An event's equipment shows which lines have flagged reservations.
-- equipment_for_event is the read behind the coordinator's equipment section on
-- the event record. Each line now carries flagged_reservations: the reservations
-- on that line that are flagged and not released, each with its quantity,
-- period, reason, code and when. A line with none has an empty list. Nothing
-- else about the answer changes, so older readers are unaffected.
--
-- The coordinator's "Needs attention" mark is not stored. The API works it out
-- from the same flags, so it goes when the last flag is cleared or released.
--
-- Re-runnable.

-- 1. The flag's kind.

alter table equipment_reservations add column if not exists flag_code text;

update equipment_reservations
   set flag_code = 'equipment_lost'
 where flagged
   and flag_code is null
   and (flag_reason like 'Fewer units of this equipment are usable%'
        or flag_reason like 'The equipment type was retired%');

alter table equipment_reservations drop constraint if exists equipment_reservations_flag_code_known;
alter table equipment_reservations
  add constraint equipment_reservations_flag_code_known
  check (flag_code is null or flag_code = 'equipment_lost');

create or replace function equipment_reservation_clear_flag_code()
returns trigger
language plpgsql
as $$
begin
  -- Every place that clears a flag sets flagged = false; the kind goes with it.
  if not new.flagged then
    new.flag_code := null;
  end if;
  return new;
end;
$$;

drop trigger if exists equipment_reservations_clear_flag_code on equipment_reservations;
create trigger equipment_reservations_clear_flag_code
  before insert or update on equipment_reservations
  for each row
  execute function equipment_reservation_clear_flag_code();

drop function if exists flag_equipment_reservations_by(uuid[], text, uuid);

create or replace function flag_equipment_reservations_by(
  p_reservation_ids uuid[],
  p_reason          text,
  p_user_id         uuid,
  p_code            text default 'equipment_lost'
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
           flag_code = p_code,
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

-- Not about lost equipment (the date-change flow calls this): no code.
create or replace function flag_equipment_reservations(
  p_reservation_ids uuid[],
  p_reason          text
)
returns integer
language plpgsql
as $$
begin
  return flag_equipment_reservations_by(p_reservation_ids, p_reason, null, null);
end;
$$;

-- 2. The event's equipment, with each line's flagged reservations.

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
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'flagged_reservations', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',          r.id,
                                'quantity',    r.quantity,
                                'start_at',    r.start_at,
                                'end_at',      r.end_at,
                                'flag_reason', r.flag_reason,
                                'flag_code',   r.flag_code,
                                'flagged_at',  r.flagged_at
                              )
                              order by r.start_at, r.id
                            )
                       from equipment_reservations r
                      where r.equipment_line_id = l.id
                        and r.flagged
                        and r.released_at is null
                   ), '[]'::jsonb),
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
