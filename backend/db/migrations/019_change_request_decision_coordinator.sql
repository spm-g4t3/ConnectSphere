-- 019_change_request_decision_coordinator.sql
-- SCRUM-332, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Redefines process_change_request() (006) so that only the event's assigned
-- Event Coordinator can decide its change requests. Everything else the
-- function did is unchanged: the guarded update, the two refusals for an
-- already-processed and a missing request, and the per-field branch that
-- applies an approved change to the event.
--
-- Run this once in the Supabase SQL Editor, after 018_reassign_event_request.sql.
-- It reads assigned_coordinator_id (014), which 017 guarantees is set on every
-- event past draft other than a cancelled one. Safe to run again: the
-- signature is unchanged, so create or replace function redefines the one
-- existing function in place.
--
-- Numbered 019 by agreement with the team. 014 through 018 are applied and
-- SCRUM-17 holds 011-013. No existing file is touched. 006's header says
-- authorisation is "an API concern throughout this schema"; 006 is applied and
-- append-only (001's header states the rule), so it is left as written, and
-- this header records where that stopped being true.
--
--
-- FOR THE TEAM: WHAT CHANGES WHEN THIS IS APPLIED
--
-- The signature does not change. The function takes the same four arguments
-- it took in 006, and processChangeRequest (src/services/eventChangeRequestService.js)
-- already passes the signed-in user as p_processed_by. So, unlike 016 and 017,
-- there is no order to get right between this file and a code change: decisions
-- keep working the moment this is applied, for the coordinator who holds the
-- event.
--
-- What does change:
--
--   * Any other coordinator is now refused with insufficient_privilege (42501).
--     eventChangeRequestService.js has its own translateError, which does not
--     map 42501 yet, so until the service subtask maps it to ForbiddenError
--     (as eventRequestService.js already does for 018) that refusal reaches
--     the caller as a 500 rather than a 403. It refuses correctly; it just
--     says so badly.
--   * The comment on processChangeRequest, "Coordinator authorization is
--     enforced by the API route", is no longer the whole truth. The route
--     checks the role; this function checks which coordinator.
--   * check-event-change-request-service.js is unaffected. Its event is
--     assigned to the same coordinator id it decides with.
--
--
-- Why the check is in the function, not in the service:
--
-- SCRUM-327 AC7 says that after a handover the new coordinator can act on the
-- event and the previous one can no longer change it. Approving a change
-- request writes to event_requests, so it is one of those actions.
--
-- Checking in the service would take three requests where there is one: read
-- the change request to find its event, read the event to find its
-- coordinator, then call this function. Each is its own HTTP request and its
-- own transaction, so a handover (018) could commit between the second and the
-- third. The previous coordinator would pass a check that was already false
-- and change an event that is no longer theirs, which is exactly what AC7
-- forbids. Inside the function, the event row is locked before the check and
-- stays locked until the decision commits, so the answer cannot change in
-- between. 018's header gives the same argument for the same check on a
-- handover, and 004, 006 and 016 make it for their own writes.
--
-- The lock is also what makes a decision and a handover of the same event take
-- turns. reassign_event_request locks the same row `for update`. Whichever
-- runs second waits, then sees what the first did: a decision that comes
-- second is checked against the new coordinator, and a handover that comes
-- second simply hands over an event with one more decided change request.
--
--
-- Why there is no new parameter:
--
-- The obvious design adds p_assigned_coordinator_id and compares that. It was
-- not done, for three reasons.
--
--   * It is the same person as p_processed_by in every real call. Both would
--     come from req.user.id. Two parameters for one value add nothing a caller
--     needs.
--   * Two parameters can disagree, and then the record lies. A call passing
--     the assigned coordinator as p_assigned_coordinator_id and someone else
--     as p_processed_by would pass the check and record the someone else as
--     having decided. Checking p_processed_by itself makes the person recorded
--     as deciding, by construction, the person who was entitled to decide.
--     That is the same concern 018 has about a false assigned_by.
--   * A new parameter changes the signature, and create or replace function
--     with a different argument list does not replace 006's function: it adds
--     a second one beside it. 006's four-argument version, with no check,
--     would stay in the schema. Every existing call passes four arguments,
--     which match both functions once the fifth is defaulted, and Postgres
--     refuses such a call as ambiguous ("function ... is not unique"). So
--     every decision would fail until the service changed, and the unchecked
--     version would sit there until someone dropped it. Doing it properly
--     needs a drop function in this file and a service change released at the
--     same moment, on a project where migrations are applied by hand. Keeping
--     the signature avoids all of it.
--
-- What p_processed_by now means: the coordinator deciding, who must be the
-- event's assigned coordinator at the moment of the decision. It is still
-- written to processed_by exactly as before.
--
--
-- Why p_processed_by keeps its default of null, and what a null now means:
--
-- 006 gave it a default of null, and the default stays for a mechanical
-- reason: Postgres does not let create or replace function remove a
-- parameter's default ("cannot remove parameter defaults from existing
-- function"). Removing it would mean dropping the function and creating it
-- again, a bigger change than this ticket needs, and as the next paragraph
-- explains, the default does no harm.
--
-- The default does not weaken the check, because a null is refused, not
-- skipped. A default is only dangerous if leaving the argument out means "do
-- not check", and here it means "nobody is deciding", which nobody is
-- entitled to do. A null could never legitimately match anyway: 017 requires
-- every event past draft, other than a cancelled one, to have an assigned
-- coordinator, and change requests can only be made against events past
-- draft. It is refused explicitly rather than left to the comparison, for the
-- reason 018 gives: under `is distinct from`, a null caller against an event
-- with no coordinator would compare equal and pass.
--
-- Before this file, a null p_processed_by was accepted and recorded a decision
-- by nobody. That was never a real call, since the service refuses a blank
-- processedBy before calling. It is now refused here as well.
--
--
-- The order of the checks:
--
--   1. The change request exists. There is no event to check the caller
--      against until it does, so a missing one is refused first, with the same
--      message and SQLSTATE as before (the check script asserts the 404).
--   2. The caller is the event's assigned coordinator.
--   3. The change request has not already been decided (006's guarded update,
--      unchanged).
--
-- 2 before 3, as in 018, where the caller check comes before the status
-- check. A coordinator who does not hold the event is refused as such, whatever
-- state the change request is in; telling them it was already decided would
-- answer a question they had no business asking. The assigned coordinator
-- still gets "already been processed" exactly as before.
--
--
-- What this migration deliberately does not do:
--
--   * No change to what an approved change applies, or how. The branch per
--     field is copied from 006 character for character, and
--     EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD (src/domain/eventChangeField.js)
--     still mirrors it.
--
--   * No role check on the caller. The route's coordinatorOnly does that. 018
--     checks a role in the database only for the person receiving an event,
--     whose role has to still hold at the moment of the write. Here the caller
--     must be the event's assigned coordinator, which is a stronger condition
--     than holding the role, and a coordinator who has lost the role is
--     already refused by the route.
--
--   * No check on the event's status. Which events may have change requests
--     decided is not this story's question, and the function never asked it.
--     One consequence, stated rather than discovered: a cancelled event keeps
--     its assigned coordinator, so they can still decide its change requests,
--     exactly as anyone could before.
--
--   * No SQLSTATE for "already been processed". 006 raises it without one, so
--     it is P0001, and eventRequestService.js maps P0001 to a 503 meaning "no
--     coordinator available". That does not bite here, because
--     eventChangeRequestService.js matches that refusal by its message, not
--     its code. Giving it a code would be a change in behaviour this ticket
--     does not need. Its text is unchanged, so the match still works. The new
--     refusal's message is worded to avoid matching either of that service's
--     message patterns ("not found", "already been processed").
--
--   * No lock on the change request row. 006's guarded update (`and status
--     <> 'processed'`) already makes two decisions of the same request safe:
--     the second matches no row. And because both lock the event first, two
--     decisions on the same event now take turns anyway.
--
--   * No index, constraint, trigger or RLS policy. The event is read by its
--     primary key, and the change request by its own. Both tables stay
--     deny-all (001 section 5, 006 section 7).


-- ---------------------------------------------------------------------
-- 1. process_change_request, redefined
-- ---------------------------------------------------------------------
-- Volatile, the default, because it writes.
--
-- SQLSTATEs the function raises itself:
--
--   no_data_found (P0002)           no change request with that id. Raised in
--                                   two places with the same message: by the
--                                   new read, and by 006's branch after the
--                                   update, which is now reached only if the
--                                   row is deleted between the two.
--                                   eventChangeRequestService maps it to 404.
--   insufficient_privilege (42501)  the caller is not the assigned coordinator
--                                   of the change request's event, or is
--                                   null. New here, and the same code 018
--                                   uses for the same refusal. 403 once the
--                                   service maps it; a 500 until then (see the
--                                   header).
--   raise_exception (P0001)         already processed. Unchanged from 006,
--                                   with no SQLSTATE of its own; mapped by
--                                   message to a 400.
--
-- And, unchanged from 006, whatever applying an approved change raises:
-- check_violation (23514) when the new value breaks a constraint on
-- event_requests, such as a start after the end, and the cast errors
-- (22P02, 22007, 22008, 22003) when the requested value cannot be read as a
-- timestamp or an integer. Any of these rolls back the decision too, which is
-- the reason 006 made this a function.

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
  v_request              event_change_requests;
  v_event_request_id     uuid;
  v_assigned_coordinator uuid;
begin
  -- Find the change request's event, and lock that event until this decision
  -- commits. `for update of er` locks only the event row: the join is there
  -- to find it, and the change request needs no lock of its own (see the
  -- header). Once this returns, no handover can change the event's
  -- coordinator before the check below and the writes after it.
  --
  -- event_request_id is a not-null foreign key, so a change request that
  -- exists always has an event, and no row here means no change request.
  select er.id, er.assigned_coordinator_id
    into v_event_request_id, v_assigned_coordinator
    from event_change_requests cr
    join event_requests er on er.id = cr.event_request_id
   where cr.id = p_change_request_id
     for update of er;

  if not found then
    -- Same message and SQLSTATE as 006's own not-found below, so the service
    -- cannot tell which of the two caught it, and does not need to.
    raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
  end if;

  -- AC7: only the event's assigned coordinator may decide its change
  -- requests. After a handover that is the new coordinator, and the previous
  -- one is refused here.
  --
  -- A null p_processed_by is refused explicitly, and `is distinct from` is
  -- used rather than `<>`, both for the reason 018 gives: an unknown
  -- comparison must refuse, not pass. See the header for why the parameter
  -- still defaults to null.
  if p_processed_by is null or v_assigned_coordinator is distinct from p_processed_by then
    raise exception 'only the coordinator assigned to event request % can decide its change requests', v_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- From here to the end, 006's body, unchanged except that the last comment
  -- now names 006, where the explanation it points to lives.
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
    -- the comment above this function in 006.
  end if;

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Tell the API about the redefined function
-- ---------------------------------------------------------------------
-- The signature is the same, so PostgREST would find the function without
-- this. It is here because every migration that defines a function ends this
-- way, and because a reload costs nothing and rules out a stale cache.

notify pgrst, 'reload schema';
