-- Baseline 01: extension, every enum, profiles and the shared helper functions.
-- The baseline files rebuild the schema as of migration 102 on an empty database.
-- They are never pasted into live; changes from 103 on go in backend/db/migrations.

-- The one "if not exists": Supabase may already have it installed. It lets the
-- venue_blocks exclusion constraint compare uuids in a gist index.
create extension if not exists btree_gist;

create type booking_status as enum (
  'approved',
  'flagged_for_review',
  'cancelled',
  'pending',
  'rejected',
  'withdrawn',
  'conflicting',
  'released'
);

create type change_request_decision as enum (
  'approved',
  'rejected',
  'event_cancelled'
);

create type change_request_status as enum (
  'outstanding',
  'in_progress',
  'processed'
);

create type equipment_request_status as enum (
  'pending_review',
  'under_review',
  'arranged',
  'cannot_be_fully_arranged',
  'cancelled'
);

create type event_cancellation_initiator as enum (
  'organiser_request',
  'connectsphere_decision'
);

create type event_change_field as enum (
  'event_name',
  'description',
  'purpose',
  'proposed_start',
  'proposed_end',
  'expected_attendance',
  'other',
  'venue',
  'equipment'
);

create type event_request_decision as enum (
  'approved',
  'rejected'
);

-- Live's value order. 'planning' is unused (approval covers that stage) and the
-- event_requests_status_in_lifecycle check keeps it out.
create type event_request_status as enum (
  'draft',
  'submitted',
  'under_review',
  'pending_clarification',
  'approved',
  'planning',
  'confirmed',
  'completed',
  'rejected',
  'cancelled',
  'safety_review',
  'safety_approved'
);

-- Live's value order. 'technical_support' is an old value Postgres cannot drop;
-- the app uses 'technical_support_staff'.
create type user_role as enum (
  'event_organiser',
  'event_coordinator',
  'venue_staff',
  'technical_support',
  'technical_support_staff',
  'attendee',
  'event_coordinator_lead',
  'safety_officer'
);

create type venue_block_reason as enum (
  'maintenance',
  'renovation',
  'safety',
  'internal_activity',
  'other'
);

create type venue_hold_status as enum (
  'active',
  'expired',
  'released',
  'converted'
);

-- Name and role for each auth.users account.
create table profiles (
  id uuid not null,
  role user_role not null,
  full_name text,
  created_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users(id)
);
alter table profiles enable row level security;

-- Shared by every table with an updated_at column.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Falls back to the id so a message never names nobody.
create or replace function profile_display_name(p_user_id uuid)
returns text
language sql
stable
as $$
  select coalesce(
    (select nullif(btrim(p.full_name), '') from profiles p where p.id = p_user_id),
    p_user_id::text
  );
$$;
