-- ---------------------------------------------------------------------------
-- 017_venue_turnaround.sql
-- SCRUM-186: Define the operating hours model (per weekday) and the
-- turnaround field
--
-- Part of SCRUM-15 "Maintain Venue Catalogue Details".
-- Run this once in the Supabase SQL Editor, after 016_venue_block_history.sql,
-- and before deploying the backend that sends p_turnaround_minutes. Safe to
-- re-run: the column and constraint are guarded, and both functions are
-- dropped by their exact old signature before being recreated.
--
-- The briefing lists "the turnaround time required between consecutive
-- events" as a venue-suitability factor. This migration stores it; nothing
-- enforces it yet. Keeping a gap between bookings is SCRUM-139's, as part of
-- its overlap rule.
--
-- Storage: venues.turnaround_minutes, a smallint with a named CHECK listing
-- the allowed values (0, 15, 30, 45, 60, 90, 120). Why a CHECK rather than
-- the alternatives:
--   * not an enum: an enum value is a label, and turnaround has to stay a
--     number so SCRUM-139 can add it to a booking's end time directly.
--   * not a lookup table: the set is small and fixed for now, and a lookup
--     would buy Venue Staff an editable vocabulary nobody asked for, at the
--     cost of a join on every read. Widening the set later is one
--     drop-and-add of this constraint.
-- backend/src/domain/turnaroundOptions.js mirrors the list, and a test reads
-- this file to keep the two identical.
--
-- 0 means "none": back-to-back bookings are allowed, and it is a real choice
-- rather than "unset". A gap longer than two hours is a closure, and belongs
-- in a venue block (011) with a reason.
--
-- Default 0. Every existing venue gets 0 when the column is added, because
-- nothing enforces a gap yet and any other default would quietly invent a
-- rule. No history rows are backfilled: nobody edited those venues.
--
-- The audit trail needs no change. 003's diff trigger records a turnaround
-- change like any other column, and 008's creation trigger stores the initial
-- value. It is deliberately NOT added to venue_attribute_snapshot, which would
-- record every change twice.
--
-- Operating hours: no schema change. The per-weekday model from 002 stands,
-- and these are its limits, written down so nobody mistakes them for bugs:
--   * a day with no row is closed -- there is no "closed" flag;
--   * hours cannot run past midnight, because closes_at > opens_at on a time
--     column (an overnight event is out of scope);
--   * one opening window per day, because (venue_id, day_of_week) is the
--     primary key -- no split shifts or lunch closures;
--   * the latest closing time is 23:59, since a time of day has no 24:00 that
--     validation accepts.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. The column and its allowed values
-- ---------------------------------------------------------------------
-- Dropped and re-added rather than created once, so a re-run after the list
-- has been widened replaces the constraint instead of failing on its name.

alter table venues
  add column if not exists turnaround_minutes smallint not null default 0;

alter table venues
  drop constraint if exists venues_turnaround_minutes_allowed;

alter table venues
  add constraint venues_turnaround_minutes_allowed
  check (turnaround_minutes in (0, 15, 30, 45, 60, 90, 120));


-- ---------------------------------------------------------------------
-- 2. create_venue -- 008's body, plus turnaround
-- ---------------------------------------------------------------------
-- Dropped first. create or replace with an added parameter would leave 008's
-- version alongside this one, and PostgREST refuses to choose between two
-- overloads (PGRST203).
--
-- p_turnaround_minutes is integer, not smallint, so an out-of-range number
-- reaches the CHECK (23514, which translateError reports as a validation
-- error) instead of failing the cast first (22003, which becomes a 500).

drop function if exists create_venue(text, text, integer, text[], text[], text[], jsonb, uuid);

create or replace function create_venue(
  p_name               text,
  p_location           text,
  p_max_capacity       integer,
  p_layouts            text[]  default '{}',
  p_accessibility      text[]  default '{}',
  p_facilities         text[]  default '{}',
  p_hours              jsonb   default '[]'::jsonb,
  p_turnaround_minutes integer default null,
  p_user_id            uuid    default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  -- NULL means "not given", so a caller that predates SCRUM-186 still gets
  -- the column default.
  insert into venues (name, location, max_capacity, turnaround_minutes, last_modified_by)
  values (p_name, p_location, p_max_capacity, coalesce(p_turnaround_minutes, 0), p_user_id)
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
-- 3. update_venue -- 008's body, plus turnaround
-- ---------------------------------------------------------------------
--   NULL           -> leave that field or attribute set completely alone
--   an array       -> REPLACE that attribute set with exactly what was passed
--   an empty array -> clear that attribute set
--
-- NULL keeps the current turnaround, so 0 has to arrive as 0: the service
-- sends `?? null`, never `|| null`, or setting it back to none would silently
-- do nothing.

drop function if exists update_venue(uuid, text, text, integer, text[], text[], text[], jsonb, uuid);

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
