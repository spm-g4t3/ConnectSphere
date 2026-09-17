-- 004_venue_functions.sql
-- SCRUM-106: Create and update venue records
--
-- Part of SCRUM-15 "Maintain Venue Catalogue Details".
-- Run this once in the Supabase SQL Editor, after 003_venue_audit.sql.
--
-- Why these exist instead of writing from JavaScript:
-- creating one venue writes to five tables. supabase-js talks to PostgREST,
-- where every call is a separate HTTP request with no shared transaction, so a
-- failure partway through would leave a half-built venue behind. A Postgres
-- function body IS a transaction, so either the whole venue exists or none of
-- it does.


-- ---------------------------------------------------------------------
-- create_venue
-- ---------------------------------------------------------------------
-- Attribute codes are passed as arrays of lookup codes ('projector', ...).
-- Opening hours are passed as JSON:
--   [{"day_of_week": 1, "opens_at": "09:00", "closes_at": "18:00"}, ...]
--
-- A bad code anywhere rolls the entire venue back.

create or replace function create_venue(
  p_name          text,
  p_location      text,
  p_max_capacity  integer,
  p_layouts       text[]  default '{}',
  p_accessibility text[]  default '{}',
  p_facilities    text[]  default '{}',
  p_hours         jsonb   default '[]'::jsonb,
  p_user_id       uuid    default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into venues (name, location, max_capacity, last_modified_by)
  values (p_name, p_location, p_max_capacity, p_user_id)
  returning id into v_id;

  -- unnest turns each array into rows; on conflict makes a repeated code harmless
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

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- update_venue
-- ---------------------------------------------------------------------
-- Update semantics, which matter and are easy to get wrong:
--
--   NULL           -> leave that field or attribute set completely alone
--   an array       -> REPLACE that attribute set with exactly what was passed
--   an empty array -> clear that attribute set
--
-- So omitting facilities can never silently wipe them, while passing '{}'
-- deliberately clears them. There is no add-one / remove-one: the caller sends
-- the full desired set.

create or replace function update_venue(
  p_id            uuid,
  p_name          text    default null,
  p_location      text    default null,
  p_max_capacity  integer default null,
  p_layouts       text[]  default null,
  p_accessibility text[]  default null,
  p_facilities    text[]  default null,
  p_hours         jsonb   default null,
  p_user_id       uuid    default null
)
returns void
language plpgsql
as $$
begin
  update venues
  set
    name             = coalesce(p_name, name),
    location         = coalesce(p_location, location),
    max_capacity     = coalesce(p_max_capacity, max_capacity),
    last_modified_by = p_user_id
  where id = p_id;

  if not found then
    -- surfaces to the service as NotFoundError
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
end;
$$;
