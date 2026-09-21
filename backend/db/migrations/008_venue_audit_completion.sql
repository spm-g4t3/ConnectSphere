-- ---------------------------------------------------------------------------
-- 008_venue_audit_completion.sql
-- SCRUM-15 AC4: "Every change records the editing user, a timestamp, and the
-- previous values."
--
-- Run once in the Supabase SQL Editor, after 007_user_roles.sql.
--
-- 003_venue_audit.sql delivered the table and an AFTER UPDATE trigger on
-- venues. That left three holes in the word "every", all of which this
-- migration closes:
--
--   (a) Creating a venue wrote no history row at all -- the trigger is UPDATE
--       only, so a venue's first appearance was never recorded.
--   (b) Changing only a venue's facilities, layouts, accessibility features or
--       operating hours wrote no history row, because those live in join
--       tables and the trigger diffs the columns of `venues`. Clearing every
--       facility on a venue was completely invisible to the audit trail.
--   (c) changed_by was NULL on every row ever written, because the only
--       caller path took the acting user from the request body of a router
--       that was never mounted. That one is fixed in the API layer, not here.
--
-- Row-count semantics, which are worth knowing before reading the trail:
-- a single update_venue call can now produce UP TO TWO history rows -- one for
-- scalar columns, written by the trigger from 003, and one for attribute sets,
-- written by the function below. They share a changed_by and have near
-- identical changed_at values. Merging them would mean suppressing the trigger
-- inside the function, which is more cleverness than an audit trail is worth.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. Record a venue's creation
-- ---------------------------------------------------------------------
-- old_values '{}' is the convention for "this did not exist before". It keeps
-- the column not-null without inventing a previous value that never existed.
--
-- A trigger rather than code inside create_venue, so a venue inserted by hand
-- in the SQL editor is recorded too. That matches the posture 003 already
-- takes, where changed_by NULL means "changed outside the application".

create or replace function record_venue_creation()
returns trigger
language plpgsql
as $$
declare
  new_row jsonb := to_jsonb(new);
begin
  -- Dropped for the same reason record_venue_change drops them: both are
  -- bookkeeping that changes on every write, and neither is a venue detail
  -- anyone reading the history is looking for.
  new_row := new_row - 'updated_at' - 'last_modified_by';

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (new.id, new.last_modified_by, '{}'::jsonb, new_row);

  return null;
end;
$$;

drop trigger if exists venues_record_creation on venues;
create trigger venues_record_creation
  after insert on venues
  for each row
  execute function record_venue_creation();


-- ---------------------------------------------------------------------
-- 2. Record attribute-set changes
-- ---------------------------------------------------------------------
-- A helper both functions below use. Reads the four attribute sets as one
-- jsonb object, so "before" and "after" can be compared as single values.
--
-- Every array is ordered. Without that, the same set read twice could come
-- back in a different order and register as a change that never happened.

create or replace function venue_attribute_snapshot(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'room_layouts', coalesce(
      (select jsonb_agg(room_layout_code order by room_layout_code)
         from venue_room_layouts where venue_id = p_id), '[]'::jsonb),
    'accessibility_features', coalesce(
      (select jsonb_agg(accessibility_feature_code order by accessibility_feature_code)
         from venue_accessibility_features where venue_id = p_id), '[]'::jsonb),
    'facilities', coalesce(
      (select jsonb_agg(facility_code order by facility_code)
         from venue_facilities where venue_id = p_id), '[]'::jsonb),
    'operating_hours', coalesce(
      (select jsonb_agg(
                jsonb_build_object('day_of_week', day_of_week,
                                   'opens_at', opens_at,
                                   'closes_at', closes_at)
                order by day_of_week)
         from venue_operating_hours where venue_id = p_id), '[]'::jsonb)
  );
$$;


-- Writes one history row holding only the attribute sets that actually
-- differed. Returns without writing when nothing did, so saving a form without
-- touching the attributes leaves no entry -- the same rule record_venue_change
-- already applies to scalar columns.

create or replace function record_venue_attribute_change(
  p_id      uuid,
  p_before  jsonb,
  p_after   jsonb,
  p_user_id uuid
)
returns void
language plpgsql
as $$
declare
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  k           text;
begin
  for k in select jsonb_object_keys(p_after) loop
    if p_before -> k is distinct from p_after -> k then
      old_changed := old_changed || jsonb_build_object(k, p_before -> k);
      new_changed := new_changed || jsonb_build_object(k, p_after -> k);
    end if;
  end loop;

  if old_changed = '{}'::jsonb then
    return;
  end if;

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (p_id, p_user_id, old_changed, new_changed);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. create_venue -- unchanged except that it now records its attributes
-- ---------------------------------------------------------------------
-- The AFTER INSERT trigger above fires before any attribute rows exist, so it
-- can only record the venue's scalar columns. The attribute sets are recorded
-- here, once they have been written.

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
-- 4. update_venue -- unchanged semantics, now audited for attributes
-- ---------------------------------------------------------------------
--   NULL           -> leave that field or attribute set completely alone
--   an array       -> REPLACE that attribute set with exactly what was passed
--   an empty array -> clear that attribute set

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
declare
  v_before jsonb;
begin
  -- Taken before anything is written, and taken unconditionally: the venue may
  -- not exist, in which case the update below raises and this is discarded
  -- along with everything else in the transaction.
  v_before := venue_attribute_snapshot(p_id);

  update venues
  set
    name             = coalesce(p_name, name),
    location         = coalesce(p_location, location),
    max_capacity     = coalesce(p_max_capacity, max_capacity),
    last_modified_by = p_user_id
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
