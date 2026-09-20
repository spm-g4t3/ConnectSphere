-- 006_event_change_requests.sql
-- SCRUM-11: Request changes to a submitted event
--
-- Lets an Event Organiser ask for a change to an event they have already
-- submitted, say which piece of information or arrangement the change is
-- about (AC1, AC2, AC3), track whether it is outstanding, in progress, or
-- processed (SCRUM-34, AC4), and -- once processed -- tell an approved
-- change apart from a rejected one and apply an approved change back onto
-- the event record (SCRUM-37, AC5). Builds on 001_event_requests.sql -- run
-- after it.
--
-- This file consolidates what were originally five sequential migrations
-- (006_event_change_requests, 007_event_change_request_status,
-- 008_event_change_field_venue_equipment, 009_event_change_request_decision,
-- 010_event_change_request_functions) into the single, final shape of
-- event_change_requests, now that all five have shipped. Environments that
-- already ran the original five have this exact schema; this file lets a
-- fresh environment reach the same place in one step. Every statement below
-- is still guarded (`if not exists` / `create or replace` / `drop ... if
-- exists` then recreate), so re-running it against a database that already
-- has this schema is a no-op, the same as re-running any of the originals
-- was.
--
-- Also left to the API layer, not enforced here:
--   - "submitted" means event_requests.status <> 'draft'. That is a business
--     rule about *when* a request may be made, not a shape the data must
--     always have, so it is checked the same way submission-completeness is
--     checked in 001: by the service, not the schema.
--   - requested_by/processed_by must match the caller's role (Organiser /
--     Coordinator). Authorisation is an API concern throughout this schema
--     (see section 6).


-- ---------------------------------------------------------------------
-- 1. What can be changed
-- ---------------------------------------------------------------------
-- A fixed vocabulary rather than a free-text field name, so requests can be
-- grouped and applied without parsing prose. 'other' is the escape hatch for
-- arrangements that are not their own event_requests column -- venue,
-- equipment, accessibility, catering -- the Organiser still describes those
-- in requested_change, just without a structured field to hang off.
--
-- 'venue' and 'equipment' are first-class values here (not folded into
-- 'other') because the change request form (frontend/ChangeRequestForm.jsx,
-- SCRUM-32) offers them as their own choices, distinct from 'other'.
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
      'other',
      'venue',
      'equipment'
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. The three states an Organiser can be shown
-- ---------------------------------------------------------------------
-- Deliberately only the three states SCRUM-34 asks for, not a wider workflow
-- enum. 'processed' does not distinguish an approved outcome from a
-- rejected one -- that is what change_request_decision (section 3) is for --
-- because the three-state vocabulary is a public contract the Organiser's
-- status list already displays: an approved and a rejected request both
-- still read as "Processed" to the Organiser; only whoever decided it needs
-- to know which.
--
-- To add a value later:  alter type change_request_status add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'change_request_status') then
    create type change_request_status as enum (
      'outstanding',  -- submitted; nobody has started on it yet
      'in_progress',  -- someone is actively reviewing or actioning it
      'processed'     -- a decision has been made; nothing further pending
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. The outcome of processing
-- ---------------------------------------------------------------------
-- decision is its own enum, not a split of change_request_status, for the
-- reason given in section 2: the three-state status is what the Organiser's
-- status list displays, and stays that way regardless of outcome.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'change_request_decision') then
    create type change_request_decision as enum (
      'approved',
      'rejected'
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 4. Change requests
-- ---------------------------------------------------------------------
-- One row per requested change. An Organiser who wants three things changed
-- submits three rows, not one row with three fields crammed in -- so each
-- can be tracked and processed on its own.

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

  -- outstanding / in progress / processed (SCRUM-34, AC4). Every row starts
  -- 'outstanding': nothing waits on a decision it has not asked for yet.
  status             change_request_status not null default 'outstanding',

  -- the outcome of processing, once status = 'processed' (SCRUM-37, AC5).
  -- Nullable, and only meaningful once processed -- the constraint below
  -- ties the two together, so a row can never claim to be processed with no
  -- recorded outcome, or claim an outcome while still outstanding or in
  -- progress.
  decision           change_request_decision,

  -- nullable for the same reason last_modified_by is nullable in 003: an
  -- approval rarely needs an explanation. Requiring one for a rejection is
  -- application-level policy (the service's job), not a shape the schema
  -- should force onto every row.
  decision_notes     text,

  -- mirrors requested_by's shape: a real user, restricted from disappearing
  -- while their decision is still on record. There is no Coordinator role to
  -- check this against yet -- same gap requested_by already has with the
  -- Organiser role -- so this column only guarantees the id names a real
  -- user, not that they held any particular role when they decided.
  processed_by       uuid references auth.users (id) on delete restrict,

  -- set once, the moment decision first becomes non-null (see the trigger in
  -- section 6) -- not on every later touch of the row, the way updated_at
  -- is.
  processed_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- a row can never claim to be processed with no recorded outcome, or claim
-- an outcome while still outstanding or in progress.
alter table event_change_requests
  drop constraint if exists event_change_requests_decision_matches_status;

alter table event_change_requests
  add constraint event_change_requests_decision_matches_status check (
    (status = 'processed') = (decision is not null)
  );


-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------

-- reuses set_updated_at() from 001_event_requests.sql rather than defining a second
drop trigger if exists event_change_requests_set_updated_at on event_change_requests;
create trigger event_change_requests_set_updated_at
  before update on event_change_requests
  for each row
  execute function set_updated_at();

-- without a dedicated column/trigger, "when was this actually decided" would
-- be overwritten the next time anything else about the row changed.
create or replace function set_change_request_processed_at()
returns trigger
language plpgsql
as $$
begin
  if new.decision is not null and old.decision is null then
    new.processed_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists event_change_requests_set_processed_at on event_change_requests;
create trigger event_change_requests_set_processed_at
  before update on event_change_requests
  for each row
  execute function set_change_request_processed_at();


-- ---------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------

-- "what has been requested for this event?" -- shown back to the Organiser
-- next to the event, and to whoever reviews it later
create index if not exists idx_event_change_requests_event
  on event_change_requests (event_request_id, created_at desc);

-- "what have I asked for, across all my events?"
create index if not exists idx_event_change_requests_requested_by
  on event_change_requests (requested_by, created_at desc);


-- ---------------------------------------------------------------------
-- 7. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001-004: enabled with no policies, which denies everything
-- by default. The Express API holds the service_role key, bypasses RLS, and
-- is where "is this Organiser/Coordinator allowed to do this?" is actually
-- enforced -- because that check needs the caller's role and their
-- relationship to the event, neither of which RLS can see through the
-- service-role connection.

alter table event_change_requests enable row level security;


-- ---------------------------------------------------------------------
-- 8. Applying an approved change back onto the event
-- ---------------------------------------------------------------------
-- SCRUM-37 (AC5): record the decision, then -- only if it was an approval --
-- apply the requested change to the event it belongs to.
--
-- Why this is a Postgres function rather than two separate updates from
-- JavaScript: deciding a change request and applying it to event_requests
-- are two different tables, and supabase-js talks to PostgREST, where every
-- call is its own HTTP request with no shared transaction. Without a single
-- transaction, an approval that fails to apply -- a rejected proposed_start
-- because it would now fall after proposed_end, for instance -- could leave
-- a change request marked processed for a change that was never actually
-- made. A Postgres function body IS a transaction, the same reasoning
-- create_venue and update_venue in 004_venue_functions.sql already rely on.
--
-- change_field is matched with an explicit branch per structured field
-- rather than a dynamic column update, the same choice update_venue makes
-- for its own attribute sets over a generic loop: every field this function
-- can apply is named here, in the open, rather than trusted to a string
-- built at runtime.
--
-- venue, equipment and other have no branch: event_requests has no column
-- for any of them yet (see the comment on 'other' in section 1 above).
-- Approving one of those is still a valid, recorded decision -- it is only
-- not reflected anywhere on the event record, because nowhere yet exists to
-- put it.
--
-- WHERE ... and status <> 'processed' is what makes "already processed"
-- safe under concurrency: a second call racing the first can only ever
-- match zero rows, never double-apply a change or overwrite one decision
-- with another.

create or replace function process_change_request(
  p_change_request_id uuid,
  p_decision           change_request_decision,
  p_decision_notes     text default null,
  p_processed_by       uuid default null
)
returns event_change_requests
language plpgsql
as $$
declare
  v_request event_change_requests;
begin
  update event_change_requests
  set
    status         = 'processed',
    decision       = p_decision,
    decision_notes = p_decision_notes,
    processed_by   = p_processed_by
  where id = p_change_request_id
    and status <> 'processed'
  returning * into v_request;

  if not found then
    if exists (select 1 from event_change_requests where id = p_change_request_id) then
      -- surfaces to the service as a ValidationError, not a 404: the request
      -- exists, it is just no longer open to a decision
      raise exception 'change request % has already been processed', p_change_request_id;
    else
      -- surfaces to the service as NotFoundError
      raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_decision = 'approved' then
    if v_request.change_field = 'event_name' then update event_requests set event_name = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'description' then update event_requests set description = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'purpose' then update event_requests set purpose = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_start' then update event_requests set proposed_start = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_end' then update event_requests set proposed_end = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'expected_attendance' then update event_requests set expected_attendance = v_request.requested_change::integer where id = v_request.event_request_id;
    end if;
    -- venue, equipment, other: no matching branch, nothing to apply -- see
    -- the comment above this function.
  end if;

  return v_request;
end;
$$;
