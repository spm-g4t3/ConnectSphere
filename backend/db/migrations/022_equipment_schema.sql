-- 022_equipment_schema.sql
-- SCRUM-66: Design/update DB schema for equipment
--
-- Part of SCRUM-23 "Check Equipment Availability for a Period". SCRUM-21,
-- SCRUM-275 (N13) and SCRUM-300 (N15) build on these tables instead of
-- creating their own.
-- Run this once in the Supabase SQL Editor, after 001_event_requests.sql
-- (this migration references event_requests and reuses the set_updated_at()
-- function defined there). It does not depend on 002 to 021, so it is safe to
-- run before or after 020 and 021, which belong to SCRUM-318.
--
-- Four tables are created together, because they reference each other:
--   * equipment_types: what ConnectSphere owns, as quantities per type
--   * equipment_requests: one request for equipment on an event
--   * equipment_lines: the types and quantities a request asks for
--   * equipment_reservations: units held for an event over a period
--
-- Deliberately not done here:
--   * No change history. SCRUM-279 adds that table in its own migration.
--   * No reviewer or outcome-note columns on equipment_requests. SCRUM-290
--     adds those when it needs them.
--   * No usable quantity column. Usable is total minus damaged minus under
--     maintenance, and is worked out where it is read (SCRUM-275 AC5).
--   * No check that reservations fit within usable units. That is availability
--     logic (SCRUM-23, SCRUM-300), not a table constraint.
--   * No seed data. SCRUM-281 does that.


-- ---------------------------------------------------------------------
-- 1. Vocabularies
-- ---------------------------------------------------------------------
-- A real enum type, as in 001, so the database refuses a misspelt status.
-- The JS mirror (backend/src/domain/equipmentRequestStatus.js) is added with
-- the first endpoint that needs it, and a test should assert they match.
--
-- To add a value later:  alter type equipment_request_status add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'equipment_request_status') then
    create type equipment_request_status as enum (
      'pending_review',           -- recorded by a Coordinator, not yet looked at
      'under_review',             -- Technical Support Staff have opened it
      'arranged',                 -- every line is fully reserved
      'cannot_be_fully_arranged', -- reviewed, but a line cannot be provided
      'cancelled'                 -- the event was cancelled
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Equipment types
-- ---------------------------------------------------------------------
-- Tracked as quantities per type, not individual units (team decision, the
-- customer left this open). A type is retired, never deleted, so past events
-- keep their equipment history. retired_at follows venues.retired_at.

create table if not exists equipment_types (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  description                 text,
  category                    text,
  location                    text,
  total_quantity              integer not null default 0,
  damaged_quantity            integer not null default 0,
  under_maintenance_quantity  integer not null default 0,
  retired_at                  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint equipment_types_name_not_blank
    check (length(trim(name)) > 0),
  constraint equipment_types_total_not_negative
    check (total_quantity >= 0),
  constraint equipment_types_damaged_not_negative
    check (damaged_quantity >= 0),
  constraint equipment_types_maintenance_not_negative
    check (under_maintenance_quantity >= 0),
  constraint equipment_types_unusable_within_total
    check (damaged_quantity + under_maintenance_quantity <= total_quantity)
);

-- SCRUM-275 AC2: the name is unique, ignoring capitalisation.
create unique index if not exists equipment_types_name_unique
  on equipment_types (lower(trim(name)));


-- ---------------------------------------------------------------------
-- 3. Equipment requests
-- ---------------------------------------------------------------------

create table if not exists equipment_requests (
  id                uuid primary key default gen_random_uuid(),
  event_request_id  uuid not null references event_requests(id),
  status            equipment_request_status not null default 'pending_review',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists equipment_requests_event_idx
  on equipment_requests (event_request_id);


-- ---------------------------------------------------------------------
-- 4. Equipment lines
-- ---------------------------------------------------------------------
-- One line per type per request. To ask for more of a type, raise that line's
-- quantity rather than adding a second line.

create table if not exists equipment_lines (
  id                    uuid primary key default gen_random_uuid(),
  equipment_request_id  uuid not null references equipment_requests(id),
  equipment_type_id     uuid not null references equipment_types(id),
  quantity              integer not null,
  technical_notes       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint equipment_lines_quantity_positive
    check (quantity > 0),
  constraint equipment_lines_one_per_type
    unique (equipment_request_id, equipment_type_id)
);


-- ---------------------------------------------------------------------
-- 5. Equipment reservations
-- ---------------------------------------------------------------------
-- Units held for an event over a period. A reservation is released, not
-- deleted: released_at says when, released_by says who (null when the system
-- released it, for example on cancellation), release_reason says why.
-- A line that still has a reservation cannot be deleted, release it first.

create table if not exists equipment_reservations (
  id                  uuid primary key default gen_random_uuid(),
  equipment_type_id   uuid not null references equipment_types(id),
  event_request_id    uuid not null references event_requests(id),
  equipment_line_id   uuid not null references equipment_lines(id),
  quantity            integer not null,
  start_at            timestamptz not null,
  end_at              timestamptz not null,
  flagged             boolean not null default false,
  released_at         timestamptz,
  released_by         uuid references auth.users(id),
  release_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint equipment_reservations_quantity_positive
    check (quantity > 0),
  constraint equipment_reservations_period_valid
    check (end_at > start_at),
  -- Release details only make sense once the reservation is released.
  constraint equipment_reservations_release_consistent
    check (released_at is not null
           or (released_by is null and release_reason is null))
);

-- The availability check (SCRUM-23) looks up live reservations per type and
-- period, so index exactly those rows.
create index if not exists equipment_reservations_type_period_idx
  on equipment_reservations (equipment_type_id, start_at, end_at)
  where released_at is null;

create index if not exists equipment_reservations_event_idx
  on equipment_reservations (event_request_id);


-- ---------------------------------------------------------------------
-- 6. updated_at triggers
-- ---------------------------------------------------------------------
-- Reuses set_updated_at() from 001.

drop trigger if exists equipment_types_set_updated_at on equipment_types;
create trigger equipment_types_set_updated_at
  before update on equipment_types
  for each row execute function set_updated_at();

drop trigger if exists equipment_requests_set_updated_at on equipment_requests;
create trigger equipment_requests_set_updated_at
  before update on equipment_requests
  for each row execute function set_updated_at();

drop trigger if exists equipment_lines_set_updated_at on equipment_lines;
create trigger equipment_lines_set_updated_at
  before update on equipment_lines
  for each row execute function set_updated_at();

drop trigger if exists equipment_reservations_set_updated_at on equipment_reservations;
create trigger equipment_reservations_set_updated_at
  before update on equipment_reservations
  for each row execute function set_updated_at();


-- ---------------------------------------------------------------------
-- 7. Row level security
-- ---------------------------------------------------------------------
-- Enabled with no policies: only the API's secret key reads or writes these
-- tables, and that key bypasses RLS. This stops the public anon key reaching
-- them through the Supabase Data API.

alter table equipment_types        enable row level security;
alter table equipment_requests     enable row level security;
alter table equipment_lines        enable row level security;
alter table equipment_reservations enable row level security;