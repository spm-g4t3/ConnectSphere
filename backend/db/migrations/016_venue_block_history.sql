-- 016_venue_block_history.sql
-- SCRUM-131: Record block amendment audit history
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after
-- 015_venue_block_amend_remove.sql. Safe to re-run: the table and index are
-- `if not exists`, the function is `create or replace`, the trigger is
-- dropped before it is created, and the backfill skips blocks that already
-- have history.
--
-- AC4: "An existing block can be shortened, extended, or removed by Venue
-- Staff, with the creating or amending user and timestamp recorded."
--
-- The block row already records created_by, last_modified_by and removed_by,
-- but only the latest change: a second amendment overwrites the first. This
-- migration keeps the whole trail, the way 003 and 008 do for venues.
--
-- Why changed_by comes from last_modified_by: the reason 003 gives. Express
-- talks to Supabase with the secret key, so auth.uid() inside a trigger is
-- NULL. Every block function (012-015) writes last_modified_by in the same
-- statement as the change, so the trigger reads it off the row.
--
-- This migration redefines no function from 012-015 and touches no booking.


-- ---------------------------------------------------------------------
-- 1. The history
-- ---------------------------------------------------------------------
-- on delete restrict, not cascade: blocks are only ever soft-deleted (011),
-- so this makes it a database rule that a block's trail cannot be erased.
--
-- No venue_id column: a block never changes venue, so it would only repeat
-- what block_id already says. The API scopes reads through the block.

create table if not exists venue_block_history (
  id         uuid primary key default gen_random_uuid(),
  block_id   uuid not null references venue_blocks (id) on delete restrict,

  -- Text with a check rather than an enum: only the trigger below writes it,
  -- so there is no JS mirror to keep in step, and a check is easy to widen.
  action     text not null
    constraint venue_block_history_action_known
      check (action in ('created', 'amended', 'removed')),

  -- NULL means the change did not come through the application
  changed_by uuid references auth.users (id),
  changed_at timestamptz not null default now(),

  -- created: old_values '{}' and the whole row, as 008 records a venue.
  -- amended and removed: only the fields that differed, e.g.
  --   old_values {"ends_at": "2026-10-03T12:00:00+00:00"}
  --   new_values {"ends_at": "2026-10-03T10:00:00+00:00"}
  old_values jsonb not null,
  new_values jsonb not null
);

-- how a block's history is read: newest first
create index if not exists idx_venue_block_history_block
  on venue_block_history (block_id, changed_at desc);


-- ---------------------------------------------------------------------
-- 2. Recording a change
-- ---------------------------------------------------------------------
-- One function for both events, so creation and change cannot drift apart.
--
-- updated_at and last_modified_by are skipped, as in 003: both change on
-- every write, so including them would make every row claim they changed and
-- bury the actual edit. Who and when are already changed_by and changed_at.

create or replace function record_venue_block_change()
returns trigger
language plpgsql
as $$
declare
  old_row     jsonb;
  new_row     jsonb := to_jsonb(new);
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  col         text;
begin
  -- old_values '{}' is 008's convention for "this did not exist before".
  if tg_op = 'INSERT' then
    insert into venue_block_history (block_id, action, changed_by, old_values, new_values)
    values (new.id, 'created', new.last_modified_by, '{}'::jsonb,
            new_row - 'updated_at' - 'last_modified_by');
    return null;
  end if;

  old_row := to_jsonb(old);

  for col in select jsonb_object_keys(new_row) loop
    if col in ('updated_at', 'last_modified_by') then
      continue;
    end if;

    if old_row -> col is distinct from new_row -> col then
      old_changed := old_changed || jsonb_build_object(col, old_row -> col);
      new_changed := new_changed || jsonb_build_object(col, new_row -> col);
    end if;
  end loop;

  -- Nothing meaningful changed. update_venue_block (015) still bumps
  -- last_modified_by and updated_at on a no-op save, but that is not an
  -- amendment and gets no entry.
  if old_changed = '{}'::jsonb then
    return null;
  end if;

  -- Removal is the one transition worth naming: remove_venue_block (015) is
  -- the only thing that sets removed_at, and nothing ever clears it.
  insert into venue_block_history (block_id, action, changed_by, old_values, new_values)
  values (
    new.id,
    case
      when old.removed_at is null and new.removed_at is not null then 'removed'
      else 'amended'
    end,
    new.last_modified_by,
    old_changed,
    new_changed
  );

  return null;
end;
$$;

-- AFTER, not BEFORE, as in 003: history is written only once the write has
-- succeeded, and it runs inside the calling function's transaction, so a
-- failed call or a 409 conflict leaves no row behind. It also fires after
-- venue_blocks_set_updated_at (011), which is BEFORE. The return value of an
-- AFTER ... FOR EACH ROW trigger is ignored.
drop trigger if exists venue_blocks_record_change on venue_blocks;
create trigger venue_blocks_record_change
  after insert or update on venue_blocks
  for each row
  execute function record_venue_block_change();


-- ---------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------
-- One 'created' row for every block that has none, so no block starts with an
-- empty trail. Run after the trigger exists, so a block created while this
-- migration runs is recorded by one or the other and never by both.
--
-- Limitation: history before 016 cannot be rebuilt. A block amended or
-- removed before this ran gets a 'created' row holding its state as of now,
-- stamped with its original created_by and created_at; the amendments in
-- between are lost, and only the row's last_modified_by and removed_by still
-- say who made the latest of them.

insert into venue_block_history (block_id, action, changed_by, changed_at, old_values, new_values)
select b.id, 'created', b.created_by, b.created_at, '{}'::jsonb,
       to_jsonb(b) - 'updated_at' - 'last_modified_by'
  from venue_blocks b
 where not exists (
   select 1 from venue_block_history h where h.block_id = b.id
 );


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Same posture as every other table: enabled with no policies, so a stray
-- publishable key reads nothing. The API enforces who may view history.

alter table venue_block_history enable row level security;


-- PostgREST caches the schema; without this the new table answers PGRST205
-- "not found" until the cache next reloads.
notify pgrst, 'reload schema';
