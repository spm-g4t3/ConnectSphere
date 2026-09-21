-- ---------------------------------------------------------------------------
-- 007_user_roles.sql
--
-- The user role vocabulary, and the profiles table that carries it.
--
-- Not part of SCRUM-15. This is a cross-cutting authorisation dependency:
-- SCRUM-15 needs it because AC2 says an *authorised* change, but so will the
-- Coordinator review stories, SCRUM-45, and every future role-gated endpoint.
-- It has its own ticket for that reason.
--
-- Why this migration exists at all: `profiles` is already live in the Supabase
-- project and is queried by src/routes/auth.js, but it was created by hand in
-- the dashboard and appears in no migration. So the repo cannot rebuild the
-- database it depends on, and nothing records which role strings are legal.
-- Both are fixed here.
--
-- The five roles are the ones named in README.md, in the casing the live data
-- already uses (lowercase snake_case -- the existing row reads 'event_organiser').
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. The vocabulary
-- ---------------------------------------------------------------------
-- An enum rather than a check constraint, matching event_request_status in
-- 001: the database decides which roles are storable, and a test asserts the
-- JavaScript list in src/domain/userRole.js still matches this one.
--
-- To add a value later:  alter type user_role add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum (
      'event_organiser',          -- external: submits an event and its requirements
      'event_coordinator',        -- internal: owns planning for an assigned event
      'venue_staff',              -- internal: venue information, availability, bookings
      'technical_support_staff',  -- internal: equipment and technical support
      'attendee'                  -- external: registers for and attends an event
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------
-- `if not exists`, because this table is already live. Running this migration
-- against the existing project must document it, not recreate it -- the column
-- list below is the shape read back from the live database, not a redesign.
--
-- id is both the primary key and the foreign key: a profile *is* the
-- application's half of an auth.users row, one to one. on delete cascade,
-- because a profile for a deleted account is meaningless.

create table if not exists profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       text not null,
  full_name  text,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 3. Adopt the enum
-- ---------------------------------------------------------------------
-- Separate from the create above so this migration is correct both on a fresh
-- database and against the live one, where the column already exists as text.
--
-- The cast fails loudly if any stored role is not in the vocabulary, which is
-- the intended behaviour -- a silent coercion would hide a typo that has been
-- granting or denying access. Before applying, run:
--
--   select distinct role from profiles
--    where role not in ('event_organiser','event_coordinator','venue_staff',
--                       'technical_support_staff','attendee');
--
-- and expect zero rows.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'profiles' and column_name = 'role' and data_type = 'text'
  ) then
    alter table profiles alter column role type user_role using role::user_role;
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001, 002 and 003: enabled with no policies, so a stray
-- publishable key reads nothing. The API is the only reader, and it holds the
-- secret key. requireAuth reads a caller's own role through it.

alter table profiles enable row level security;
