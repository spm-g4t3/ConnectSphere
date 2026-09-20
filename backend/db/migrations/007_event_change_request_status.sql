-- 007_event_change_request_status.sql
-- SCRUM-34 (AC4): show whether each change request is outstanding, in
-- progress, or processed, so an Organiser can track it.
--
-- Builds on 006_event_change_requests.sql -- run after it.
--
-- Kept as its own migration rather than folded into 006, the same way 003
-- added last_modified_by to venues after 002 shipped rather than reopening
-- it: 006 is already out, and an environment that ran it should not need to
-- re-run it to pick up a later, separate decision.


-- ---------------------------------------------------------------------
-- 1. The three states an Organiser can be shown
-- ---------------------------------------------------------------------
-- Deliberately only the three states this subtask asks for, not a wider
-- workflow enum. 'processed' does not yet distinguish an approved outcome
-- from a rejected one -- AC5 (applying a processed change back onto the
-- event) is a separate subtask, and this migration is not the place to guess
-- how that one wants to tell those apart. Splitting 'processed' later, if
-- it turns out to need splitting, is an `alter type ... add value` plus a
-- backfill, not a breaking change to what already exists.
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
-- 2. The column
-- ---------------------------------------------------------------------
-- Every row that already exists becomes 'outstanding' via the column
-- default, which is the correct backfill: 006 shipped with no status
-- concept at all, so anything already in the table is, by definition, still
-- waiting on someone.

alter table event_change_requests
  add column if not exists status change_request_status not null default 'outstanding';


-- ---------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------
-- No change needed -- event_change_requests already has RLS enabled with no
-- policies from 006, and a new column on an existing table does not alter
-- that posture.
