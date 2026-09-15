-- 001_event_requests.sql
-- SCRUM-44: Define and map event request status stages
--
-- Creates the status vocabulary and the table event requests live in.
-- Run this once in the Supabase SQL Editor.
--
-- This table is shared: SCRUM-10 (create event request) and SCRUM-11
-- (save/edit draft) build on it and will add their own columns later.
-- Keep additions in a new numbered migration rather than editing this one.


-- ---------------------------------------------------------------------
-- 1. Status vocabulary
-- ---------------------------------------------------------------------
-- A real enum type, not a text column, so the database refuses an invalid
-- status outright instead of trusting every developer to spell it right.
--
-- 'pending_clarification' is not in the customer brief's example list. It is
-- included because the brief lets Coordinators "request clarification or
-- amendments" from the Organiser -- that is a different state from waiting on
-- ConnectSphere, because the Organiser has to act. AC3 requires the Organiser
-- to tell those two apart.
--
-- To add a value later:  alter type event_request_status add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_request_status') then
    create type event_request_status as enum (
      'draft',                  -- being written, not yet sent to ConnectSphere
      'submitted',              -- sent, waiting to be picked up
      'under_review',           -- a Coordinator is assessing it
      'pending_clarification',  -- Coordinator has asked the Organiser for more
      'approved',               -- cleared to proceed to planning
      'planning',               -- venue / equipment being arranged
      'confirmed',              -- arrangements complete
      'completed',              -- the event has taken place
      'rejected',               -- turned down
      'cancelled'               -- called off
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Event requests
-- ---------------------------------------------------------------------
-- Deliberately minimal: only what a status can hang off. Venue, accessibility
-- and equipment columns belong to SCRUM-10/11.
--
-- Most columns are nullable on purpose. A draft is allowed to be incomplete
-- (SCRUM-11), so "is this request complete enough to submit?" is a rule the
-- API enforces at submission time, not one the database enforces at all times.

create table if not exists event_requests (
  id                  uuid primary key default gen_random_uuid(),

  -- on delete restrict: removing a user must not silently erase event history.
  -- Deactivating an account is an application concern, not a row deletion.
  organiser_id        uuid not null references auth.users (id) on delete restrict,

  -- the one field always required: a draft still needs a name to be findable
  event_name          text not null check (length(trim(event_name)) > 0),

  description         text,
  purpose             text,
  proposed_start      timestamptz,
  proposed_end        timestamptz,
  expected_attendance integer,

  status              event_request_status not null default 'draft',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- an event cannot finish before it starts; only checked once both are given
  constraint event_requests_dates_ordered check (
    proposed_start is null
    or proposed_end is null
    or proposed_end > proposed_start
  ),

  -- attendance, when given, must be a positive number of people
  constraint event_requests_attendance_positive check (
    expected_attendance is null or expected_attendance > 0
  )
);


-- ---------------------------------------------------------------------
-- 3. Keep updated_at honest
-- ---------------------------------------------------------------------
-- Maintained by the database so no future query has to remember to set it.
-- AC4 ("the displayed status is updated when there is a change") relies on
-- this being trustworthy.

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists event_requests_set_updated_at on event_requests;
create trigger event_requests_set_updated_at
  before update on event_requests
  for each row
  execute function set_updated_at();


-- ---------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------

-- "show me my requests" -- the Organiser's own list (SCRUM-14)
create index if not exists idx_event_requests_organiser_status
  on event_requests (organiser_id, status);

-- "what is waiting for review?" -- the Coordinator's queue
create index if not exists idx_event_requests_status
  on event_requests (status);


-- ---------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------
-- Enabled with NO policies, which denies everything by default.
--
-- This is intentional. The Express API holds the service_role key, which
-- bypasses RLS entirely, so real authorisation (can this Organiser see this
-- request?) is enforced in the API layer where role and event relationship
-- are both known.
--
-- Enabling RLS anyway means that if the public anon key is ever pointed at
-- this table -- by mistake or by an attacker -- it returns nothing rather
-- than everything. Costs one line; removes a whole class of accident.

alter table event_requests enable row level security;
