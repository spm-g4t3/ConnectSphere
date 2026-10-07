-- 029_event_request_decisions_functions.sql
-- SCRUM-109 and SCRUM-122, subtasks of SCRUM-19 (Approve or Reject a Submitted
-- Event Request)
--
-- Adds two functions:
--
--   start_event_review   the assigned coordinator starts reviewing a submitted
--                        request: submitted -> under_review, and they become
--                        its reviewing coordinator (AC1).
--   decide_event_request the assigned coordinator approves or rejects a request
--                        under review, recording the outcome, the note, who
--                        decided and when (AC2, AC3, AC5, AC6, AC7, AC9).
--
-- Run this once in the Supabase SQL Editor, after 025. Safe to run again: both
-- are create or replace function, and nothing else is created.
--
-- Numbered 029. 024 through 028 are claimed, and the folder already has seven
-- number collisions from parallel branches (docs/SCRUM-327.md lists them). No
-- existing file is touched.
--
--
-- The problem: no decision can be recorded today, for two separate reasons.
--
-- 1. The status and the decision must be written in one statement, and the
--    one status function cannot write a decision.
--
--    change_event_request_status (022) writes the status and the clarification
--    note, nothing else. 025's event_requests_decided_status_has_decision
--    requires a decision on any row at approved, rejected, confirmed or
--    completed. So moving a request to approved through that function fails
--    with 23514 on any database that has 025, the live one included.
--
--    Nor can the status and the decision be written one after the other. 025's
--    constraints are row-level: Postgres checks each one against the whole row
--    after every statement. Write the status first and the row is approved with
--    no decision, which decided_status_has_decision refuses. Write the decision
--    first and the row carries a decision while still under_review, which
--    decision_has_decided_status refuses. Either order fails on its first
--    statement. One statement is required, not a matter of style.
--
-- 2. Nothing ever sets reviewing_coordinator_id.
--
--    025's event_requests_decided_by_is_reviewer requires decided_by to equal
--    reviewing_coordinator_id. No function writes that column except 018, and
--    018 only moves it on a handover if it is already set; 014, 016 and 017's
--    backfills only read it. So until something sets the reviewer, no decision
--    can be recorded at all. start_event_review is that something, and it is
--    why AC1 exists: starting the review is when a coordinator becomes the
--    reviewer.
--
--
-- Why start_event_review is its own function, not a call to
-- change_event_request_status:
--
-- change_event_request_status cannot set reviewing_coordinator_id. Giving it a
-- parameter would change a signature SCRUM-318 owns and two services already
-- call (requestEventClarification and respondToEventClarification), and
-- create or replace with a new argument list adds a second function beside
-- the first rather than replacing it (019's header). This is the argument 021
-- makes for submit_event_request writing its own history row: a transition
-- that must write more than the status writes the status, its other columns
-- and the history row itself, in the shape change_event_request_status uses.
-- Four functions now write the status history: submit_event_request,
-- change_event_request_status, and these two. Each writes exactly one row per
-- transition, and the two here follow 022's row shape exactly.
--
--
-- Two decisions about decide_event_request:
--
-- (a) It does check event_request_status_allows, although it already requires
--     under_review and only writes approved or rejected, both of which the
--     table allows from under_review. Today the check can never fail. It is
--     there because 022 put the transition table in the database precisely so
--     that no caller could move a request in a way the table does not list. A
--     function that knows the answer and skips the question is a second,
--     private copy of the rule; if the team ever removes under_review ->
--     rejected from the table, this function would go on making the move.
--     Asking costs one call to an immutable function. start_event_review asks
--     too, for the same reason.
--
-- (b) reviewing_coordinator_id is filled in if it is empty, never overwritten,
--     and a mismatch is refused. It would be natural to trust start-review:
--     if it always ran first, the reviewer would already equal the assigned
--     coordinator, because 018 keeps the two together on a handover. But it
--     does not run on every path. requestEventClarification moves a submitted request to
--     under_review through change_event_request_status, which does not set the
--     reviewer, and the Organiser's reply brings it back to under_review the
--     same way. A request can therefore be under review with no reviewer, and
--     trusting start-review would make every such request undecidable (23514
--     from decided_by_is_reviewer). So:
--       - reviewer null: set it to the decider, in the decision's own
--         statement. The person deciding is, at that moment, the person
--         reviewing; recording it is true, not invented.
--       - reviewer equal to the decider: nothing to do.
--       - reviewer someone else: refused with 42501. The caller is the
--         assigned coordinator, but someone else is recorded as reviewing, and
--         only the reviewer may decide (AC1). 018 makes this unreachable
--         through the application; the check is here so the refusal is a
--         readable 403 rather than a constraint error, and so the recorded
--         reviewer is never silently rewritten.
--     A follow-up for the service: requestEventClarification should start
--     the review through start_event_review rather than
--     changeEventRequestStatus, so the reviewer is set on that path too.
--
--
-- Which of 025's constraints each statement satisfies. 025 adds five, not
-- four:
--
--   start_event_review's update (status under_review, reviewer set; no
--   decision fields written, so they stay null):
--     decided_status_has_decision  under_review is not a decided status
--     decision_has_decided_status  decision is null
--     rejection_has_reason         decision is null, so not 'rejected'
--     decided_by_is_reviewer       decided_by is null
--     decision_fields_together     decision, decided_by, decided_at all null
--
--   decide_event_request's update (status, decision, note, decided_by,
--   decided_at and, if it was empty, the reviewer):
--     decided_status_has_decision  status approved/rejected, decision set
--     decision_has_decided_status  decision set, status approved/rejected
--     rejection_has_reason         a rejection's note is checked non-blank
--                                  first, and stored trimmed
--     decided_by_is_reviewer       decided_by and the reviewer are the same
--                                  person, set in the same statement
--     decision_fields_together     decision, decided_by and decided_at all set
--
--   Both also satisfy the constraints from other files that a status change
--   meets: 020's status_in_lifecycle (neither status is planning), 017's
--   assigned_when_submitted (the caller check proves a coordinator is
--   assigned), and 005's submitted_at check (neither is a draft).
--
--
-- What this migration deliberately does not do:
--
--   * No notification to the Organiser (AC11). That is SCRUM-173, unassigned,
--     and the table cannot take it yet: notifications_type_known (014) allows
--     only 'booking_flagged', and there is no event_request_id column.
--
--   * No guard on venue bookings or equipment (AC8). SCRUM-243 and SCRUM-21
--     enforce "only against Approved or Confirmed" at their own write, as
--     SCRUM-19's notes say. A rule about what may be raised against an event
--     belongs where the thing is raised.
--
--   * No role check. The route's coordinatorOnly does that. These functions
--     check something stronger, that the caller is this event's assigned
--     coordinator, under the row lock, which is the check only they can make
--     reliably (018's header gives the argument).
--
--   * No immutability guard. AC9's "cannot be edited afterwards" is enforced by
--     the status machine: approved and rejected cannot return to under_review,
--     and decide_event_request requires under_review, so a decided request
--     cannot be decided again through this function. Nothing here protects the
--     columns from a direct write. Two transitions SCRUM-318 owns do touch a
--     recorded decision, and are recorded here rather than hidden:
--     approved -> rejected leaves decision = 'approved' on a rejected row
--     (the constraints accept it), and rejected -> draft (022) clears all four
--     decision fields. Reconciling those with AC9 is a question for the team,
--     not something this file can settle.
--
--   * No change to change_event_request_status, submit_event_request or
--     reassign_event_request.
--
--   * No index, constraint or trigger. Both functions read one row by primary
--     key, and 025's constraints are the backstop for every rule checked here.
--
--   * No P0001. translateError in eventRequestService.js maps P0001 to a 503
--     meaning "no coordinator available" (016). Every refusal below names its
--     own SQLSTATE so none can fall into that.


-- ---------------------------------------------------------------------
-- 1. start_event_review
-- ---------------------------------------------------------------------
-- Volatile, the default, because it writes.
--
-- SQLSTATEs, one per refusal, mapped by translateError on code:
--
--   no_data_found (P0002)             no such event. 404.
--   insufficient_privilege (42501)    the caller is null, or is not the
--                                     event's assigned coordinator. 403, as in
--                                     018: a coordinator can already see the
--                                     event, so a 403 reveals nothing.
--   object_not_in_prerequisite_state  the event is not submitted, or the
--   (55000)                           transition table does not allow the move.
--                                     The message names the current status.
--                                     409.
--   serialization_failure (40001)     the guarded update matched no row. It
--                                     cannot happen while the lock is held; it
--                                     is a backstop, as in 018 and 022. 409.

create or replace function start_event_review(
  p_event_request_id uuid,
  p_coordinator_id   uuid
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  -- Lock first, then read: nothing can change the row between the checks
  -- below and the update that relies on them. A handover (018) takes the same
  -- lock, so the two take turns.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- AC1: only the assigned coordinator starts the review.
  --
  -- A null caller is refused explicitly, as 018 does. `is distinct from` alone
  -- would compare a null caller with an event that has no coordinator, find
  -- them not distinct, and let the caller through.
  if p_coordinator_id is null
     or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'only the coordinator assigned to event request % can start reviewing it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status <> 'submitted' then
    raise exception 'event request % has status %, and only a submitted request can be put under review',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Always true today; asked so the database's transition table stays the one
  -- authority (see (a) in the header).
  if not event_request_status_allows('submitted', 'under_review') then
    raise exception 'event request % has status submitted, which cannot change to under_review', p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The status and the reviewer in one statement. `and status = 'submitted'`
  -- cannot fail to match while the lock is held; it makes the statement itself
  -- unable to move a row that is not in the status checked, as 018's and 022's
  -- guards do.
  update event_requests
     set status                   = 'under_review',
         reviewing_coordinator_id = p_coordinator_id
   where id = p_event_request_id
     and status = 'submitted'
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while the review was being started', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The same row shape change_event_request_status writes. No reason: starting
  -- a review needs none.
  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'submitted', 'under_review', p_coordinator_id, null);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. decide_event_request
-- ---------------------------------------------------------------------
-- Volatile, because it writes.
--
-- p_decided_at is a parameter rather than now(), for 016's reason for
-- p_submitted_at: the service owns the clock, so its tests can state the exact
-- instant. It matters more here, because the instant decides an outcome: AC6
-- refuses an approval when the event's proposed start has passed, and "has
-- passed" is measured at p_decided_at. With now(), a test of that boundary
-- would pass or fail depending on when it ran. The history row's created_at is
-- left to its default, as 021 does: it records when the row was written, the
-- database's fact, while decided_at is the decision's.
--
-- The note is trimmed, and a blank one becomes null, before anything else
-- uses it. That is not tidiness. The note is also the history row's reason,
-- and 021's event_request_status_history_reason_not_blank refuses a blank
-- one, so an approval with a note of spaces would otherwise fail on the
-- history insert with an unreadable 23514.
--
-- SQLSTATEs:
--
--   null_value_not_allowed (22004)    the decision or the decision time was
--                                     null. Always a caller bug, as in 021:
--                                     translateError leaves it untyped, a 500.
--   no_data_found (P0002)             no such event. 404.
--   insufficient_privilege (42501)    the caller is null, is not the assigned
--                                     coordinator, or is not the recorded
--                                     reviewer. 403.
--   object_not_in_prerequisite_state  the event is not under review (this is
--   (55000)                           how AC3 refuses pending clarification,
--                                     submitted, and every decided status), or
--                                     the transition table refuses the move, or
--                                     (AC6) an approval of an event whose
--                                     proposed start has passed or is missing.
--                                     409; the message says which.
--   invalid_parameter_value (22023)   a rejection with no reason. 400. Chosen
--                                     over check_violation (23514), which
--                                     translateError also maps to 400 but
--                                     prefixes with "A value was rejected by
--                                     the database:", because that prefix is
--                                     for Postgres's own constraint messages.
--                                     This is a readable refusal of a value the
--                                     coordinator supplied, and 22023 passes it
--                                     through unchanged. 025's
--                                     rejection_has_reason remains the backstop.
--   serialization_failure (40001)     the guarded update matched no row; the
--                                     backstop, as above. 409.
--
-- AC6's refusal is 55000 rather than a code of its own. It is the same kind
-- of refusal as a wrong status: the event is not in a state that allows
-- approval, nothing the coordinator typed is wrong, and the remedy is to
-- change the event, or reject it, not to resubmit the form. It maps to the
-- same 409, and its message says what to do. A separate code would need a new
-- translateError branch for no difference in behaviour.

create or replace function decide_event_request(
  p_event_request_id uuid,
  p_decision         event_request_decision,
  p_decision_note    text,
  p_decided_by       uuid,
  p_decided_at       timestamptz
)
returns event_requests
language plpgsql
as $$
declare
  v_request    event_requests;
  v_new_status event_request_status;
  v_note       text := nullif(btrim(p_decision_note), '');
begin
  if p_decision is null or p_decided_at is null then
    raise exception 'decide_event_request needs the decision and the time it was made'
      using errcode = 'null_value_not_allowed';
  end if;

  -- The decision names the status it leads to: approved or rejected.
  v_new_status := p_decision::text::event_request_status;

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- Only the assigned coordinator decides. A null caller is refused
  -- explicitly, for the reason start_event_review gives.
  if p_decided_by is null
     or v_request.assigned_coordinator_id is distinct from p_decided_by then
    raise exception 'only the coordinator assigned to event request % can decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- AC2 and AC3: a decision is made only on a request under review. This is
  -- what refuses a request awaiting clarification, one not yet under review,
  -- and one already decided, each with its current status named.
  if v_request.status <> 'under_review' then
    raise exception 'event request % has status %, and only a request under review can be decided',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- See (a) in the header.
  if not event_request_status_allows(v_request.status, v_new_status) then
    raise exception 'event request % has status %, which cannot change to %',
      p_event_request_id, v_request.status, v_new_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- And only the reviewer. A recorded reviewer who is someone else is refused,
  -- never overwritten; an empty one is filled in below. See (b) in the header.
  --
  -- After the status check, not before it. A decided event keeps the reviewer
  -- who decided it, even after a handover (018), so on an approved event this
  -- check would refuse the new coordinator for the wrong reason. The status is
  -- the true reason a decided event cannot be decided again.
  if v_request.reviewing_coordinator_id is not null
     and v_request.reviewing_coordinator_id <> p_decided_by then
    raise exception 'event request % is under review by another coordinator, who must decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A rejection must say why. Checked here so the coordinator gets this
  -- sentence rather than 025's constraint name.
  if p_decision = 'rejected' and v_note is null then
    raise exception 'a reason is required to reject event request %', p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- AC6: an event whose proposed start has passed cannot be approved. Measured
  -- at p_decided_at, the service's clock (see the comment above the function).
  -- A start exactly at the decision time counts as passed: the event would
  -- already be under way. A missing start is refused too, rather than approved
  -- unchecked: submission requires one, so a missing start means a row made
  -- outside the application, and approving it would approve an event whose
  -- date nobody could confirm. A rejection is allowed whatever the date.
  if p_decision = 'approved'
     and (v_request.proposed_start is null or v_request.proposed_start <= p_decided_at) then
    raise exception 'event request % cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The status and the whole decision in one statement, for the reason in the
  -- header: 025's constraints are checked against the row after the statement,
  -- and any split would leave a row one of them refuses. The reviewer is
  -- filled in here, in the same statement, so decided_by_is_reviewer sees the
  -- two equal.
  update event_requests
     set status                   = v_new_status,
         decision                 = p_decision,
         decision_note            = v_note,
         decided_by               = p_decided_by,
         decided_at               = p_decided_at,
         reviewing_coordinator_id = coalesce(reviewing_coordinator_id, p_decided_by)
   where id = p_event_request_id
     and status = 'under_review'
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while it was being decided', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The same row shape change_event_request_status writes. The note is the
  -- reason: for a rejection it is why the request was rejected, which is
  -- exactly what the status history's reason records.
  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'under_review', v_new_status, p_decided_by, v_note);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Tell the API about the new functions
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, functions included. Without this,
-- rpc('start_event_review') and rpc('decide_event_request') fail with
-- "function not found" until the cache refreshes. 016, 018, 021 and 022 end
-- the same way.

notify pgrst, 'reload schema';
