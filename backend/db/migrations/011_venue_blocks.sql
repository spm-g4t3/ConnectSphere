-- 011_venue_blocks.sql
-- SCRUM-123: Design and update the venue block data model
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after 009_bookings.sql
-- (this migration reuses the set_updated_at() function defined in 001).
--
-- Before running: enable the btree_gist extension on the Supabase project
-- (Database -> Extensions). Section 1 creates it if it is missing, but on a
-- hosted project the dashboard is the reliable way to switch it on.
--
-- Two things happen here:
--   * bookings gains a status. 009's header asks whoever needs booking state
--     to extend that table rather than create a second one beside it, and
--     AC3 needs exactly that: a block only conflicts with *approved* bookings.
--   * venue_blocks is created: a venue, a period, a reason, and who made it.


-- ---------------------------------------------------------------------
-- 1. Extension
-- ---------------------------------------------------------------------
-- btree_gist lets a gist index compare plain uuids with =, which the
-- exclusion constraint in section 4 needs alongside its range overlap.

create extension if not exists btree_gist;


-- ---------------------------------------------------------------------
-- 2. Vocabularies
-- ---------------------------------------------------------------------
-- Real enum types, as in 001, so the database refuses a misspelt reason or
-- status outright. The JS mirrors are backend/src/domain/venueBlockReason.js
-- and backend/src/domain/bookingStatus.js; a test asserts they match.
--
-- To add a value later:  alter type venue_block_reason add value 'x';

-- AC1: the reason categories a Venue Staff member chooses from.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'venue_block_reason') then
    create type venue_block_reason as enum (
      'maintenance',        -- routine upkeep, repairs
      'renovation',         -- building works
      'safety',             -- a hazard or inspection closes the venue
      'internal_activity',  -- ConnectSphere is using the venue itself
      'other'               -- anything else; notes are then required
    );
  end if;
end
$$;

-- AC3: only approved bookings count as conflicts. The other two states exist
-- so a booking can leave that set without its row being deleted -- past
-- bookings must stay viewable (SCRUM-15 AC3).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type booking_status as enum (
      'approved',            -- confirmed; blocks conflict with these
      'flagged_for_review',  -- a block now overlaps it; a Coordinator must act
      'cancelled'            -- called off; no longer holds the venue
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. Bookings gain a status (extends 009)
-- ---------------------------------------------------------------------
-- Every booking that exists today was created as a plain "this venue is
-- booked" row, so 'approved' is the honest default for them, and for any
-- writer that has not yet learned about status.

alter table bookings
  add column if not exists status booking_status not null default 'approved';

-- "which approved bookings overlap this period at this venue?" -- the conflict
-- check a block runs. Only approved rows can conflict, so only they are indexed.
create index if not exists idx_bookings_venue_approved
  on bookings (venue_id, starts_at, ends_at)
  where status = 'approved';


-- ---------------------------------------------------------------------
-- 4. Venue blocks
-- ---------------------------------------------------------------------

create table if not exists venue_blocks (
  id               uuid primary key default gen_random_uuid(),

  -- on delete restrict, as with bookings and history: a venue that has ever
  -- been blocked cannot be hard-deleted. Retirement is the supported removal.
  venue_id         uuid not null references venues (id) on delete restrict,

  starts_at        timestamptz not null,
  ends_at          timestamptz not null,

  reason           venue_block_reason not null,
  notes            text,

  -- AC4: who created and who last amended the block. Nullable for the reason
  -- 003 gives: NULL is the honest record of "changed outside the app". The
  -- API sets last_modified_by in the same write so a later audit trigger can
  -- read it off the row.
  created_by       uuid references auth.users (id),
  last_modified_by uuid references auth.users (id),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Removal is a soft delete, like venue retirement. NULL means active. The
  -- row survives so the audit trail still has something to point at.
  removed_at       timestamptz,
  removed_by       uuid references auth.users (id),

  -- same shape as bookings_times_ordered in 009
  constraint venue_blocks_times_ordered check (ends_at > starts_at),

  -- "other" says nothing on its own, so it must be explained.
  -- coalesce matters: with notes NULL, length(trim(notes)) is NULL, and a
  -- check that evaluates to NULL passes -- so without it "other" with no
  -- notes at all would be accepted.
  constraint venue_blocks_other_needs_notes check (
    reason <> 'other' or length(trim(coalesce(notes, ''))) > 0
  ),

  constraint venue_blocks_notes_length check (
    notes is null or length(notes) <= 1000
  ),

  -- a remover without a removal makes no sense; the reverse (removed outside
  -- the app, so no user) is allowed
  constraint venue_blocks_removed_by_needs_removed_at check (
    removed_by is null or removed_at is not null
  ),

  -- Two active blocks may not overlap on the same venue. '[)' makes the end
  -- exclusive, so a block ending at 12:00 and one starting at 12:00 touch but
  -- do not overlap. Removed blocks drop out, so a removed block never stops
  -- a new one being created over the same period.
  constraint venue_blocks_no_overlap exclude using gist (
    venue_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (removed_at is null)
);

-- reuses the function from 001_event_requests.sql rather than defining a second
drop trigger if exists venue_blocks_set_updated_at on venue_blocks;
create trigger venue_blocks_set_updated_at
  before update on venue_blocks
  for each row
  execute function set_updated_at();

-- "what active blocks does this venue have, soonest first?" -- the list Venue
-- Staff see, and the check an event request runs against a venue.
create index if not exists idx_venue_blocks_venue_active
  on venue_blocks (venue_id, starts_at)
  where removed_at is null;


-- ---------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------
-- Same posture as every other table: enabled with no policies, so a stray
-- publishable key reads nothing and the API stays the only way in.

alter table venue_blocks enable row level security;
