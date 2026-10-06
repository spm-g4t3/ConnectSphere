-- 017_require_assigned_coordinator.sql
-- SCRUM-330, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Adds the constraint 014 deferred: every event request past draft, other than
-- a cancelled one, has an assigned coordinator. Before adding it, this file
-- runs 016's backfill loop again, because requests submitted between 016 and
-- the service change may still have no coordinator.
--
-- Run this once in the Supabase SQL Editor, after 016_submit_event_request.sql
-- AND after the service change described below. Safe to run again: the
-- backfill writes nothing when every row is already assigned, and the
-- constraint block checks whether the constraint already exists.
--
-- Numbered 017 by agreement with the team, following 016. No existing file is
-- touched.
--
--
-- DO NOT APPLY THIS until submitEventRequest (src/services/eventRequestService.js)
-- calls rpc('submit_event_request'), and that change is merged and running on
-- every teammate's machine.
--
-- Until then, submitEventRequest moves a request to 'submitted' with a plain
-- PostgREST update that sets no coordinator. 016's header explains why the
-- function and the constraint were split into two files. In short, the
-- function has to exist before the new service code can call it, and the
-- constraint can only exist once the old code has stopped running.
--
-- What breaks if this is applied too early:
--
--   * Every Organiser submission made through the old code. The update
--     violates the constraint with 23514, translateError turns that into a
--     400 telling the Organiser a value was rejected, and the request stays a
--     draft. This happens on the one shared Supabase project the whole team
--     develops and demos against, for everyone still running the old code.
--
-- What breaks whenever this is applied, early or not, until the scripts
-- themselves change:
--
--   * The three hand-run check scripts that create rows directly at
--     'submitted' with no coordinator: check-event-change-request-service.js,
--     check-event-request-routes.js and check-venue-routes.js. They fail during
--     setup with the same 23514. Merging the service change does not fix them,
--     because they write to the table directly rather than through
--     submitEventRequest. They need to submit through submit_event_request, or
--     set a coordinator on the rows they create.
--
--
-- What this migration deliberately does not do:
--
--   * No change to submit_event_request or pick_event_coordinator. This file
--     only enforces what 016's function already does on every submission.
--
--   * No NOT NULL on assigned_coordinator_id. Drafts legitimately have none,
--     so the requirement depends on the status, as the constraint expresses.
--
--   * No trigger, index or RLS policy, for the reasons 014 and 016 give.


-- ---------------------------------------------------------------------
-- 1. Backfill again, immediately before the constraint
-- ---------------------------------------------------------------------
-- 016's loop, unchanged. Between 016 and the service change, submissions still
-- went through the old submitEventRequest and created rows with no coordinator.
-- They are assigned here, in the same file as the constraint, so the
-- constraint is added immediately after the last unassigned row is handled.
--
-- 016 gives the reasoning for every part of this loop: one row at a time,
-- coordinators chosen by pick_event_coordinator (015), the
-- reviewing_coordinator_id preference, clock_timestamp(), a history row only
-- when the UPDATE changed a row, and an error if nobody can be assigned. It is
-- not repeated here, so there is one explanation to keep up to date.
--
-- Running this a second time writes nothing. After the first run, and
-- permanently once section 2 exists, no row past draft lacks a coordinator.

do $$
declare
  v_request     record;
  v_coordinator uuid;
begin
  for v_request in
    select er.id, er.reviewing_coordinator_id
      from event_requests er
     where er.status not in ('draft', 'cancelled')
       and er.assigned_coordinator_id is null
     order by er.submitted_at asc nulls last, er.created_at asc, er.id asc
  loop
    if v_request.reviewing_coordinator_id is not null then
      v_coordinator := v_request.reviewing_coordinator_id;
    else
      v_coordinator := pick_event_coordinator(v_request.id);

      if v_coordinator is null then
        raise exception 'Cannot backfill event request %: no profile has role event_coordinator. Create a coordinator, then run this migration again.', v_request.id;
      end if;
    end if;

    update event_requests
       set assigned_coordinator_id = v_coordinator
     where id = v_request.id
       and assigned_coordinator_id is null;

    if found then
      insert into event_request_assignment_history
        (event_request_id, previous_coordinator_id, new_coordinator_id,
         assigned_by, handover_note, created_at)
      values
        (v_request.id, null, v_coordinator,
         null, null, clock_timestamp());
    end if;
  end loop;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Every request past draft has a coordinator
-- ---------------------------------------------------------------------
-- The constraint 014 deferred until the submit path could satisfy it.
--
-- cancelled is excluded for the reason 010 gives for its decision constraints:
-- a request can be cancelled straight from draft, before anyone at
-- ConnectSphere was ever responsible for it. Requiring a coordinator on every
-- cancelled row would make it impossible to cancel such a draft without
-- inventing a coordinator for it. An event cancelled after submission keeps
-- the coordinator it already had, because nothing removes one. The constraint
-- simply does not demand one.
--
-- status is not null (001), so `status in (...)` cannot evaluate to null, and
-- the check cannot pass a row through three-valued logic.
--
-- Postgres checks every existing row when a CHECK constraint is added. If the
-- backfill above missed anything, for example a request submitted through the
-- old code while this file was running, this block fails, names the
-- constraint, and nothing is added. That is the intended failure: the fix is
-- to run the file again.
--
-- Guarded on conname and conrelid, in the style of 005 section 3 and 014,
-- because constraint names only have to be unique within a table.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_assigned_when_submitted'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_assigned_when_submitted check (
        status in ('draft', 'cancelled')
        or assigned_coordinator_id is not null
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. Tell the API about the change
-- ---------------------------------------------------------------------
-- PostgREST caches the schema. 006, 010_event_request_clarifications, 014, 015
-- and 016 end the same way, and keeping the habit means nobody has to decide,
-- file by file, whether a change was one PostgREST needs to hear about.

notify pgrst, 'reload schema';
