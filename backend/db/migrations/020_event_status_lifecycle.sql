-- 020_event_status_lifecycle.sql
-- SCRUM-320, a subtask of SCRUM-318 (Manage the Event Status Lifecycle)
--
-- Makes the database agree with the nine-status model SCRUM-319 put in
-- src/domain/eventRequestStatus.js. 'planning' is no longer a status: the
-- customer treats planning as approval, so that stage is 'approved' (SCRUM-318
-- design decisions). This file moves any request still in 'planning' to
-- 'approved', takes 'planning' out of the two decision constraints from 010,
-- and adds a constraint that refuses 'planning' on any later write.
--
-- Run this once in the Supabase SQL Editor, after 019. Safe to run again: the
-- UPDATE finds nothing the second time, each constraint block checks what is
-- there before it acts, and the new constraint is guarded on its name.
--
-- Numbered 020, the next unused number on every branch. No existing file is
-- touched, including 001, whose header says additions go in a new numbered
-- migration rather than an edit.
--
--
-- Why a CHECK constraint, and 'planning' stays in the enum:
--
-- event_request_status is a Postgres enum (001), and Postgres cannot drop a
-- value from one. The only way is to build a new type, switch the column over
-- and drop the old type. That is not hard for the column. It is hard for
-- what reads it: pick_event_coordinator (015) and reassign_event_request (018)
-- both compare status with a list that contains the literal 'planning'. Once
-- the value is gone from the enum, that literal no longer parses, so both
-- functions fail with 22P02 on every call until they are redefined. 015 says
-- it is the only definition of the selection rule and that nothing may copy
-- it, and redefining it here to delete one word would be exactly the copy that
-- sentence forbids.
--
-- A CHECK constraint gives the same guarantee where it matters. A direct
-- write of 'planning' is refused, the enum still refuses anything that is not
-- one of its values, and both functions keep working unchanged. The cost is a
-- dead value in the enum, which nothing can write. 001's list of ten and
-- tests/domain/eventRequestStatus.test.js both record that.
--
--
-- What this migration deliberately does not do:
--
--   * No status history table. SCRUM-320 lists it, and SCRUM-321 records into
--     it, but it is built separately from this change to the status set. This
--     file only changes which statuses exist. The move from 'planning' to
--     'approved' below is therefore not recorded anywhere except updated_at.
--
--   * No change to pick_event_coordinator (015) or reassign_event_request
--     (018). Their lists still say 'planning'. With no row able to hold it,
--     those entries are dead and harmless, and leaving them keeps the
--     assignment and handover rules exactly as SCRUM-327 shipped them.
--
--   * No change to any other column, constraint or index. 005's
--     event_requests_submitted_at_matches_status and 017's
--     event_requests_assigned_when_submitted do not mention 'planning' and
--     are untouched. A 'planning' row already has a submitted_at and a
--     coordinator, so as an 'approved' row it still satisfies both.
--
--   * No change to 010's meaning. The two constraints are rewritten with the
--     same statuses minus 'planning', so every row they accepted and rejected
--     before, they accept and reject now.
--
--   * No fix for 'rejected' -> 'draft'. SCRUM-318 allows it, but 010's
--     event_requests_decision_has_decided_status requires a decision to sit
--     on a decided status, and a draft is not one. A reopened request will
--     have to clear decision, decision_note, decided_by and decided_at in
--     the same write. That belongs to the story that reopens a rejected
--     request (SCRUM-19), not to this one.


-- ---------------------------------------------------------------------
-- 1. Requests still in 'planning' become 'approved'
-- ---------------------------------------------------------------------
-- First, because the constraints below check every existing row when they are
-- added, and one that is still in 'planning' would stop them.
--
-- 'approved' satisfies everything 'planning' did. 010's decided-status
-- constraints list both, so a 'planning' row already has its decision. 005 and
-- 017 only ask whether the status is 'draft' or 'cancelled', which neither is.
--
-- updated_at moves, through the set_updated_at trigger from 001. The status did
-- change, and that is what the column records.

update event_requests
   set status = 'approved'
 where status = 'planning';


-- ---------------------------------------------------------------------
-- 2. 010's decision constraints, without 'planning'
-- ---------------------------------------------------------------------
-- Each is dropped and added again only while its stored definition still
-- mentions 'planning', which is what makes this section safe to run twice:
-- the second time the definition is clean and the block does nothing.
--
-- Both are skipped when they do not exist. They are created by 010's
-- decision columns (SCRUM-19), and a database that has not had that
-- migration has nothing here to correct. Nothing is created in that case.
-- If 010 is applied later it runs before this file, as it does everywhere,
-- and this section rewrites what it created.
--
-- Same names and same checks as 010, so the SCRUM-95 cases still hold: a
-- decided status needs a decision, a decision needs a decided status, and
-- 'cancelled' is admitted on the second only. Re-adding a constraint checks
-- every row, which section 1 has just made safe.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decided_status_has_decision'
      and conrelid = 'public.event_requests'::regclass
      and pg_get_constraintdef(oid) ilike '%planning%'
  ) then
    alter table event_requests
      drop constraint event_requests_decided_status_has_decision;

    alter table event_requests
      add constraint event_requests_decided_status_has_decision check (
        status not in ('approved', 'rejected', 'confirmed', 'completed')
        or decision is not null
      );
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decision_has_decided_status'
      and conrelid = 'public.event_requests'::regclass
      and pg_get_constraintdef(oid) ilike '%planning%'
  ) then
    alter table event_requests
      drop constraint event_requests_decision_has_decided_status;

    alter table event_requests
      add constraint event_requests_decision_has_decided_status check (
        decision is null
        or status in (
          'approved', 'rejected', 'confirmed', 'completed', 'cancelled'
        )
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. Only the nine statuses of the lifecycle
-- ---------------------------------------------------------------------
-- The enum refuses a value it has never heard of. This refuses the one it
-- still holds that the lifecycle no longer has. Listing all nine, rather than
-- writing `status <> 'planning'`, keeps the constraint a statement of the
-- model: it reads as the same list as STATUS in the domain module.
--
-- status is not null (001), so `status in (...)` cannot evaluate to null and
-- the check cannot pass a row by accident through three-valued logic.
--
-- Guarded on conname and conrelid, in the style of 005 section 3, 014 and 017,
-- because constraint names only have to be unique within a table.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_status_in_lifecycle'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_status_in_lifecycle check (
        status in (
          'draft', 'submitted', 'under_review', 'pending_clarification',
          'approved', 'confirmed', 'completed', 'rejected', 'cancelled'
        )
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 4. Tell the API about the change
-- ---------------------------------------------------------------------
-- PostgREST caches the schema. 006, 010_event_request_clarifications, 014 to
-- 017 end the same way, and keeping the habit means nobody has to decide, file
-- by file, whether a change was one PostgREST needs to hear about.

notify pgrst, 'reload schema';
