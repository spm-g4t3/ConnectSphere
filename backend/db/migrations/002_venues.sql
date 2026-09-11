-- 002_venues.sql
-- SCRUM-90: Venue catalogue database schema
--
-- Part of SCRUM-15 "Maintain Venue Catalogue Details".
-- Run this once in the Supabase SQL Editor, after 001_event_requests.sql
-- (this migration reuses the set_updated_at() function defined there).
--
-- Multi-valued attributes -- room layouts, accessibility features, facilities --
-- are modelled as lookup tables plus join tables rather than arrays. It is more
-- tables, but Venue Staff can add a new layout or facility without a schema
-- change, and nothing can record a value that is not in the vocabulary.


-- ---------------------------------------------------------------------
-- 1. Venues
-- ---------------------------------------------------------------------
-- AC1 makes name, location and maximum capacity mandatory, and requires
-- capacity to be a positive whole number. All four rules are enforced here
-- rather than trusting API code that does not exist yet.

create table if not exists venues (
  id           uuid primary key default gen_random_uuid(),

  name         text not null check (length(trim(name)) > 0),
  location     text not null check (length(trim(location)) > 0),
  max_capacity integer not null check (max_capacity > 0),

  -- AC3: retirement is a soft delete. NULL means active.
  -- A hard DELETE would destroy the past bookings AC3 requires to stay
  -- viewable, so a retired venue keeps its row and drops out of searches.
  retired_at   timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- reuses the function from 001_event_requests.sql rather than defining a second
drop trigger if exists venues_set_updated_at on venues;
create trigger venues_set_updated_at
  before update on venues
  for each row
  execute function set_updated_at();


-- ---------------------------------------------------------------------
-- 2. Operating hours
-- ---------------------------------------------------------------------
-- A separate row per day, so a venue can close on Sundays or keep different
-- weekend hours. One row per venue per day keeps the hours unambiguous.
--
-- day_of_week is 0-6 with 0 = Sunday, matching JavaScript's Date.getDay() so
-- no conversion is needed in Node.

create table if not exists venue_operating_hours (
  venue_id    uuid not null references venues (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at    time not null,
  closes_at   time not null,

  primary key (venue_id, day_of_week),

  constraint venue_operating_hours_ordered check (closes_at > opens_at)
);


-- ---------------------------------------------------------------------
-- 3. Controlled vocabularies
-- ---------------------------------------------------------------------
-- Keyed by a short stable code so joins read as 'classroom' rather than a
-- meaningless id. The lowercase check stops 'Classroom' and 'classroom'
-- becoming two different things -- the drift a free-text column would allow.

create table if not exists room_layouts (
  code  text primary key check (code = lower(code) and length(trim(code)) > 0),
  label text not null
);

create table if not exists accessibility_features (
  code  text primary key check (code = lower(code) and length(trim(code)) > 0),
  label text not null
);

create table if not exists facilities (
  code  text primary key check (code = lower(code) and length(trim(code)) > 0),
  label text not null
);

-- Starting values. Without these the tables are empty and no venue can
-- reference anything. Venue Staff add more rows later without a migration.
-- ON CONFLICT DO NOTHING makes re-running this file harmless.

insert into room_layouts (code, label) values
  ('classroom',  'Classroom'),
  ('theatre',    'Theatre'),
  ('boardroom',  'Boardroom'),
  ('banquet',    'Banquet'),
  ('exhibition', 'Exhibition'),
  ('u_shape',    'U-Shape')
on conflict (code) do nothing;

insert into accessibility_features (code, label) values
  ('step_free_entrance',  'Step-free entrance'),
  ('accessible_toilet',   'Wheelchair-accessible toilet'),
  ('hearing_loop',        'Hearing loop'),
  ('lift_access',         'Lift access'),
  ('accessible_parking',  'Accessible parking')
on conflict (code) do nothing;

insert into facilities (code, label) values
  ('projector',          'Projector'),
  ('screen',             'Screen'),
  ('wifi',               'Wi-Fi'),
  ('air_conditioning',   'Air conditioning'),
  ('whiteboard',         'Whiteboard'),
  ('video_conferencing', 'Video conferencing'),
  ('pa_system',          'PA system'),
  ('catering',           'Catering')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------
-- 4. Which venue has what
-- ---------------------------------------------------------------------
-- The composite primary key is doing real work: it makes recording the same
-- layout against the same venue twice impossible.
--
-- on delete cascade from venues  -- removing a venue clears its links.
-- on delete restrict to lookups  -- a vocabulary entry still in use cannot be
--                                   deleted out from under the venues using it.

create table if not exists venue_room_layouts (
  venue_id         uuid not null references venues (id) on delete cascade,
  room_layout_code text not null references room_layouts (code) on delete restrict,
  primary key (venue_id, room_layout_code)
);

create table if not exists venue_accessibility_features (
  venue_id                  uuid not null references venues (id) on delete cascade,
  accessibility_feature_code text not null references accessibility_features (code) on delete restrict,
  primary key (venue_id, accessibility_feature_code)
);

create table if not exists venue_facilities (
  venue_id      uuid not null references venues (id) on delete cascade,
  facility_code text not null references facilities (code) on delete restrict,
  primary key (venue_id, facility_code)
);


-- ---------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------

-- Almost every search is "active venues only" (AC3), so index just those rows
-- rather than carrying retired ones in the index too.
create index if not exists idx_venues_active
  on venues (name)
  where retired_at is null;

-- capacity filtering during venue search, again active venues only
create index if not exists idx_venues_active_capacity
  on venues (max_capacity)
  where retired_at is null;

-- The composite primary keys above already index venue_id first, which answers
-- "what does this venue have?". These answer the reverse -- "which venues have
-- this layout / feature / facility?" -- which is how venue search will query.
create index if not exists idx_venue_room_layouts_code
  on venue_room_layouts (room_layout_code);

create index if not exists idx_venue_accessibility_features_code
  on venue_accessibility_features (accessibility_feature_code);

create index if not exists idx_venue_facilities_code
  on venue_facilities (facility_code);


-- ---------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001: enabled with no policies, which denies everything by
-- default. The Express API holds the secret key, bypasses RLS, and enforces
-- authorisation where role and event relationship are both known. This means
-- a stray publishable key returns nothing rather than the whole catalogue.

alter table venues                       enable row level security;
alter table venue_operating_hours        enable row level security;
alter table room_layouts                 enable row level security;
alter table accessibility_features       enable row level security;
alter table facilities                   enable row level security;
alter table venue_room_layouts           enable row level security;
alter table venue_accessibility_features enable row level security;
alter table venue_facilities             enable row level security;
