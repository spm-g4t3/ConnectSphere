-- 005_venue_retirement.sql
-- SCRUM-110: Implement venue retirement handling
--
-- Part of SCRUM-15 "Maintain Venue Catalogue Details".
-- Run this once in the Supabase SQL Editor, after 004_venue_functions.sql.
--
-- Why a function rather than an UPDATE from JavaScript:
-- retirement is one column on one table, so the transaction argument that
-- justifies create_venue and update_venue does not apply here. What does apply
-- is attribution. The audit trigger in 003 reads new.last_modified_by off the
-- row it is handed, so retired_at and last_modified_by have to move in the
-- same statement or the history records the wrong person. Keeping every venue
-- write behind a function also means there is one answer to "where can
-- retired_at change?", which is the question an auditor asks.


-- ---------------------------------------------------------------------
-- 1. Retiring a venue
-- ---------------------------------------------------------------------
-- AC3: "A venue can be retired so it no longer appears in searches, while its
-- past bookings remain viewable."
--
-- A soft delete, never a DELETE. The row survives, drops out of the two
-- partial indexes in 002 (both are WHERE retired_at is null), and stays
-- readable by id. venue_change_history's on delete restrict already blocks the
-- hard delete this replaces.

create or replace function retire_venue(
  p_id      uuid,
  p_user_id uuid default null
)
returns void
language plpgsql
as $$
begin
  -- Both columns in ONE statement. The audit trigger reads
  -- new.last_modified_by, so setting them separately would attribute the
  -- retirement to whoever edited the venue last.
  --
  -- "and retired_at is null" is what makes this safe under concurrency: a
  -- second retirement blocks on the row lock, re-checks the predicate against
  -- the committed row, matches nothing, and reports the conflict below rather
  -- than overwriting the first timestamp.
  --
  -- last_modified_by is assigned, not coalesced, exactly as update_venue does
  -- it (004). A NULL user therefore records a NULL, which 003 reads as
  -- "changed outside the app".
  update venues
  set retired_at       = now(),
      last_modified_by = p_user_id
  where id = p_id
    and retired_at is null;

  -- Depends on venues_record_change staying an AFTER trigger. An AFTER row
  -- trigger's return value is ignored, so it cannot affect FOUND. If it were
  -- ever changed to BEFORE, its `return null` would suppress the row and this
  -- function would report "already retired" while writing nothing.
  if not found then
    -- Zero rows means one of two different things, and only the failure path
    -- pays for telling them apart.
    if exists (select 1 from venues where id = p_id) then
      -- surfaces to the service as ConflictError
      --
      -- PT409 rather than a built-in condition name: Postgres reserves codes
      -- ending in three zeroes as trappable categories and tells you not to
      -- raise them, and no assigned class means "this object is already in
      -- the state you asked for". PTxxx is PostgREST's documented escape
      -- hatch, and it carries the honest HTTP status instead of a 500.
      raise exception 'venue % is already retired', p_id using errcode = 'PT409';
    end if;

    -- surfaces to the service as NotFoundError.
    -- Deliberately the same no_data_found that update_venue raises (004), so
    -- one condition has one code across the catalogue. See the follow-up note
    -- about aligning update_venue on PT404.
    raise exception 'venue % not found', p_id using errcode = 'no_data_found';
  end if;
end;
$$;
