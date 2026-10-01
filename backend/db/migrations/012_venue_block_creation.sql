-- 012_venue_block_creation.sql
-- SCRUM-126: Validation and creation rules for venue blocks
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after 011_venue_blocks.sql.
--
-- The single creation path for a block. AC1: "a block is created with venue,
-- start/end datetime, reason category". backend/src/validation/
-- venueBlockValidation.js already refuses bad input with readable messages;
-- this function enforces the rules that need the database, and re-checks the
-- period, inside one transaction:
--
--   * the venue exists and is not retired, read under a row lock so a
--     retirement cannot land between the check and the insert;
--   * the period is ordered and still has time left to run;
--   * no active block on the same venue overlaps it.
--
-- Why a function rather than an INSERT from JavaScript: the retirement check
-- and the overlap check are reads that have to hold until the insert commits.
-- PostgREST gives each supabase-js call its own request with no shared
-- transaction, so doing them from the service would leave a window in which
-- the venue is retired, or a second block lands, between check and write.
--
-- NOTE FOR SCRUM-125: that story adds booking-conflict parameters to this
-- function. `create or replace` with a different parameter list does NOT
-- replace -- it creates a second overload, and PostgREST then refuses the
-- call as ambiguous (PGRST203). Drop this exact signature first:
--
--   drop function if exists create_venue_block(
--     uuid, timestamptz, timestamptz, venue_block_reason, text, uuid);


-- ---------------------------------------------------------------------
-- 1. Creating a block
-- ---------------------------------------------------------------------
-- Errors, and what the service turns them into (venueBlockService.js):
--
--   no_data_found (P0002)  no such venue                    -> NotFoundError
--   PT409, hint VENUE_RETIRED         venue is retired      -> ConflictError
--   22023 invalid_parameter_value     period out of order,
--                                     or already ended      -> ValidationError
--   PT409, hint BLOCK_OVERLAPS_BLOCK  another active block
--                                     overlaps; its id is
--                                     in DETAIL             -> ConflictError
--   23P01 exclusion_violation         the same overlap, if
--                                     a concurrent insert
--                                     won the race          -> ConflictError
--
-- PT409 for the same reason 005 gives: PostgREST's documented escape hatch,
-- carrying the honest 409 instead of a 500. The HINT is the machine-readable
-- code, so a client can tell the two conflicts apart without reading prose.

create or replace function create_venue_block(
  p_venue_id  uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_reason    venue_block_reason,
  p_notes     text default null,
  p_user_id   uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_retired_at  timestamptz;
  v_overlap_id  uuid;
  v_block       venue_blocks;
begin
  -- 1. Lock the venue.
  --
  -- "for no key update" rather than "for update": it conflicts with
  -- retire_venue's UPDATE and with a second create_venue_block on the same
  -- venue, which is what serialises them, but not with the "for key share"
  -- lock a foreign-key insert takes -- so bookings can still be written
  -- against this venue while a block is being created.
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for no key update;

  if not found then
    -- The same condition update_venue (004) and retire_venue (005) raise, so
    -- "venue not found" has one code across the catalogue.
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 2. A retired venue cannot be blocked: it is already out of use, and a
  --    block on it would be a record of nothing.
  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be blocked', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 3. The period, checked BEFORE any range value is built.
  --
  -- A range constructed with its bounds reversed does not come back empty, it
  -- raises 22000 ("range lower bound must be less than or equal to range
  -- upper bound"), which no translation maps and which would surface as a
  -- 500. Checking the order here first means the overlap query below only
  -- ever sees a well-formed range.
  --
  -- Nulls are refused here too. The columns are not null, but a null bound
  -- would make the range unbounded and the overlap query would match every
  -- block on the venue.
  if p_starts_at is null or p_ends_at is null then
    raise exception 'a block needs both a start and an end'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'a block must end after it starts'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The start may be in the past -- a closure that has already begun is still
  -- worth recording -- but a block that has already ended blocks nothing.
  if p_ends_at <= now() then
    raise exception 'a block must end in the future'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 4. Overlap with another active block.
  --
  -- '[)' to match venue_blocks_no_overlap in 011, so blocks that touch at a
  -- boundary do not overlap. The exclusion constraint stays the guarantee;
  -- this check exists to name the block that clashed. The venue lock above
  -- means no other create_venue_block can insert between this read and the
  -- insert below.
  select id
    into v_overlap_id
    from venue_blocks
   where venue_id = p_venue_id
     and removed_at is null
     and tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
   order by starts_at, id
   limit 1;

  if v_overlap_id is not null then
    raise exception 'this period overlaps another block on venue %', p_venue_id
      using errcode = 'PT409',
            hint    = 'BLOCK_OVERLAPS_BLOCK',
            detail  = v_overlap_id::text;
  end if;

  -- 5. Insert. created_by and last_modified_by are both the acting user, as
  --    011 asks, so a later audit trigger can read the author off the row.
  insert into venue_blocks (
    venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by
  )
  values (
    p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id
  )
  returning * into v_block;

  -- 6. An outcome field rather than the bare row, so SCRUM-125 can add
  --    outcomes (a block that needs confirming over approved bookings)
  --    without changing the shape callers already read.
  return jsonb_build_object('outcome', 'created', 'block', to_jsonb(v_block));
end;
$$;
