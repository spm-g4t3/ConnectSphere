-- ---------------------------------------------------------------------------
-- 023_venue_setup_time.sql
-- SCRUM-137: Design/update the data model for venue search
--
-- Part of SCRUM-20 "Search Venues Against Event Requirements".
-- Run this once in the Supabase SQL Editor, after 017_venue_turnaround.sql
-- (and the other migrations numbered up to 022), and before deploying the
-- backend that sends p_setup_minutes. Safe to re-run: the column and
-- constraint are guarded, and both functions are dropped by their exact old
-- signature before being recreated.
--
-- The Week 7 Customer Change adds a setup time before each event, alongside
-- the turnaround after it: "An event 10:00-12:00 with 30 min setup and 45 min
-- turnaround occupies 9:30-12:45." This migration stores the setup time;
-- nothing enforces it yet. SCRUM-139 will, by treating an approved booking as
-- occupying [start - setup, end + turnaround) when it checks for overlap.
--
-- Storage: venues.setup_minutes, a smallint with a named CHECK listing the
-- allowed values (0, 15, 30, 45, 60, 90, 120) -- the same shape, and the same
-- reasons, as turnaround_minutes in 017 (a number SCRUM-139 can subtract from
-- a start time, not an enum label; a small fixed set, not a lookup table).
-- backend/src/domain/setupOptions.js mirrors the list, and a test reads this
-- file to keep the two identical.
--
-- Why a column of its own rather than reusing turnaround as one shared
-- buffer: the customer names two settings, one before an event and one after
-- it, and they may diverge -- a room may need 15 minutes to set up and an
-- hour to clear down. One column could not say that. Two columns with two
-- CHECKs also lets either list be widened without touching the other.
--
-- 0 means "none": the event can start the moment the venue is free, and it is
-- a real choice rather than "unset".
--
-- Default 0. Every existing venue gets 0 when the column is added, because
-- nothing enforces setup until SCRUM-139 and any other default would quietly
-- invent a rule. No history rows are backfilled: nobody edited those venues.
--
-- The audit trail needs no change, exactly as 017 found for turnaround.
-- 003's record_venue_change diffs every column of to_jsonb(old) against
-- to_jsonb(new), so a setup change is recorded like any other column; 008's
-- record_venue_creation stores to_jsonb(new), so the creation row carries the
-- initial value. It is deliberately NOT added to venue_attribute_snapshot,
-- which covers the four attribute tables and would record every change twice.
--
-- What each SCRUM-20 search criterion reads. After this migration every one
-- of them has a column; only setup_minutes is new:
--
--   criterion                    | reads
--   -----------------------------+---------------------------------------------
--   event date and times         | event_requests.proposed_start, proposed_end (001)
--   attendance vs capacity       | event_requests.expected_attendance (001),
--                                |   venues.max_capacity (002)
--   open at those times          | venue_operating_hours (002)
--   room layout                  | venue_room_layouts (002)
--   accessibility                | venue_accessibility_features (002)
--   facilities                   | venue_facilities (002)
--   not already booked           | bookings with status 'approved' (009/011),
--                                |   via idx_bookings_venue_approved (011)
--   not blocked                  | venue_blocks where removed_at is null (011)
--   gap after an event           | venues.turnaround_minutes (017)
--   preparation before an event  | venues.setup_minutes (this file)
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. The column and its allowed values
-- ---------------------------------------------------------------------
-- Dropped and re-added rather than created once, so a re-run after the list
-- has been widened replaces the constraint instead of failing on its name.

alter table venues
  add column if not exists setup_minutes smallint not null default 0;

alter table venues
  drop constraint if exists venues_setup_minutes_allowed;

alter table venues
  add constraint venues_setup_minutes_allowed
  check (setup_minutes in (0, 15, 30, 45, 60, 90, 120));


-- ---------------------------------------------------------------------
-- 2. create_venue -- 017's body, plus setup
-- ---------------------------------------------------------------------
-- Dropped first. create or replace with an added parameter would leave 008's
-- version alongside this one, and PostgREST refuses to choose between two
-- overloads (PGRST203). No later migration (018-022) redefines create_venue
-- or update_venue, so 017's signatures are the ones to drop.
--
-- p_setup_minutes sits right after p_turnaround_minutes. Callers pass named
-- arguments through /rpc, so the position changes nothing for them.
--
-- p_setup_minutes is integer, not smallint, so an out-of-range number
-- reaches the CHECK (23514, which translateError reports as a validation
-- error) instead of failing the cast first (22003, which becomes a 500).

drop function if exists create_venue(text, text, integer, text[], text[], text[], jsonb, integer, uuid);

create or replace function create_venue(
  p_name               text,
  p_location           text,
  p_max_capacity       integer,
  p_layouts            text[]  default '{}',
  p_accessibility      text[]  default '{}',
  p_facilities         text[]  default '{}',
  p_hours              jsonb   default '[]'::jsonb,
  p_turnaround_minutes integer default null,
  p_setup_minutes      integer default null,
  p_user_id            uuid    default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  -- NULL means "not given", so a caller that predates SCRUM-186 (or
  -- SCRUM-137) still gets the column default.
  insert into venues (
    name, location, max_capacity, turnaround_minutes, setup_minutes, last_modified_by
  )
  values (
    p_name, p_location, p_max_capacity,
    coalesce(p_turnaround_minutes, 0), coalesce(p_setup_minutes, 0), p_user_id
  )
  returning id into v_id;

  insert into venue_room_layouts (venue_id, room_layout_code)
  select v_id, code from unnest(coalesce(p_layouts, '{}')) as code
  on conflict do nothing;

  insert into venue_accessibility_features (venue_id, accessibility_feature_code)
  select v_id, code from unnest(coalesce(p_accessibility, '{}')) as code
  on conflict do nothing;

  insert into venue_facilities (venue_id, facility_code)
  select v_id, code from unnest(coalesce(p_facilities, '{}')) as code
  on conflict do nothing;

  insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
  select
    v_id,
    (h ->> 'day_of_week')::smallint,
    (h ->> 'opens_at')::time,
    (h ->> 'closes_at')::time
  from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) as h;

  -- Compared against an empty snapshot, so a venue created with no attributes
  -- at all adds no second row.
  perform record_venue_attribute_change(
    v_id,
    venue_attribute_snapshot(null),
    venue_attribute_snapshot(v_id),
    p_user_id
  );

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. update_venue -- 017's body, plus setup
-- ---------------------------------------------------------------------
--   NULL           -> leave that field or attribute set completely alone
--   an array       -> REPLACE that attribute set with exactly what was passed
--   an empty array -> clear that attribute set
--
-- NULL keeps the current turnaround or setup time, so 0 has to arrive as 0:
-- the service sends `?? null`, never `|| null`, or setting either back to
-- none would silently do nothing.

drop function if exists update_venue(uuid, text, text, integer, text[], text[], text[], jsonb, integer, uuid);

create or replace function update_venue(
  p_id                 uuid,
  p_name               text    default null,
  p_location           text    default null,
  p_max_capacity       integer default null,
  p_layouts            text[]  default null,
  p_accessibility      text[]  default null,
  p_facilities         text[]  default null,
  p_hours              jsonb   default null,
  p_turnaround_minutes integer default null,
  p_setup_minutes      integer default null,
  p_user_id            uuid    default null
)
returns void
language plpgsql
as $$
declare
  v_before jsonb;
begin
  -- Taken before anything is written, and taken unconditionally: the venue may
  -- not exist, in which case the update below raises and this is discarded
  -- along with everything else in the transaction.
  v_before := venue_attribute_snapshot(p_id);

  update venues
  set
    name               = coalesce(p_name, name),
    location           = coalesce(p_location, location),
    max_capacity       = coalesce(p_max_capacity, max_capacity),
    turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes),
    setup_minutes      = coalesce(p_setup_minutes, setup_minutes),
    last_modified_by   = p_user_id
  where id = p_id;

  if not found then
    raise exception 'venue % not found', p_id using errcode = 'no_data_found';
  end if;

  if p_layouts is not null then
    delete from venue_room_layouts where venue_id = p_id;
    insert into venue_room_layouts (venue_id, room_layout_code)
    select p_id, code from unnest(p_layouts) as code
    on conflict do nothing;
  end if;

  if p_accessibility is not null then
    delete from venue_accessibility_features where venue_id = p_id;
    insert into venue_accessibility_features (venue_id, accessibility_feature_code)
    select p_id, code from unnest(p_accessibility) as code
    on conflict do nothing;
  end if;

  if p_facilities is not null then
    delete from venue_facilities where venue_id = p_id;
    insert into venue_facilities (venue_id, facility_code)
    select p_id, code from unnest(p_facilities) as code
    on conflict do nothing;
  end if;

  if p_hours is not null then
    delete from venue_operating_hours where venue_id = p_id;
    insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
    select
      p_id,
      (h ->> 'day_of_week')::smallint,
      (h ->> 'opens_at')::time,
      (h ->> 'closes_at')::time
    from jsonb_array_elements(p_hours) as h;
  end if;

  perform record_venue_attribute_change(
    p_id, v_before, venue_attribute_snapshot(p_id), p_user_id
  );
end;
$$;


-- PostgREST caches function signatures; without this the new parameter is
-- unknown to /rpc until the cache next reloads.
notify pgrst, 'reload schema';
