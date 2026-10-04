-- 016_submit_event_request.sql
-- SCRUM-330, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Makes submitting an event request and assigning its coordinator a single
-- step that either completes or leaves nothing behind. Adds
-- submit_event_request(), which moves a draft to 'submitted', assigns the
-- coordinator that pick_event_coordinator (015) chooses, and records that
-- assignment in event_request_assignment_history (014), all in one
-- transaction. Then it runs the backfill again, because submissions made
-- since 014 have no coordinator. The constraint that 014 deferred (every
-- request past draft, other than a cancelled one, has an assigned
-- coordinator) is not in this file; see below.
--
-- Run this once in the Supabase SQL Editor, after 015_assignment_function.sql.
-- Safe to run again; see section 2 for why the backfill writes nothing the
-- second time.
--
-- Numbered 016 by agreement with the team: 010 is used by three branches,
-- SCRUM-17 holds 011-013, and 014 and 015 are applied. No existing file is
-- touched. 014's header says the constraint "arrives in 015". 015 became the
-- assignment function, and the constraint is now in 017 (see below). 014 is
-- applied and append-only, so its header is left as written.
--
--
-- The constraint lives in 017_require_assigned_coordinator.sql, applied after
-- the service change is merged.
--
-- The two steps need opposite orders. The service change makes
-- submitEventRequest call rpc('submit_event_request'), so this function has to
-- exist first. The constraint can only exist once the old submitEventRequest
-- has stopped running: that version moves a request to 'submitted' with a
-- plain PostgREST update that sets no coordinator, so under the constraint
-- every submission through it would fail with 23514. With both in one file,
-- there would be a period in which submissions are broken on the one shared
-- Supabase project. Split, there is none: apply this file (the old code still
-- works, because nothing requires a coordinator yet), merge the service
-- change, then apply 017.
--
--
-- Why this file exists, and why the submission is a Postgres function:
--
-- SCRUM-330's description says to call the assignment function inside the
-- shared status-change function from SCRUM-318. That function does not exist:
-- SCRUM-318 has not been started. What does exist is submitEventRequest, which
-- reads the row in one HTTP request and updates it in another, with no
-- transaction spanning the two.
--
-- The story needs a transaction. A successful submission must produce exactly
-- one coordinator and exactly one history row. A refused submission (AC5: no
-- coordinator available) must leave the request a draft with nothing written.
-- That is three writes across two tables that must all happen or none happen.
-- supabase-js talks to PostgREST, where every call is its own HTTP request and
-- its own transaction, so a client-side sequence could set the status and
-- then fail to write the history row, leaving an assignment nobody can trace.
-- That is the argument 004_venue_functions.sql makes for create_venue, and
-- 006 makes for process_change_request. A Postgres function body runs inside
-- one transaction, so an error anywhere rolls back everything before it.
--
-- This is not a second, competing way to change status. When SCRUM-318 builds
-- the shared status-change function, that function either absorbs this one
-- (draft -> submitted becomes one of its branches) or calls it for that
-- transition. Either way the team ends up with one path, and this function is
-- what the draft -> submitted part of that path does until then. Its scope is
-- deliberately that one transition (see below) so it can be absorbed without
-- untangling anything else.
--
--
-- What this migration deliberately does not do:
--
--   * No submission-completeness check. Whether a draft has every field a
--     Coordinator needs is validateSubmitEventRequest's job, in the service,
--     run before this function is called. It lists every gap at once so the
--     Organiser can fix the form in one pass, which a raised exception
--     cannot. This function is the backstop for status and assignment only,
--     so a direct call that skips the service can submit an incomplete draft,
--     exactly as a direct PostgREST update can today.
--
--   * No role or ownership check on the caller, and no role check on the
--     chosen coordinator. Who may submit which request is decided by the
--     API's middleware and the route's ownership check, as everywhere in this
--     schema. pick_event_coordinator already selects only profiles with the
--     event_coordinator role, and 015 records the remaining gap: the role is
--     read once and can change afterwards.
--
--   * No transition other than draft -> submitted. Clarification, review,
--     decision and cancellation keep their current paths until SCRUM-318
--     brings them together. Including them here would make this the shared
--     status-change function without the story that is supposed to design it.
--
--   * No lock beyond the single row's `for update`. See the function's
--     comment for what that lock does and does not prevent.
--
--   * No trigger. Assignment happens because this function does it, called by
--     the service with the submission time it chose, not as a side effect of
--     any write that happens to set status = 'submitted'. A trigger would also
--     run for the check scripts' direct inserts, and would hide from someone
--     reading submitEventRequest where the coordinator comes from.
--
--   * No index and no RLS policy. Neither table gains a new query shape here,
--     and both stay deny-all by design (001 section 5, 014 section 4).


-- ---------------------------------------------------------------------
-- 1. submit_event_request
-- ---------------------------------------------------------------------
-- Volatile, which is the default and so is not written out: it writes.
-- Contrast 015's stable pick_event_coordinator, which only reads.
--
-- p_submitted_at is a parameter rather than now(). submitEventRequest takes
-- an injectable clock (`now`) so its tests can assert an exact submission
-- time, and 005's header records that submitted_at is set by the API and not
-- by a trigger for the same reason. This keeps that ability to supply the time.
-- The history row's created_at is deliberately left to its column default.
-- That column records when the assignment was made, which is the database's
-- fact, not the Organiser's submission time.
--
-- Why `for update`, stated in full so nobody credits the lock with more than
-- it does:
--
--   - It DOES stop two concurrent submissions of the same request. The second
--     call waits for the first transaction to finish, then reads the row as
--     the first left it, now 'submitted', and is refused by the draft check.
--     Without the lock both could pass the draft check, both could pick a
--     coordinator, and the request would get two history rows.
--   - It does NOT stop two different requests submitted at the same moment
--     from picking the same coordinator. Each locks only its own row, and
--     pick_event_coordinator is stable, so each sees the workloads as they
--     were when its own statement started, without the other's assignment.
--     The story accepts this: fairness is approximate, and 015's header
--     explains why serialising all submissions to prevent it is not worth it.
--
-- Errors, each with its own SQLSTATE so the service can map them by error.code
-- rather than by matching message text:
--
--   no_data_found (P0002)             no such request. This matches
--                                     process_change_request, and
--                                     translateError already turns P0002 into a
--                                     NotFoundError.
--   object_not_in_prerequisite_state  the request is not a draft. Postgres's
--   (55000)                           standard code for "this object is not in
--                                     the state the operation needs". The
--                                     service subtask should map it to a 409,
--                                     matching its own canTransition refusal.
--                                     translateError does not map it yet.
--   null_value_not_allowed (22004)    p_submitted_at was null. Always a caller
--                                     bug: a submitted row with no submission
--                                     time would sort to the back of the
--                                     coordinator queue forever.
--   raise_exception (P0001)           no coordinator is available (AC5). It is
--                                     the only P0001 this function raises, so
--                                     the code alone identifies it.
--
-- A raised error ends the function and rolls back everything it did. A
-- refused submission therefore writes nothing: the request stays a draft, with
-- no coordinator and no history row.

create or replace function submit_event_request(
  p_event_request_id uuid,
  p_submitted_at     timestamptz
)
returns event_requests
language plpgsql
as $$
declare
  v_request     event_requests;
  v_coordinator uuid;
begin
  if p_submitted_at is null then
    raise exception 'submit_event_request needs a submission time'
      using errcode = 'null_value_not_allowed';
  end if;

  -- Lock first, then read: the row cannot change between the status check
  -- below and the update that relies on it.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- The backstop. The service checks canTransition before calling; this is
  -- for any caller that does not go through the service. It plays the same
  -- role as process_change_request's status <> 'processed' guard.
  if v_request.status <> 'draft' then
    raise exception 'event request % has status %, and only a draft can be submitted',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 015 is the only definition of the selection rule. Null means there is no
  -- one to assign, and AC5 refuses the submission. Raising here rolls back,
  -- so the row is left exactly as it was.
  v_coordinator := pick_event_coordinator(p_event_request_id);

  if v_coordinator is null then
    raise exception 'No coordinator is available; please try again later';
  end if;

  -- status, submitted_at and the coordinator in one statement. 005's
  -- event_requests_submitted_at_matches_status and 017's constraint are
  -- checked against the row as a whole, so writing these columns one at a
  -- time would pass through states those constraints refuse. updated_at is
  -- left to the set_updated_at trigger (001).
  update event_requests
     set status                  = 'submitted',
         submitted_at            = p_submitted_at,
         assigned_coordinator_id = v_coordinator
   where id = p_event_request_id
  returning * into v_request;

  -- The first assignment of this request. previous_coordinator_id and
  -- assigned_by are null, following 014's convention: nobody held it before,
  -- and the system made the choice. No handover note, because nothing is
  -- being handed over.
  insert into event_request_assignment_history
    (event_request_id, previous_coordinator_id, new_coordinator_id,
     assigned_by, handover_note)
  values
    (p_event_request_id, null, v_coordinator, null, null);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Backfill again
-- ---------------------------------------------------------------------
-- 014's backfill covered the rows that existed when 014 ran. Every submission
-- since then went through today's submitEventRequest and created another
-- submitted row with no coordinator, which 014's header predicted. Those rows
-- are assigned here, so they get a coordinator now rather than waiting for
-- 017. 017 repeats this loop for anything submitted between this file and the
-- service change.
--
-- Same loop as 014, which still gives the reasons: one row at a time, so each
-- assignment counts toward the next choice; oldest submission first; a
-- history row only when the UPDATE actually changed a row; clock_timestamp()
-- so assignments made within this one run have distinct times; and an error
-- rather than a silent skip if nobody can be assigned.
--
-- Two differences from 014, both deliberate:
--
--   - The coordinator comes from pick_event_coordinator(), not from a copy of
--     the rule. 015's header makes that function the only definition of the
--     rule and says every assignment from 015 onward uses it. Pasting 014's
--     ORDER BY here would create a third copy, which is exactly what 015 was
--     written to stop. Calling it once per row in a loop is safe even though
--     it is stable: each call is a new statement inside this block, so it sees
--     the assignments made by earlier iterations. 015 warns about the
--     multi-row UPDATE case, which this is not.
--
--   - KEPT: the preference for an existing reviewing_coordinator_id.
--     014 used it because assigning someone other than the reviewer would
--     create an event its assigned coordinator cannot decide (010's
--     event_requests_decided_by_is_reviewer). The rows reaching this loop are
--     ones submitted since 014. If SCRUM-19's claim-on-review service merges
--     before this file is applied, some of them may already be under review
--     with a reviewer set, and the same reasoning applies to them. Keeping
--     the branch costs nothing and protects those rows.
--     DROPPED: 014's prerequisite guard on that column. 014 stops unless 010
--     has been applied, and this file runs after 014, so on any database that
--     reaches this point the column exists.
--
-- Running this a second time writes nothing: the loop selects only rows with
-- no coordinator, and after the first run there are none, unless new
-- submissions arrived through the old code in between. Once 017's constraint
-- is in place, a row with no coordinator cannot exist past draft, so later
-- runs have nothing to select at all.

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
-- 3. Tell the API about the new function
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, including which functions exist. Without this,
-- rpc('submit_event_request') fails with "function not found" until the cache
-- refreshes. 006, 010_event_request_clarifications, 014 and 015 end the same
-- way.

notify pgrst, 'reload schema';
