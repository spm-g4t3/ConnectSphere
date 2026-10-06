-- 018_reassign_event_request.sql
-- SCRUM-331, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Adds reassign_event_request(): the assigned Event Coordinator hands an event
-- to a colleague, with an optional handover note. In one transaction it moves
-- event_requests.assigned_coordinator_id to the new coordinator, moves
-- reviewing_coordinator_id with it when no decision has been made yet, and
-- writes one row to event_request_assignment_history recording who handed what
-- to whom.
--
-- Run this once in the Supabase SQL Editor, after 017_require_assigned_coordinator.sql.
-- It reads columns from 014 (assigned_coordinator_id, the history table) and
-- from 010_event_request_decisions.sql on SCRUM-19 (reviewing_coordinator_id,
-- decision). 014 refuses to run unless 010 has been applied, so every database
-- that reaches this file has both. Safe to run again: create or replace
-- function redefines the function in place.
--
-- Numbered 018 by agreement with the team. 014 through 017 are applied and
-- SCRUM-17 holds 011-013. No existing file is touched.
--
--
-- Why a Postgres function:
--
-- A handover writes to two tables, and both writes must happen or neither. An
-- event whose coordinator changed with no history row would hide that a
-- handover ever happened. A history row with no change to the event would
-- record a handover that never happened. supabase-js talks to PostgREST, where
-- every call is its own HTTP request and its own transaction, so the API
-- cannot make the two writes together. A function body runs inside one
-- transaction, so an error anywhere rolls back everything before it. This is
-- the argument 004 makes for create_venue, 006 for process_change_request and
-- 016 for submit_event_request, and this function has the same shape as 016's:
-- lock the row, check each guard, write both rows, return the updated row.
--
--
-- Why the role check is inside the database here, when nowhere else is:
--
-- Everywhere else in this schema, authorisation is the API's job. 001 section 5
-- says so, and 015 records that pick_event_coordinator selects by role but
-- nothing enforces that a coordinator column names a coordinator; 014's header
-- lists that as deliberately not done. Checking here that the new coordinator
-- holds the event_coordinator role departs from that, on purpose.
--
-- The difference is timing. 015 chooses among people who already hold the
-- role, in the same statement that reads it. A handover names one particular
-- person, chosen by the outgoing coordinator from a list the frontend loaded
-- some time earlier. Between that list loading and this write, that person can
-- lose the role. A check in the API would read profiles in one HTTP request
-- and write in another, so the role could change between the two, which is
-- the same gap that made this a function in the first place. This function is
-- the only thing that writes a handover, so a check here, made while holding a
-- lock on that person's profile row (see the function), is the only one that
-- is actually true when the write is committed.
--
-- The API should still check, so it can return a clear 400 before the call is
-- made. This check is the one that cannot be bypassed.
--
-- The caller check (AC6: only the assigned coordinator may hand an event over)
-- is here for the same reason. "Is the caller the assigned coordinator?" is a
-- question about this row, and it is only reliably true while this function
-- holds the row lock. The API cannot ask it any earlier and still trust the
-- answer.
--
--
-- Why 'planning' cannot be reassigned, although 015 counts it as active:
--
-- AC6 names five statuses an event can be handed over in: submitted,
-- under_review, pending_clarification, approved and confirmed. 'planning' is
-- not among them, although it sits between approved and confirmed in
-- ALLOWED_TRANSITIONS and 015's workload count includes it. The two are
-- answering different questions. 015 asks how much work a coordinator has,
-- and leaving a real status out of that would undercount it. This function
-- asks what the customer has agreed may be handed over, and the AC is the
-- answer to that. SCRUM-318 records the customer saying planning is the same
-- as approved, so the status may never be written at all. If it ever is, an
-- event in planning cannot be handed over until someone asks the customer and
-- the AC is changed. This file follows the AC rather than guessing.
--
--
-- What this migration deliberately does not do:
--
--   * No check on the outgoing coordinator's role. They may have lost it,
--     through a change of job or leave, and that is often exactly why the
--     event is being handed over. Refusing the handover because the current
--     holder is no longer a coordinator would leave the event stuck with them.
--     They still have to be the assigned coordinator (the caller check). Only
--     the person receiving the event must hold the role.
--
--   * No handover by anyone other than the assigned coordinator: no
--     administrator, and no other coordinator taking an event over. AC6 says
--     the assigned coordinator hands it on. What happens to the events of a
--     coordinator who leaves without handing them over is the open question
--     014 recorded for the customer, and it stays open.
--
--   * No statuses other than the five AC6 names, and no change of status. A
--     handover moves responsibility, never the event's stage.
--
--   * No normalising of a blank handover note to null. 014 makes that the
--     service's job, and the column takes whatever it is given.
--
--   * No constraint, index, trigger or RLS policy. The self-handover rule
--     already exists as a constraint on the history table (014). The
--     per-event history read is already indexed (014). Both tables stay
--     deny-all (001 section 5, 014 section 4).
--
--   * No P0001. translateError in eventRequestService.js maps P0001 to a 503,
--     meaning "no coordinator available" (016). Any refusal here raised
--     without its own SQLSTATE would default to P0001 and reach the Organiser
--     as "try again later". Every raise below names its code for that reason.


-- ---------------------------------------------------------------------
-- 1. reassign_event_request
-- ---------------------------------------------------------------------
-- Volatile, the default, because it writes.
--
-- SQLSTATEs, one per refusal so the service maps by error.code rather than by
-- matching message text:
--
--   no_data_found (P0002)             no such event. Mapped to 404 already,
--                                     as in 006 and 016.
--   insufficient_privilege (42501)    the caller is not the event's assigned
--                                     coordinator (AC6). This is Postgres's
--                                     own code for "you may not do this to
--                                     this object", and the HTTP equivalent is
--                                     403. errors.js has deliberately had no
--                                     ForbiddenError, because answering 403 to
--                                     an Organiser asking for someone else's
--                                     request would confirm the id exists.
--                                     That concern does not apply here: every
--                                     coordinator can already see every event
--                                     in the shared queue, so a 403 tells them
--                                     nothing they did not know. The service
--                                     subtask will need to add that error.
--   object_not_in_prerequisite_state  the event's status is not one AC6
--   (55000)                           allows a handover from. The message names
--                                     the status. 409, as in 016.
--   invalid_parameter_value (22023)   the new coordinator does not hold the
--                                     event_coordinator role, or there is no
--                                     such person. The argument names someone
--                                     who cannot take the event. 400.
--   check_violation (23514)           the new coordinator is the current
--                                     one. This is the same rule 014's
--                                     event_request_assignment_history_
--                                     coordinator_changes constraint enforces
--                                     on the history row. It is raised here
--                                     first, with a readable message, and
--                                     under the code that constraint would
--                                     raise anyway, so the service gets the
--                                     same code whichever check catches it.
--                                     translateError already maps 23514 to a
--                                     400.
--   serialization_failure (40001)     the guarded update matched no row. It
--                                     cannot happen while the row lock is
--                                     held -- see the update for why it exists
--                                     anyway. Postgres's code for "a
--                                     concurrent change invalidated this
--                                     write". 409.
--
-- How two simultaneous handovers of the same event are handled, stated
-- exactly, because the obvious reading is not quite right:
--
--   - The row lock (`for update`) makes the two calls take turns. The second
--     waits until the first commits, then reads the row as the first left it,
--     now assigned to someone else.
--   - The caller check is what refuses the second call. Its p_assigned_by is
--     no longer the assigned coordinator, so it gets 42501, which is the
--     truth: by then they no longer hold the event.
--   - The guard on the UPDATE (`and assigned_coordinator_id = p_assigned_by`)
--     cannot match zero rows while this function holds the lock, because no
--     other transaction can change the row in between. It is a backstop. It
--     makes the statement itself incapable of overwriting a handover it did
--     not check, so the guarantee does not rest only on the lock having been
--     taken correctly further up. The same reasoning appears in
--     updateEventRequest, which keeps an organiser_id filter "that can never
--     fire" for the same purpose. If it ever does fire, something has broken
--     the locking, and 40001 says so.

create or replace function reassign_event_request(
  p_event_request_id   uuid,
  p_new_coordinator_id uuid,
  p_assigned_by        uuid,
  p_handover_note      text
)
returns event_requests
language plpgsql
as $$
declare
  v_request  event_requests;
  v_outgoing uuid;
begin
  -- Lock first, then read, so nothing can change the row between the guards
  -- below and the update that relies on them.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  v_outgoing := v_request.assigned_coordinator_id;

  -- AC6: only the assigned coordinator may hand the event over.
  --
  -- A null p_assigned_by is refused explicitly, not left to the comparison. A
  -- null caller against a row with no coordinator would otherwise compare
  -- equal under `is distinct from` and pass. 017 means a row past draft always
  -- has a coordinator, so the status check below would catch it anyway, but
  -- this guard should not depend on another one. A null caller would also
  -- write a history row with a null assigned_by, which 014's convention reads
  -- as an assignment the system made -- a false record of a person's handover.
  --
  -- `is distinct from` rather than `<>` for the same reason: an unknown
  -- comparison must refuse, not pass.
  if p_assigned_by is null or v_outgoing is distinct from p_assigned_by then
    raise exception 'only the coordinator assigned to event request % can hand it over', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The five statuses AC6 allows. Not draft, which is never assigned; not
  -- planning (see the header); not completed, rejected or cancelled, which
  -- are terminal and carry no further work to hand over.
  if v_request.status not in ('submitted', 'under_review', 'pending_clarification',
                              'approved', 'confirmed') then
    raise exception 'event request % has status %, and cannot be handed over in that status',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The new coordinator must hold the role now, and keep holding it until
  -- this commits. `for share` locks their profile row against an update or
  -- delete by another transaction, so a role revoked at the same moment
  -- either waits for this handover or happens first and refuses it. Without
  -- the lock, the check could pass and the role be removed before commit,
  -- and the header's reason for checking here would not be true.
  --
  -- A null p_new_coordinator_id matches no profile, so it is refused here too.
  perform 1
     from profiles p
    where p.id = p_new_coordinator_id
      and p.role = 'event_coordinator'
      for share;

  if not found then
    raise exception 'user % is not an Event Coordinator, so cannot be handed event request %',
      p_new_coordinator_id, p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- Not a handover at all. After the role check, so that someone handing the
  -- event to themselves after losing the role is told about the role first;
  -- the role is the more useful answer.
  if p_new_coordinator_id = v_outgoing then
    raise exception 'event request % is already assigned to that coordinator', p_event_request_id
      using errcode = 'check_violation';
  end if;

  -- The handover itself. reviewing_coordinator_id follows the new coordinator
  -- only while no decision has been made:
  --
  --   - Before a decision (submitted, under_review, pending_clarification,
  --     which 010's constraints guarantee carry no decision), it moves if it
  --     is set. 010's event_requests_decided_by_is_reviewer only accepts a
  --     decision from the reviewer. If the reviewer stayed with the outgoing
  --     coordinator, the person now responsible could not decide the request,
  --     and the person who handed it away still could. Moving it means
  --     responsibility and the right to decide stay with the same person. If
  --     it is not set, nobody has started reviewing, so there is nothing to
  --     move and it stays null for whoever starts the review.
  --
  --   - After a decision (approved, confirmed), it stays where it is. It now
  --     records who decided: decided_by must equal it, so changing it would
  --     make 010's constraint refuse the whole update and no decided event
  --     could ever be handed over. Even if no constraint stood in the way,
  --     moving it would rewrite the record of who decided. This is the case
  --     014's header gives for keeping assignment in a column of its own. The
  --     assigned coordinator changes; the reviewer of a decided request does
  --     not.
  update event_requests
     set assigned_coordinator_id  = p_new_coordinator_id,
         reviewing_coordinator_id = case
           when decision is null and reviewing_coordinator_id is not null
             then p_new_coordinator_id
           else reviewing_coordinator_id
         end
   where id = p_event_request_id
     and assigned_coordinator_id = p_assigned_by
  returning * into v_request;

  if not found then
    raise exception 'event request % changed hands while this handover was being made', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- One history row per handover. assigned_by is the person who handed it
  -- over, and it is never null here: under 014's convention, a non-null
  -- assigned_by is what tells a person's handover apart from an assignment
  -- the system made on submission (016) or in a backfill (014, 016, 017).
  -- previous_coordinator_id is the outgoing coordinator, so the chain for an
  -- event reads null -> A, A -> B, B -> C. created_at is left to its default:
  -- it records when the handover took effect.
  insert into event_request_assignment_history
    (event_request_id, previous_coordinator_id, new_coordinator_id,
     assigned_by, handover_note)
  values
    (p_event_request_id, v_outgoing, p_new_coordinator_id,
     p_assigned_by, p_handover_note);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Tell the API about the new function
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, including which functions exist. Without this,
-- rpc('reassign_event_request') fails with "function not found" until the
-- cache refreshes. 006, 010_event_request_clarifications and 014-017 end the
-- same way.

notify pgrst, 'reload schema';
