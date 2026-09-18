-- 008_event_change_request_decision.sql
-- SCRUM-37 (AC5): record the outcome of processing a change request, so an
-- approved one can be told apart from a rejected one when it comes time to
-- apply it back onto the event record.
--
-- Builds on 006_event_change_request_status.sql -- run after it.
--
-- 006 deliberately left 'processed' unable to say which outcome it was (see
-- its own comment). This migration is that promised follow-up: it adds the
-- outcome as its own column rather than splitting 'processed' into
-- 'approved'/'rejected' within change_request_status, because the
-- three-state vocabulary is a public contract the Organiser's status list
-- already displays (SCRUM-34) -- an approved and a rejected request both
-- still read as "Processed" to the Organiser; only whoever decided it needs
-- to know which.


-- ---------------------------------------------------------------------
-- 1. The outcome of processing
-- ---------------------------------------------------------------------

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
-- 2. The columns
-- ---------------------------------------------------------------------
-- decision is nullable and only meaningful once status = 'processed' -- the
-- constraint below ties the two together, so a row can never claim to be
-- processed with no recorded outcome, or claim an outcome while still
-- outstanding or in progress.
--
-- decision_notes is nullable for the same reason last_modified_by is
-- nullable in 003: an approval rarely needs an explanation. Requiring one
-- for a rejection is application-level policy (the service's job), not a
-- shape the schema should force onto every row.
--
-- processed_by mirrors requested_by's shape: a real user, restricted from
-- disappearing while their decision is still on record. There is no
-- Coordinator role to check this against yet -- same gap requested_by
-- already has with the Organiser role -- so this column only guarantees the
-- id names a real user, not that they held any particular role when they
-- decided.

alter table event_change_requests
  add column if not exists decision       change_request_decision,
  add column if not exists decision_notes text,
  add column if not exists processed_by   uuid references auth.users (id) on delete restrict,
  add column if not exists processed_at   timestamptz;

alter table event_change_requests
  drop constraint if exists event_change_requests_decision_matches_status;

alter table event_change_requests
  add constraint event_change_requests_decision_matches_status check (
    (status = 'processed') = (decision is not null)
  );


-- ---------------------------------------------------------------------
-- 3. Recording when it was decided
-- ---------------------------------------------------------------------
-- Set once, the moment decision first becomes non-null -- not on every
-- later touch of the row, the way updated_at is. Without a dedicated column,
-- "when was this actually decided" would be overwritten the next time
-- anything else about the row changed.

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
-- 4. Row level security
-- ---------------------------------------------------------------------
-- No change needed -- event_change_requests already has RLS enabled with no
-- policies from 005, and new columns on an existing table do not alter that
-- posture.
