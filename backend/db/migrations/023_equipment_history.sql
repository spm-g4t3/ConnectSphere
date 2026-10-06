-- 023_equipment_history.sql
-- SCRUM-279: Record equipment change history
--
-- Part of SCRUM-275 "Maintain Equipment Catalogue and Status" (AC8).
-- Run this once in the Supabase SQL Editor, after 022_equipment_schema.sql.
-- Safe to re-run: columns and the table are guarded, and the trigger is
-- dropped before it is recreated.
--
-- Three things happen here:
--   * equipment_types gains last_modified_by and last_change_note. The service
--     sets them in the same UPDATE as the change, and the trigger below reads
--     them, so the user and the note reach the history row without a second
--     round trip. Same idea as venues.last_modified_by in 003.
--   * equipment_type_history is created: one row per field that changed, with
--     the old and new value as text, who changed it, and when.
--   * a trigger writes those rows. Because it fires inside the same statement,
--     a change and its history row succeed or fail together, and a change made
--     by any route (the API, the SQL Editor, a script) is recorded.
--
-- Rows written:
--   * creating a type writes one row, field 'created', new_value = the name
--   * changing name, description, category, location, total_quantity,
--     damaged_quantity, under_maintenance_quantity or retired_at writes one
--     row per field that differs. Retiring and reinstating are retired_at
--     going from null to a time and back.
--   * the note is kept only on the damaged and under-maintenance rows, which
--     is where AC8 asks for it
--   * an UPDATE that changes nothing writes nothing
--
-- changed_by is null when the writer did not say who it was, for example a
-- change made directly in the SQL Editor.
--
-- Deliberately not done:
--   * No edit or delete of history rows. Nothing in the API can; keep it so.
--   * history rows are not deleted with their type (ON DELETE RESTRICT).
--     Types are retired, never deleted, so this only stops a mistake.


-- ---------------------------------------------------------------------
-- 1. Who and why, on the type itself
-- ---------------------------------------------------------------------

alter table equipment_types
  add column if not exists last_modified_by uuid references auth.users(id),
  add column if not exists last_change_note text;


-- ---------------------------------------------------------------------
-- 2. The history table
-- ---------------------------------------------------------------------
-- A bigint identity rather than a uuid so rows written in one transaction,
-- which share a changed_at, still sort in the order they were written.

create table if not exists equipment_type_history (
  id                 bigint generated always as identity primary key,
  equipment_type_id  uuid not null references equipment_types(id) on delete restrict,
  field_name         text not null,
  old_value          text,
  new_value          text,
  note               text,
  changed_by         uuid references auth.users(id),
  changed_at         timestamptz not null default now()
);

create index if not exists equipment_type_history_type_idx
  on equipment_type_history (equipment_type_id, changed_at desc, id desc);


-- ---------------------------------------------------------------------
-- 3. The trigger
-- ---------------------------------------------------------------------

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
        when changed.field_name in ('damaged_quantity', 'under_maintenance_quantity')
          then new.last_change_note
      end,
      new.last_modified_by
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists equipment_types_record_history on equipment_types;
create trigger equipment_types_record_history
  after insert or update on equipment_types
  for each row execute function record_equipment_type_history();


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Enabled with no policies, as for every other table: only the API's secret
-- key reads or writes it.

alter table equipment_type_history enable row level security;