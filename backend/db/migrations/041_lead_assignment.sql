-- ---------------------------------------------------------------------------
-- 041_lead_assignment.sql
-- SCRUM-515, SCRUM-516: the Event Coordinator Lead assigns, and reassigns
--
-- Part of SCRUM-486 "Assign and Reassign Event Coordinators from an Unassigned
-- Queue - Event Coordinator Lead". This story's one migration, built across
-- four subtasks:
--   SCRUM-515 (done)  relaxes the assignment constraint, takes assignment out
--                     of submission, and closes two null-caller holes.
--   SCRUM-516 (done)  the Lead's first assignment, assign_event_request, and
--                     reassign_event_request opened to the Lead.
--   SCRUM-517         the refusal to review an unassigned request.
--   SCRUM-518         the notifications.
--
-- DO NOT APPLY THIS to the live database until SCRUM-517 and SCRUM-518 have
-- landed in this file. Without them an unassigned request could not be
-- refused a review with the right message, and nobody would be told one was
-- waiting. The PGlite tests read it from disk, so
-- they run against it whether or not it has been applied.
--
-- Run it once in the Supabase SQL Editor, after 040_venue_holds.sql, and after
-- 039 (the Lead's role, which assign_event_request and reassign_event_request
-- name). Safe to re-run: the constraint is dropped by name and added again,
-- every changed function is `create or replace` with an unchanged signature,
-- and the one new function is `create or replace` too.
--
-- Why. The customer's Week 7 change 5: "Newly submitted event requests should
-- no longer be assigned directly to an Event Coordinator. Instead, they first
-- enter an unassigned queue that can be viewed by the Event Coordinator
-- Lead." SCRUM-327 built the opposite, correctly, against the brief it had:
-- submission chose a coordinator (015's rule) and 017 made the database
-- refuse a submitted request without one. This file undoes both, and nothing
-- else.
--
-- What it serves (docs/test-cases/SCRUM-486.md):
--   AC1   A submitted request has no coordinator. It waits for the Lead.
--   AC11  With no Lead, and with no Event Coordinator at all, submission still
--         succeeds. The old refusal, P0001 "No coordinator is available", is
--         gone, because submission no longer looks for one.
--   TR-01 The constraint allows a submitted request with no coordinator and
--         still refuses one under review or later.
--   TR-02 A request reopened from rejected (022) and submitted again reaches
--         the queue with no coordinator, not its old one.
--   TR-04, TR-05  Two functions that would let a null caller through once a
--         request can have no coordinator are closed.
--   AC3   The Lead assigns a submitted, unassigned request to one Event
--         Coordinator, with an optional note. Only the Lead may; only an Event
--         Coordinator may be chosen.
--   AC4   The coordinator and its history row are written in one statement. A
--         second assignment of the same request is refused, and the refusal
--         names the coordinator who got there first.
--   AC5   Reassignment in Submitted, Under review, Pending clarification,
--         Approved, Safety review, Safety approved or Confirmed; refused
--         otherwise.
--   AC6   The event's holder, or a Lead, may reassign it.
--   AC9   Each assignment's history row names who made it: assigned_by is the
--         Lead, so new rows are told apart from SCRUM-327's automatic ones,
--         whose null assigned_by still reads "automatically on submission".
--
--
-- Order, and why this file is not split the way 016 and 017 were.
--
-- 016 (the submission function) and 017 (the constraint) were two files
-- because the constraint had to wait for old code to stop running: the old
-- service submitted with a plain update that set no coordinator, so a
-- constraint requiring one, applied while that code still ran, would have
-- failed every submission with 23514. The function had to come first, the
-- constraint after.
--
-- Here it is the other way round, and so the two belong in one file, in this
-- order. The new submission function writes a submitted row with no
-- coordinator, which 017's constraint refuses. Applied on its own, before the
-- constraint is relaxed, it would fail every submission with 23514. So the
-- constraint is relaxed first, then the function changes, in one script the
-- SQL Editor runs as one transaction. There is no window between them, and
-- the service needs no change to call it: the function keeps 021's three
-- arguments.
--
--
-- Decisions, and why:
--
--   * The constraint is relaxed for 'submitted' only. Under review and every
--     later status still require a coordinator, because only the assigned
--     coordinator can move a request there (start_event_review, 029). Draft
--     and cancelled were already allowed none.
--
--   * Submission sets assigned_coordinator_id to null, explicitly. Merely not
--     setting it would not do: 022's rejected -> draft keeps the coordinator
--     on the draft (017 allows a draft to carry one), so a resubmission would
--     go straight back to its previous coordinator and never reach the Lead's
--     queue. AC1 says submission assigns nobody; SCRUM-327 AC3, which sent a
--     resubmission back to its previous holder, is superseded with it.
--
--   * Submission clears reviewing_coordinator_id too. 022 leaves that behind
--     as well. A stale reviewer on an unassigned request names someone who is
--     no longer responsible, and if the request ever reached under_review by
--     another path, 029 would refuse the new coordinator's decision as "under
--     review by another coordinator". Clearing it closes the question
--     docs/SCRUM-19.md left open (its open question 5). A draft carries no
--     decision (022 clears those fields), so 025's decided_by_is_reviewer is
--     satisfied by the null.
--
--   * One status-history row, draft -> submitted, as 021 writes. No
--     assignment-history row: nothing is assigned, so there is nothing to
--     record. The Lead's assignment writes the first one (SCRUM-516).
--
--   * The first assignment is a function of its own, assign_event_request,
--     beside reassign_event_request, not a branch inside it. 018's guarded
--     update ends `and assigned_coordinator_id = p_assigned_by`. A Lead who
--     does not hold the event matches no row, and on a first assignment both
--     sides would be null, where `null = null` matches nothing either. One way
--     out was to rewrite 018's guard to compare with the outgoing coordinator
--     using `is not distinct from`, and let one function do both jobs. That
--     was weighed and not taken. The two jobs differ in everything but the
--     history row: who may do it (only a Lead assigns; the holder or a Lead
--     reassigns), what must be true first (no coordinator and Submitted,
--     against a coordinator and one of seven statuses), and what a refusal
--     must say (AC4's "already assigned to X", against 018's "changed
--     hands"). One function would have to branch on whether a holder exists,
--     and a reassignment aimed at an event whose holder had just gone would
--     silently become a first assignment instead of being refused. Two
--     functions keep each set of rules readable on its own, at the cost of
--     repeating one role check, which is a single `perform ... for share`.
--
--   * The reassignment's guarded update compares with the outgoing coordinator
--     the function read under its lock (v_outgoing), not with the caller. With
--     a Lead as caller the caller is not the holder, and the guard's job was
--     never "the caller holds it" but "nobody moved it in between".
--     reassign_event_request refuses a request with no coordinator before the
--     update, so v_outgoing is never null there and `=` is enough.
--
--   * The Lead cannot be assigned events (the team's 11 October decision,
--     which answers SCRUM-485's open question 3). The incoming person must
--     hold event_coordinator. One role per account (SCRUM-485 AC2: profiles.id
--     is the primary key, with one role column) means that check alone
--     excludes every Lead; no second check for "and not a Lead" is needed.
--
--   * The reassignment status list is compared as text, so it can name
--     safety_review and safety_approved, which AC5 lists and the enum does not
--     yet have: SCRUM-488 adds them. 037's assert_equipment_editable is the
--     precedent, comparing status::text for exactly that reason. Compared as
--     the enum, the list would fail to run while those values are missing.
--
--   * Error codes follow 018 and 029: standard SQLSTATEs (22004, P0002, 55000,
--     42501, 22023, 23514, 40001), which translateError in
--     eventRequestService.js maps once. 040,
--     the venue holds, raises errcode 'PT409' with a hint instead, a PostgREST
--     code that sets the HTTP status itself. That was considered, not
--     overlooked: these functions sit beside 018's and 029's, the Lead's
--     assign function (SCRUM-516) is reassign_event_request's twin, and the
--     service should go on translating one convention rather than two.
--
--   * Two null-caller guards, added because the relaxation needs them.
--     assert_equipment_editable (037) and close_event_clarification (030)
--     check `assigned_coordinator_id is distinct from <caller>`. When both are
--     null, `is distinct from` is false, so a null caller would be let
--     through on a request with no coordinator. That was unreachable while 017
--     guaranteed a coordinator past draft; it is reachable now. The fix is the
--     one 018 and 029 already use: refuse a null caller explicitly. Nothing
--     else in either function changes. The other functions that read the
--     column were checked in the audit before this story: each already has
--     the guard (029, 030's booking request, 031, 033, 040), or skips a null
--     coordinator (034 to 036, 040's hold notice).
--
--
-- What this migration deliberately does not do:
--
--   * Drop pick_event_coordinator (015). After this file nothing live calls
--     it: submission was its only caller, and the backfills in 016 and 017 that
--     also called it have run. It stays, unused, because
--     backend/scripts/check-coordinator-assignment.js still calls it (its
--     section 1 tests the selection rule) and dropping it buys nothing. 015's
--     header describes a rule the application no longer applies; it is
--     applied and append-only, so this note is the correction.
--
--   * Add the Lead's queue, refuse the review of an unassigned request, or
--     write any notification. Those are SCRUM-517, 518 and 519; 517 and 518
--     in this file.
--
--   * Change anything about who acts on an event after a reassignment (AC7).
--     Open clarifications, change requests and flagged bookings reference the
--     event, not the coordinator, and every function that acts on them checks
--     the event's assigned_coordinator_id when it runs. So the new holder can
--     act at once and the previous one cannot, with no code here.
--
--   * Change the assignment history. Old rows keep assigned_by null, which
--     014 defines as "the system did it"; they are a true record of what
--     SCRUM-327 did.


-- ---------------------------------------------------------------------
-- 1. A submitted request may have no coordinator
-- ---------------------------------------------------------------------
-- 017's constraint, with 'submitted' added to the statuses that may have
-- none. Postgres checks every existing row when a CHECK constraint is added;
-- every row that satisfied 017's version satisfies this one, so it cannot
-- fail on existing data. First, so that the function below never runs
-- against 017's version (see "Order" above).

alter table event_requests
  drop constraint if exists event_requests_assigned_when_submitted;

alter table event_requests
  add constraint event_requests_assigned_when_submitted check (
    status in ('draft', 'submitted', 'cancelled')
    or assigned_coordinator_id is not null
  );


-- ---------------------------------------------------------------------
-- 2. Submission, without assignment
-- ---------------------------------------------------------------------
-- 021's submit_event_request, the one in force, with the assignment taken out
-- and nothing else changed: the same arguments, the same row lock, the same
-- draft check and SQLSTATEs, the same status-history row. Removed: the call
-- to pick_event_coordinator, the P0001 refusal when it found nobody, and the
-- assignment-history row. Added: the coordinator and the reviewer set to null.

create or replace function submit_event_request(
  p_event_request_id uuid,
  p_submitted_at     timestamptz,
  p_changed_by       uuid
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_submitted_at is null then
    raise exception 'submit_event_request needs a submission time'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_changed_by is null then
    raise exception 'submit_event_request needs the user submitting the request'
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

  if v_request.status <> 'draft' then
    raise exception 'event request % has status %, and only a draft can be submitted',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- status and submitted_at in one statement, as before (005's constraint is
  -- checked against the whole row). The coordinator and the reviewer are set
  -- to null rather than left alone: a draft reopened from rejected (022) still
  -- carries both, and leaving them would hand the request back to its old
  -- coordinator, past the Lead's queue (TR-02).
  update event_requests
     set status                   = 'submitted',
         submitted_at             = p_submitted_at,
         assigned_coordinator_id  = null,
         reviewing_coordinator_id = null
   where id = p_event_request_id
  returning * into v_request;

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'draft', 'submitted', p_changed_by, null);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. The equipment guard refuses a null caller (TR-04)
-- ---------------------------------------------------------------------
-- 037's assert_equipment_editable, with the null-caller check 018 and 029
-- use. add_equipment_line, amend_equipment_line and remove_equipment_line all
-- go through it, so this one guard covers all three. Everything else is 037's.

create or replace function assert_equipment_editable(
  p_event_request_id uuid,
  p_coordinator_id   uuid
)
returns void
language plpgsql
as $$
declare
  v_assigned uuid;
  v_status   text;
begin
  select assigned_coordinator_id, status::text
    into v_assigned, v_status
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  -- A null caller is refused explicitly. `is distinct from` alone would find
  -- a null caller and an event with no coordinator not distinct, and let the
  -- caller through, as 018's header explains.
  if p_coordinator_id is null or v_assigned is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned coordinator can change its equipment'
      using errcode = '42501';
  end if;

  if v_status = 'approved' then
    return;
  end if;

  if v_status in ('confirmed', 'safety_review', 'safety_approved') then
    raise exception
      'Equipment on this event can only be changed as a significant change'
      using errcode = '55000';
  end if;

  raise exception
    'Equipment can only be changed while the event is Approved. This event is %.',
    case v_status
      when 'draft'                 then 'a Draft'
      when 'submitted'             then 'Submitted'
      when 'under_review'          then 'Under review'
      when 'pending_clarification' then 'Pending clarification'
      when 'rejected'              then 'Rejected'
      when 'cancelled'             then 'Cancelled'
      when 'completed'             then 'Completed'
      else v_status
    end
    using errcode = '55000';
end;
$$;


-- ---------------------------------------------------------------------
-- 4. Closing a clarification refuses a null caller (TR-05)
-- ---------------------------------------------------------------------
-- 030's close_event_clarification, with the same null-caller check, made
-- before the status check so a null caller is refused for being null, not
-- for the status. Everything else is 030's.

create or replace function close_event_clarification(
  p_event_request_id     uuid,
  p_coordinator_id       uuid,
  p_expected_coordinator uuid,
  p_message              text
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_message is null or btrim(p_message) = '' then
    raise exception 'clarification closure note is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_message)) > 2000 then
    raise exception 'clarification closure note must be 2000 characters or fewer'
      using errcode = '22023';
  end if;

  select * into v_request
    from event_requests
   where id = p_event_request_id
   for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_coordinator_id is null
     or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the assigned coordinator can close this clarification request'
      using errcode = '42501';
  end if;
  if v_request.status <> 'pending_clarification' then
    raise exception 'event request has status %, not pending_clarification', v_request.status
      using errcode = '55000';
  end if;

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'pending_clarification'::event_request_status,
      'under_review'::event_request_status,
      p_coordinator_id,
      btrim(p_message),
      p_expected_coordinator
    );

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by)
  values (p_event_request_id, 'closure', btrim(p_message), p_coordinator_id);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_closed',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_message)
    )
  );

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. The Lead's first assignment (SCRUM-516)
-- ---------------------------------------------------------------------
-- SQLSTATEs, as 018 and 029, mapped by translateError:
--   no_data_found (P0002)             no such event. 404.
--   insufficient_privilege (42501)    the caller is null, or does not hold
--                                     event_coordinator_lead. 403.
--   object_not_in_prerequisite_state  the request already has a coordinator
--   (55000)                           (the message names them: AC4), or it is
--                                     not Submitted. 409.
--   invalid_parameter_value (22023)   the chosen person does not hold
--                                     event_coordinator. 400.
--   serialization_failure (40001)     the guarded update matched no row; it
--                                     cannot while the lock is held, so it is a
--                                     backstop, as in 018. 409.
--
-- Checks run in this order: who is asking (the caller), then whether there is
-- anything to assign (a coordinator already, then the status), then whom it
-- goes to. Caller first, as in 018 and 029: whether a request can be assigned
-- is a question only a Lead has reason to ask.

create or replace function assign_event_request(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_assigned_by      uuid,
  p_note             text
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_holder  text;
begin
  -- Lock first, then read: a second assignment of the same request waits here
  -- for the first to commit, then sees its coordinator (AC4).
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- Only a Lead. Checked under for share, as 018 checks the incoming
  -- coordinator's role: a role revoked at the same moment either waits for
  -- this assignment or refuses it. A null caller is refused explicitly.
  if p_assigned_by is null then
    raise exception 'only the Event Coordinator Lead can assign event request %', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
     from profiles p
    where p.id = p_assigned_by
      and p.role = 'event_coordinator_lead'
      for share;

  if not found then
    raise exception 'only the Event Coordinator Lead can assign event request %', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- AC4: if someone got there first, say who. The name is read from profiles,
  -- with the id as a fallback for a coordinator with no name on record, so the
  -- Lead is never told "already assigned" without being told to whom.
  if v_request.assigned_coordinator_id is not null then
    select coalesce(nullif(btrim(p.full_name), ''), p.id::text)
      into v_holder
      from profiles p
     where p.id = v_request.assigned_coordinator_id;

    raise exception 'event request % is already assigned to %',
      p_event_request_id, coalesce(v_holder, v_request.assigned_coordinator_id::text)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_request.status <> 'submitted' then
    raise exception 'event request % has status %, and only a submitted request can be assigned',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Only an Event Coordinator, which with one role per account excludes every
  -- Lead (see the header). Under for share, as 018.
  perform 1
     from profiles p
    where p.id = p_coordinator_id
      and p.role = 'event_coordinator'
      for share;

  if not found then
    raise exception 'user % is not an Event Coordinator, so cannot be assigned event request %',
      p_coordinator_id, p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- The coordinator and the history row in one statement (AC4): the insert
  -- reads the update's returned row, so a row is written only if the update
  -- matched, and neither stands without the other. The guard repeats the
  -- checks above at the statement itself, as 018's and 022's do.
  -- assigned_by names the Lead, so this row reads as a person's, not as
  -- SCRUM-327's automatic assignment (AC9). A blank note is stored as null.
  with assigned as (
    update event_requests
       set assigned_coordinator_id = p_coordinator_id
     where id = p_event_request_id
       and status = 'submitted'
       and assigned_coordinator_id is null
    returning *
  ), recorded as (
    insert into event_request_assignment_history
      (event_request_id, previous_coordinator_id, new_coordinator_id,
       assigned_by, handover_note)
    select a.id, null, a.assigned_coordinator_id,
           p_assigned_by, nullif(btrim(p_note), '')
      from assigned a
    returning 1
  )
  select * into v_request from assigned;

  if not found then
    raise exception 'event request % changed while it was being assigned', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Reassignment, opened to the Lead (SCRUM-516)
-- ---------------------------------------------------------------------
-- 018's reassign_event_request, widened in three places and nothing else:
--
--   * Who may call it: the event's current holder, as 018 and SCRUM-327 AC6
--     allowed, or anyone holding event_coordinator_lead (AC6 as amended on
--     11 October). The role is checked under for share, only when the caller
--     is not the holder.
--   * A request with no coordinator is refused with a message saying it must
--     be assigned, not reassigned (AC5-05), where 018 would have raised a
--     misleading 40001 "changed hands". It comes after the caller check, so
--     only someone entitled to reassign learns why.
--   * The guarded update compares with the outgoing coordinator read under
--     the lock, not with the caller (see the header).
--   * The status list is compared as text and names SCRUM-488's two safety
--     statuses (see the header, and 037).
--
-- Unchanged from 018: the row lock, the null-caller refusal, the incoming
-- coordinator's role check under for share, the refusal to hand an event to
-- its current holder, the reviewer following an undecided handover and
-- staying on a decided one, the history row, and every SQLSTATE.

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
  v_is_lead  boolean := false;
begin
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

  -- The holder, or a Lead. A null caller is refused explicitly, as in 018.
  -- The Lead's role is looked up only when the caller is not the holder, so
  -- the holder's handover reads exactly as it did in 018.
  if p_assigned_by is not null and v_outgoing is distinct from p_assigned_by then
    perform 1
       from profiles p
      where p.id = p_assigned_by
        and p.role = 'event_coordinator_lead'
        for share;
    v_is_lead := found;
  end if;

  if p_assigned_by is null or (v_outgoing is distinct from p_assigned_by and not v_is_lead) then
    raise exception 'only the coordinator assigned to event request %, or the Event Coordinator Lead, can hand it over',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A request nobody holds is assigned, not reassigned.
  if v_outgoing is null then
    raise exception 'event request % has no coordinator yet, so it must be assigned, not reassigned',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- AC5's seven, compared as text so safety_review and safety_approved can be
  -- named before SCRUM-488 adds them to the enum (037 does the same).
  if v_request.status::text not in ('submitted', 'under_review', 'pending_clarification',
                                    'approved', 'safety_review', 'safety_approved',
                                    'confirmed') then
    raise exception 'event request % has status %, and cannot be handed over in that status',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

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

  if p_new_coordinator_id = v_outgoing then
    raise exception 'event request % is already assigned to that coordinator', p_event_request_id
      using errcode = 'check_violation';
  end if;

  -- 018's update, guarded on the outgoing coordinator read under the lock
  -- rather than on the caller: a Lead is not the holder, and the guard's job
  -- is "nobody moved it in between". The reviewer rule is 018's.
  update event_requests
     set assigned_coordinator_id  = p_new_coordinator_id,
         reviewing_coordinator_id = case
           when decision is null and reviewing_coordinator_id is not null
             then p_new_coordinator_id
           else reviewing_coordinator_id
         end
   where id = p_event_request_id
     and assigned_coordinator_id = v_outgoing
  returning * into v_request;

  if not found then
    raise exception 'event request % changed hands while this handover was being made', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

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
-- 7. Tell the API about the changed functions
-- ---------------------------------------------------------------------
-- PostgREST caches function definitions. 016, 018, 021, 029 and 030 end the
-- same way.

notify pgrst, 'reload schema';
