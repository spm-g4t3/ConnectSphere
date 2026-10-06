-- 015_assignment_function.sql
-- SCRUM-329, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Adds pick_event_coordinator(event_request_id): given an event request, it
-- answers which Event Coordinator should be assigned to it, or null if nobody
-- can be. It only reads. Assigning the coordinator, writing the history row and
-- moving the status are the caller's job. SCRUM-330's submission path is that
-- caller, and it does all three in one transaction.
--
-- Run this once in the Supabase SQL Editor, after 014_coordinator_assignment.sql.
-- The function reads event_requests.assigned_coordinator_id and
-- event_request_assignment_history, both created by 014. Safe to run again:
-- create or replace function redefines the function in place.
--
-- Numbered 015 by agreement with the team. 010 is used by three branches,
-- SCRUM-17 holds 011-013, and 014 is applied. No existing file is touched.
--
--
-- The rule, in the order it is applied:
--
--   1. Resubmission. If the event has been assigned before, its most recent
--      coordinator gets it back, provided they still hold the event_coordinator
--      role. Otherwise the event goes through steps 2-4 like any new one.
--   2. Fewest active events.
--   3. Ties go to whoever has gone longest without a new assignment.
--   4. Then profiles.id, an arbitrary order whose only purpose is that the same
--      data always produces the same answer.
--   5. No coordinator at all: null.
--
--
-- This function is now the only definition of the rule.
--
-- 014's backfill contains an earlier copy of steps 2-4, inside its do block.
-- 014 is applied and append-only, so that copy stays where it is. Treat it as
-- a historical record of how the rows that existed on 2 October 2026 were
-- assigned, not as a second definition of the rule. Every assignment from here
-- on goes through this function. If the rule changes, it changes here, in a new
-- migration that replaces this function, and 014 stays as it is.
--
-- The two copies are deliberately not identical. 014's backfill first prefers
-- an existing reviewing_coordinator_id, because it was assigning rows that
-- might already be under review, and has no resubmission step. This function
-- has a resubmission step and no reviewer preference. At submission nobody is
-- reviewing yet: reviewing_coordinator_id is only set when a request moves to
-- under_review.
--
--
-- Why the function takes the event id rather than a previous-coordinator
-- parameter:
--
-- With a previous-coordinator parameter, every caller would have to know that
-- resubmission exists, look up the event's previous holder correctly (the
-- newest history row, not any row), and pass it in. Any caller that forgot
-- would silently skip step 1, and nothing would report an error. Taking the
-- event id keeps the whole rule, including where the previous holder comes
-- from, inside this function. A caller has nothing to get wrong except the id.
--
--
-- Why 'planning' counts as active, although SCRUM-327 AC2 lists only five
-- statuses:
--
-- 'planning' is in the event_request_status enum (001), and ALLOWED_TRANSITIONS
-- in src/domain/eventRequestStatus.js puts it between approved and confirmed. A
-- request in planning is an event a coordinator is actively arranging. Leaving
-- it out would undercount that coordinator's workload whenever anything writes
-- the status, and the rule would keep giving new events to the person busiest
-- with planning. SCRUM-318 records the customer saying planning is the same as
-- approved, so the status may never be written in practice. If so, including
-- it changes no count. If it is written, including it is the correct
-- behaviour. Either way it costs nothing. It also matches the list 014's
-- backfill used, so existing rows and new rows were judged by the same
-- workload.
--
-- completed, rejected and cancelled are excluded because they are terminal in
-- ALLOWED_TRANSITIONS: no further work can arrive on them. draft is excluded
-- because a draft is never assigned.
--
--
-- Why this returns null rather than raising an error when there is no
-- coordinator:
--
-- 014's backfill raises, and it should: a migration that cannot assign a row
-- has to stop, rather than leave a row that the later constraint will reject.
-- This function's caller is in a different position. SCRUM-327 AC5 says that
-- when no coordinator is available, the submission is refused with a message
-- saying so, and the request stays a draft. To do that, the caller needs to
-- ask "is anyone available?" and get an answer it can check. A function that
-- raised would force every caller to wrap the call in an exception handler and
-- then work out which exception meant "nobody available" rather than something
-- else going wrong. With null, the caller checks the result and refuses
-- cleanly.
--
--
-- Step 1 handles a path that does not exist yet:
--
-- ALLOWED_TRANSITIONS today has no transition back to draft or to submitted
-- from any status. A request is submitted once and can never be submitted
-- again, so step 1 cannot currently fire through the application. It is here
-- because the story requires it, and because it is correct for whatever path
-- the team adds later. It costs one lookup, and 014's
-- idx_event_request_assignment_history_event serves exactly that lookup.
--
--
-- What this migration deliberately does not do:
--
--   * No writes. The function contains no insert or update. Choosing a
--     coordinator and recording the choice are separate jobs, so the caller
--     can refuse a submission (AC5) after asking, without anything to undo.
--     'stable' (see the function) makes Postgres refuse any write added here
--     later.
--
--   * No transaction handling. A function runs inside its caller's
--     transaction. SCRUM-330's submission path owns that transaction: it asks
--     this function, then sets the status, the coordinator and the history row
--     together, the way process_change_request (006) handles its two tables.
--
--   * No lock. Two submissions arriving at the same moment can both see the
--     same workloads and pick the same coordinator. The story accepts this:
--     fairness is approximate. Preventing it would mean making every
--     submission in the system wait its turn on one lock, so that workloads
--     are exactly even rather than nearly even. That is not worth the cost.
--
--   * No role check on the caller and no check that the event exists or is
--     in a submittable status. Who may submit is decided by the API's
--     middleware and ownership checks, as everywhere in this schema. Whether
--     the status may move is decided by canTransition. An id that matches no
--     event has no history, so it simply falls through to steps 2-4 and
--     returns a coordinator. A caller that passes an id it has just read
--     cannot do that by accident.
--
--   * No security definer. The function runs with the caller's permissions
--     (the default, as for every function in this repository). The API calls
--     it with the secret key, which bypasses RLS. If anyone called it with the
--     public key, it would be reading profiles and event_requests through
--     their deny-all RLS (001 section 5, 007), so it would see no
--     coordinators and return null. As security definer, it would instead
--     hand any caller the id of a real coordinator.
--
--   * No search_path setting. No function in this repository sets one, and
--     this one follows the house style. Supabase's database linter flags this
--     on every function here. If the team decides to change it, that belongs
--     in one migration covering all the functions, not just this one.
--
--   * No new index for steps 2 and 3, which look up events by
--     assigned_coordinator_id and history by new_coordinator_id. With a
--     handful of coordinators and a few dozen events, Postgres reads both
--     tables in full in well under a millisecond. Add an index once the
--     query is measurably slow, with the measurement as the reason.
--
--   * No constraint requiring an assigned coordinator. That arrives with
--     SCRUM-330, once the submit path can satisfy it. It must repeat 014's
--     backfill first, because every submission made through today's
--     submitEventRequest still creates a submitted row with no coordinator
--     (see 014's header).


-- ---------------------------------------------------------------------
-- pick_event_coordinator
-- ---------------------------------------------------------------------
-- plpgsql rather than the language sql that 008's venue_attribute_snapshot
-- uses. The rule has a step that can return early (resubmission) followed by
-- a fallback query. In plpgsql each step is its own statement, in the order
-- the story states them, so the code can be read against the rule line by
-- line. As one SQL expression it would be a coalesce of two subqueries.
--
-- stable, not volatile and not immutable:
--
--   - Not immutable, because the answer depends on table contents that change
--     with every submission.
--   - Stable states that the function only reads, and for plpgsql Postgres
--     enforces it: an insert or update inside a stable function fails rather
--     than running. The "writes nothing" promise above is therefore a property
--     the database checks, not just a comment.
--   - A consequence the caller has to know: a stable function sees the
--     database as it was when the calling statement started. Called once per
--     row inside a single multi-row UPDATE, it would judge every row against
--     the same workloads and give them all to the same coordinator. That is
--     why 014's backfill assigns one row per statement. SCRUM-330 calls this
--     once per submission and writes in a separate statement, so this does
--     not affect it.

create or replace function pick_event_coordinator(p_event_request_id uuid)
returns uuid
language plpgsql
stable
as $$
declare
  v_previous    uuid;
  v_coordinator uuid;
begin
  -- 1. Resubmission: the most recent holder, if they are still a coordinator.
  --
  -- Only the newest history row is considered. If its coordinator has lost
  -- the role, the event goes through steps 2-4 instead. It does not go back
  -- to an earlier holder: that person handed the event over, and returning it
  -- to them would reverse a deliberate handover.
  --
  -- created_at descending gives the newest row. id breaks a tie, which only
  -- happens if two history rows for one event are written in the same
  -- transaction (now() is fixed for a whole transaction). Nothing does that
  -- today. The id order is arbitrary, but it makes the answer stable.
  select h.new_coordinator_id
    into v_previous
    from event_request_assignment_history h
   where h.event_request_id = p_event_request_id
   order by h.created_at desc, h.id desc
   limit 1;

  if v_previous is not null and exists (
    select 1
      from profiles p
     where p.id = v_previous
       and p.role = 'event_coordinator'
  ) then
    return v_previous;
  end if;

  -- 2-4. Fewest active events, then longest without a new assignment, then id.
  --
  -- 'event_coordinator' is the only role value used, as in 014: the live
  -- user_role enum differs from 007's declaration in other values, so no other
  -- value is assumed to exist.
  --
  -- A "new assignment" in step 3 is any history row naming this coordinator
  -- as new_coordinator_id. That covers both automatic assignments and
  -- handovers they received, because either one is new work arriving. A
  -- coordinator with no history row has never been assigned anything, so
  -- their max is null, and nulls first puts them at the front.
  --
  -- If no profile has the role, the query returns no row, select into leaves
  -- v_coordinator null, and step 5 is the return below.
  select p.id
    into v_coordinator
    from profiles p
   where p.role = 'event_coordinator'
   order by
     (select count(*)
        from event_requests e
       where e.assigned_coordinator_id = p.id
         and e.status in ('submitted', 'under_review', 'pending_clarification',
                          'approved', 'planning', 'confirmed')) asc,
     (select max(h.created_at)
        from event_request_assignment_history h
       where h.new_coordinator_id = p.id) asc nulls first,
     p.id asc
   limit 1;

  return v_coordinator;
end;
$$;


-- ---------------------------------------------------------------------
-- Tell the API about the new function
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, including which functions exist. Without this,
-- the API's first rpc('pick_event_coordinator') would fail with "function not
-- found" until the cache refreshed. 006, 010_event_request_clarifications and
-- 014 end the same way.

notify pgrst, 'reload schema';
