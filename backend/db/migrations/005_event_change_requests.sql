-- 005_event_change_requests.sql
-- SCRUM-11: Request changes to a submitted event
--
-- Lets an Event Organiser ask for a change to an event they have already
-- submitted, and say which piece of information or arrangement the change is
-- about. Builds on 001_event_requests.sql -- run after it.
--
-- Scope of this migration is deliberately narrow, matching one subtask of
-- SCRUM-11:
--   AC1: request a change to a submitted event
--   AC2: specify what needs to change
--   AC3: the system records the request against the event (a consequence of
--        this table existing at all)
--
-- Out of scope here, on purpose:
--   AC4 (can the Organiser tell it's outstanding vs processed) and
--   AC5 (approved changes land back on the event record)
-- are a status/workflow layer on top of this table. They belong in their own
-- migration once that subtask is picked up, the same way 001 deferred
-- SCRUM-10/11's own columns rather than guessing them upfront.
--
-- Also left to the API layer, not enforced here:
--   - "submitted" means event_requests.status <> 'draft'. That is a business
--     rule about *when* a request may be made, not a shape the data must
--     always have (a row here never becomes invalid because of it), so it is
--     checked the same way submission-completeness is checked in 001: by the
--     service, not the schema.
--   - requested_by must match the event's organiser. Authorisation is an API
--     concern throughout this schema (see section 4).


-- ---------------------------------------------------------------------
-- 1. What can be changed
-- ---------------------------------------------------------------------
-- A fixed vocabulary rather than a free-text field name, so requests can be
-- grouped and (later) applied without parsing prose. 'other' is the escape
-- hatch for arrangements that are not yet their own event_requests column --
-- venue, equipment, accessibility, catering -- the Organiser still describes
-- those in requested_change, just without a structured field to hang off.
--
-- To add a value later:  alter type event_change_field add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_change_field') then
    create type event_change_field as enum (
      'event_name',
      'description',
      'purpose',
      'proposed_start',
      'proposed_end',
      'expected_attendance',
      'other'
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Change requests
-- ---------------------------------------------------------------------
-- One row per requested change. An Organiser who wants three things changed
-- submits three rows, not one row with three fields crammed in -- so each can
-- later be tracked and processed on its own (AC4, next subtask).

create table if not exists event_change_requests (
  id                 uuid primary key default gen_random_uuid(),

  -- on delete cascade, unlike venue_change_history's on delete restrict:
  -- this is not an audit trail of a record that must keep existing after the
  -- fact. It only ever means something in the context of its event, and
  -- nothing today hard-deletes an event request. If that ever changes, its
  -- change requests should go with it rather than survive as orphans.
  event_request_id   uuid not null references event_requests (id) on delete cascade,

  -- who asked. Denormalised from event_requests.organiser_id rather than
  -- looked up through it, so the request still names its author even if the
  -- event's organiser were ever reassigned.
  requested_by       uuid not null references auth.users (id) on delete restrict,

  change_field       event_change_field not null,

  -- the new value the Organiser wants, or -- for 'other' -- a description of
  -- the arrangement change. Always required: a change request that does not
  -- say what should change is not a request.
  requested_change   text not null check (length(trim(requested_change)) > 0),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- reuses set_updated_at() from 001_event_requests.sql rather than defining a second
drop trigger if exists event_change_requests_set_updated_at on event_change_requests;
create trigger event_change_requests_set_updated_at
  before update on event_change_requests
  for each row
  execute function set_updated_at();


-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------

-- "what has been requested for this event?" -- shown back to the Organiser
-- next to the event, and to whoever reviews it later
create index if not exists idx_event_change_requests_event
  on event_change_requests (event_request_id, created_at desc);

-- "what have I asked for, across all my events?"
create index if not exists idx_event_change_requests_requested_by
  on event_change_requests (requested_by, created_at desc);


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001-004: enabled with no policies, which denies everything
-- by default. The Express API holds the service_role key, bypasses RLS, and
-- is where "is this Organiser allowed to request a change to this event?" is
-- actually enforced -- because that check needs the caller's role and their
-- relationship to the event, neither of which RLS can see through the
-- service-role connection.

alter table event_change_requests enable row level security;
