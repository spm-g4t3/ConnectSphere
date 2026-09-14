-- 003_venue_audit.sql
-- SCRUM-108: Record venue change audit history
--
-- Part of SCRUM-15 "Maintain Venue Catalogue Details".
-- AC4: every change records the editing user, a timestamp, and the previous values.
-- Run this once in the Supabase SQL Editor, after 002_venues.sql.
--
-- Why the editing user has to be handed to us:
-- Express talks to Supabase with the secret key, which bypasses RLS and carries
-- no user identity, so auth.uid() inside a trigger is NULL. Postgres genuinely
-- cannot tell which Venue Staff member made a change. The API therefore sets
-- last_modified_by in the same UPDATE, and the trigger reads it from there.


-- ---------------------------------------------------------------------
-- 1. Who made the change
-- ---------------------------------------------------------------------
-- Nullable on purpose. A change made directly in the Supabase SQL Editor has
-- no application user behind it, and NULL is the honest record of that --
-- "changed outside the app" -- rather than a rejected write or an invented id.

alter table venues
  add column if not exists last_modified_by uuid references auth.users (id);


-- ---------------------------------------------------------------------
-- 2. The history
-- ---------------------------------------------------------------------
-- on delete restrict, not cascade: a venue with recorded history cannot be
-- hard-deleted. Retirement (AC3) is the supported way to remove a venue, and
-- this enforces that in the database rather than by convention.
--
-- Consequence worth knowing: removing a test venue means deleting its history
-- rows first.

create table if not exists venue_change_history (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id) on delete restrict,

  -- NULL means the change did not come through the application
  changed_by uuid references auth.users (id),
  changed_at timestamptz not null default now(),

  -- only the fields that actually differed, e.g.
  --   old_values {"max_capacity": 60}
  --   new_values {"max_capacity": 80}
  old_values jsonb not null,
  new_values jsonb not null
);

-- how a venue's history is read: newest first
create index if not exists idx_venue_change_history_venue
  on venue_change_history (venue_id, changed_at desc);


-- ---------------------------------------------------------------------
-- 3. Recording a change
-- ---------------------------------------------------------------------
-- Compares the row before and after, and keeps only what differed.
--
-- updated_at and last_modified_by are skipped: both change on every single
-- write, so including them would make every history row claim those fields
-- changed and bury the actual edit in noise.

create or replace function record_venue_change()
returns trigger
language plpgsql
as $$
declare
  old_row     jsonb := to_jsonb(old);
  new_row     jsonb := to_jsonb(new);
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  col         text;
begin
  for col in select jsonb_object_keys(new_row) loop
    if col in ('updated_at', 'last_modified_by') then
      continue;
    end if;

    if old_row -> col is distinct from new_row -> col then
      old_changed := old_changed || jsonb_build_object(col, old_row -> col);
      new_changed := new_changed || jsonb_build_object(col, new_row -> col);
    end if;
  end loop;

  -- Nothing meaningful changed. Saving a form without editing anything should
  -- not leave an audit entry.
  if old_changed = '{}'::jsonb then
    return null;
  end if;

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (new.id, new.last_modified_by, old_changed, new_changed);

  return null;
end;
$$;

-- AFTER, not BEFORE: history is written only once the update has succeeded.
-- The return value of an AFTER ... FOR EACH ROW trigger is ignored.
drop trigger if exists venues_record_change on venues;
create trigger venues_record_change
  after update on venues
  for each row
  execute function record_venue_change();


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001 and 002: enabled with no policies, so a stray
-- publishable key reads nothing. The API enforces who may view history.

alter table venue_change_history enable row level security;
