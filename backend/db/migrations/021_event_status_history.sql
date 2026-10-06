-- 021_event_status_history.sql
-- SCRUM-321, a subtask of SCRUM-318 (Manage the Event Status Lifecycle)
--
-- Records every status change an event request goes through. Adds the table
-- event_request_status_history, and change_event_request_status(): the one
-- function that moves a request from one status to the next, which writes the
-- new status and the history row in a single transaction. It also gives
-- submit_event_request (016) the history row, so that every transition leaves
-- exactly one.
--
-- Run this once in the Supabase SQL Editor, after 020_event_status_lifecycle.sql
-- AND together with the service change that calls the functions below. Safe to
-- run again: the table, constraints and index are guarded, create or replace
-- redefines the functions in place, and the old submit_event_request is
-- dropped only if it is still there.
--
-- Numbered 021, the next unused number. No existing file is touched, including
-- 016, whose function this file replaces. 016 is applied and append-only, so
-- its text is left as written and this file holds the current definition.
--
--
-- Why a Postgres function:
--
-- A status change writes to two tables, and both writes must happen or
-- neither. A request whose status moved with no history row would hide that it
-- ever moved, and a history row with no change to the request would record a
-- transition that never happened. supabase-js talks to PostgREST, where every
-- call is its own HTTP request and its own transaction, so the API cannot make
-- the two writes together. A function body runs inside one transaction, so an
-- error anywhere rolls back everything before it. This is the argument 004
-- makes for create_venue, 006 for process_change_request and 016 and 018 for
-- submit_event_request and reassign_event_request, and this function has the
-- same shape as theirs: lock the row, check each guard, write both rows,
-- return the updated row.
--
--
-- Where the rule that a transition is legal lives:
--
-- In src/domain/eventRequestStatus.js, as ALLOWED_TRANSITIONS and canTransition,
-- and only there. The service asks canTransition before it calls the function
-- and refuses an illegal move without a round trip. The function does not hold
-- a second copy of the table. 016 gives the reason for the same split: a copy
-- in SQL is the same rule in two places, able to disagree.
--
-- What the function does check is the thing only the database can check
-- reliably: that the row is still in the status the caller last saw. The
-- service checked canTransition(expected, new) against that status, so a
-- request that is still in it can legally make the move. If the status has
-- changed since, the function refuses and nothing is written. This is the
-- guarded update SCRUM-31 introduced, with the guard taken under the row lock
-- instead of in a separate request.
--
--
-- Assignment history and status history are different records:
--
-- event_request_assignment_history (014) records who is responsible for an
-- event. event_request_status_history records what stage the event is at. A
-- submission writes one row to each, because it does both, and a handover
-- writes only to the first, because the stage does not change. They are not
-- merged, and the one never stands in for the other.
--
--
-- The clarification note:
--
-- event_requests.clarification_note (010) is the reason given for the current
-- pending_clarification stage. The function therefore sets it from p_reason
-- when a request enters pending_clarification, and clears it when the request
-- leaves that status. Both happen in the same statement as the status, so the
-- note and the status cannot disagree. Before this file, two services wrote
-- the note and the status together in a single PostgREST update; this keeps
-- that guarantee now that the status is written here.
--
--
-- What this migration deliberately does not do:
--
--   * No transition table in SQL; see above.
--
--   * No draft -> submitted in change_event_request_status. Submitting also
--     assigns a coordinator and sets submitted_at, and that is
--     submit_event_request's job (016). The function refuses submitted as a
--     target, so there is exactly one way to submit a request and 017's
--     constraint never has to stop a second.
--
--   * No role or ownership check on the caller. Who may make which transition
--     is decided by the route and the service, as everywhere in this schema
--     (001 section 5). The one exception is p_expected_coordinator, which lets
--     a caller who is acting as the assigned coordinator have the function
--     refuse the change if the event has been handed to someone else since.
--
--   * No backfill. Requests that were already past draft before this file have
--     no history. Inventing rows for them would put a user and a time on
--     changes nobody recorded. A request's history starts at its first
--     transition after this file is applied.
--
--   * No trigger. A trigger on event_requests.status would also fire for the
--     check scripts' direct inserts and updates, and would hide from someone
--     reading the service where a history row comes from. 016 makes the same
--     choice for assignment.
--
--   * No endpoint to read the history. That is SCRUM-322.
--
--   * No change to coordinator selection. pick_event_coordinator (015) is
--     called exactly as 016 called it.
--
--
-- Deploying:
--
-- submit_event_request gains a third argument, the person making the
-- submission, because a history row records who caused the change. A function
-- with a different argument list is a different function in Postgres, so the
-- old two-argument one is dropped here. Leaving it would keep a second way to
-- submit that writes no history. The cost is the usual one for this schema's
-- shared Supabase project: code that still calls the two-argument function
-- fails until it is updated, so apply this file when the service change is
-- merged, not before.


-- ---------------------------------------------------------------------
-- 1. The status history table
-- ---------------------------------------------------------------------
-- Named for the table it belongs to, then what is recorded, then _history, as
-- 003 and 014 do. The _history suffix tells a reader the rows are only ever
-- inserted, never edited.
--
-- One row per transition, so a request's history reads as a chain:
-- draft -> submitted, submitted -> under_review, and so on.

create table if not exists event_request_status_history (
  id                uuid primary key default gen_random_uuid(),

  -- on delete restrict, for the reason 014 gives for the assignment history:
  -- this is a record of what happened to an event, and it has to outlive a
  -- careless delete of the event. Whoever deletes an event, a test event for
  -- instance, has to delete its history first, on purpose.
  event_request_id  uuid not null
    references event_requests (id) on delete restrict,

  -- The status the request was in, and the one it moved to. Both are always
  -- set: the first row for a request is draft -> submitted, and creating a
  -- draft is not a transition.
  previous_status   event_request_status not null,
  new_status        event_request_status not null,

  -- Who caused the change: the Organiser who submitted, the coordinator who
  -- decided, and so on. Never null. Unlike the assignment history, where a
  -- null assigned_by means the system chose, no status change is made by the
  -- system.
  changed_by        uuid not null
    references auth.users (id) on delete restrict,

  -- Why, where a reason was given. Optional: most transitions have none. A
  -- coordinator's clarification question is the reason for that transition.
  reason            text,

  -- When the change took effect. created_at rather than 003's changed_at, as
  -- in 014's table, because a history row is never updated, so the moment it
  -- was written is the moment of the change. It is the database's fact, from
  -- the column default, not a value the caller supplies.
  created_at        timestamptz not null default now()
);

-- A transition changes the status, and a reason is either something or
-- absent. Both are rules about this row alone, so they are CHECKs, and both are
-- guarded in their own blocks for the reason 014 gives: on a re-run, create
-- table if not exists skips the whole statement, constraints included.
--
-- previous_status <> new_status: a row that says nothing changed describes
-- nothing that happened. Both columns are not null, so `<>` cannot evaluate
-- to null.
--
-- The reason: the service stores a blank reason as null. This refuses the
-- other way of storing nothing, an empty string, as 010 does for a rejection
-- note and 001 does for event_name.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_request_status_history_status_changes'
      and conrelid = 'public.event_request_status_history'::regclass
  ) then
    alter table event_request_status_history
      add constraint event_request_status_history_status_changes check (
        previous_status <> new_status
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_request_status_history_reason_not_blank'
      and conrelid = 'public.event_request_status_history'::regclass
  ) then
    alter table event_request_status_history
      add constraint event_request_status_history_reason_not_blank check (
        reason is null or length(trim(reason)) > 0
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Index
-- ---------------------------------------------------------------------
-- An event's status history is read as a whole, oldest first (SCRUM-318 AC6),
-- wherever the Organiser or the assigned coordinator views it. The event id
-- comes first so a lookup reads only that event's rows, then created_at
-- ascending so they are already in display order. 014's index is the same
-- shape, descending.

create index if not exists idx_event_request_status_history_event
  on event_request_status_history (event_request_id, created_at);


-- ---------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001, 003, 006 and 014: RLS enabled with no policies, so a
-- stray publishable key reads nothing. The API decides who may see an event's
-- history.

alter table event_request_status_history enable row level security;


-- ---------------------------------------------------------------------
-- 4. change_event_request_status
-- ---------------------------------------------------------------------
-- Volatile, the default, because it writes.
--
-- p_expected_status is the status the caller last saw. The function changes
-- the request only if it is still in that status.
--
-- p_expected_coordinator is optional. Pass the caller's id when the caller is
-- acting as the event's assigned coordinator, and the function refuses the
-- change if the event has been handed to someone else since the caller read
-- it. Null skips the check, as for an Organiser's change.
--
-- SQLSTATEs, one per refusal so the service maps by error.code rather than by
-- matching message text:
--
--   no_data_found (P0002)             no such request. 404, as in 006 and 016.
--   object_not_in_prerequisite_state  the request is no longer in the status
--   (55000)                           the caller expected. The message names the
--                                     status it is in now. 409, as in 016.
--   serialization_failure (40001)     the event was handed to another
--                                     coordinator after the caller read it, or
--                                     the guarded update matched no row. The
--                                     second cannot happen while this function
--                                     holds the lock; it is a backstop, as in
--                                     018. 409.
--   invalid_parameter_value (22023)   the target is submitted, which belongs
--                                     to submit_event_request, or the target is
--                                     the status the caller expected. 400.
--   null_value_not_allowed (22004)    a status or the user was null. Always a
--                                     caller bug: a history row with no user
--                                     records a change nobody made.
--
-- Not P0001. translateError in eventRequestService.js maps P0001 to a 503, "no
-- coordinator available" (016), so no refusal here may leave it to default.
--
-- A raised error ends the function and rolls back everything it did, so a
-- refused or failed change writes no status and no history row.

create or replace function change_event_request_status(
  p_event_request_id      uuid,
  p_expected_status       event_request_status,
  p_new_status            event_request_status,
  p_changed_by            uuid,
  p_reason                text default null,
  p_expected_coordinator  uuid default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_expected_status is null or p_new_status is null or p_changed_by is null then
    raise exception 'change_event_request_status needs the expected status, the new status and the user'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_new_status = 'submitted' then
    raise exception 'a request is submitted with submit_event_request, not change_event_request_status'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_new_status = p_expected_status then
    raise exception 'event request status cannot change from % to itself', p_expected_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lock first, then read: the row cannot change between the checks below and
  -- the update that relies on them.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> p_expected_status then
    raise exception 'event request % has status %, not %',
      p_event_request_id, v_request.status, p_expected_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- `is distinct from` so that an event with no coordinator, compared with a
  -- caller who named one, is a mismatch and not an unknown that passes.
  if p_expected_coordinator is not null
     and v_request.assigned_coordinator_id is distinct from p_expected_coordinator then
    raise exception 'event request % is no longer assigned to this coordinator', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The status, and the clarification note that goes with it, in one
  -- statement. The note is the reason for entering pending_clarification and
  -- is cleared on leaving it; every other transition leaves it alone.
  -- `and status = p_expected_status` cannot fail to match while the lock is
  -- held. It makes the statement itself unable to move a row that is not in
  -- the status the caller checked, as 018's guard does.
  update event_requests
     set status             = p_new_status,
         clarification_note = case
           when p_new_status = 'pending_clarification' then p_reason
           when p_expected_status = 'pending_clarification' then null
           else clarification_note
         end
   where id = p_event_request_id
     and status = p_expected_status
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while it was being updated', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, p_expected_status, p_new_status, p_changed_by, p_reason);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. submit_event_request, now recording the status change
-- ---------------------------------------------------------------------
-- 016's function, with two additions and nothing else changed: it takes the
-- user making the submission, and it inserts the draft -> submitted row into
-- event_request_status_history. Everything 016 explains still holds, and its
-- header and comments are the reasoning for the rest: the row lock, the draft
-- check, pick_event_coordinator as the only selection rule, one UPDATE
-- setting status, submitted_at and the coordinator together, the assignment
-- history row, and the SQLSTATE of each refusal.
--
-- Why this function writes the status history itself instead of calling
-- change_event_request_status: submitting sets the coordinator and
-- submitted_at in the same statement as the status, because 005's and 017's
-- constraints are checked against the whole row, and change_event_request_status
-- deliberately refuses submitted as a target. Both functions are the only two
-- writers of the status history, and a request cannot reach submitted any
-- other way.
--
-- The status history row and the assignment history row are separate and both
-- written once. The first records the stage, the second the person
-- responsible. A refused submission, no coordinator for instance, raises
-- before either is written, and a raised error rolls back the lot.
--
-- p_changed_by is the Organiser making the submission. It is required for the
-- same reason change_event_request_status requires it.

drop function if exists submit_event_request(uuid, timestamptz);

create or replace function submit_event_request(
  p_event_request_id uuid,
  p_submitted_at     timestamptz,
  p_changed_by       uuid
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

  v_coordinator := pick_event_coordinator(p_event_request_id);

  if v_coordinator is null then
    raise exception 'No coordinator is available; please try again later';
  end if;

  update event_requests
     set status                  = 'submitted',
         submitted_at            = p_submitted_at,
         assigned_coordinator_id = v_coordinator
   where id = p_event_request_id
  returning * into v_request;

  insert into event_request_assignment_history
    (event_request_id, previous_coordinator_id, new_coordinator_id,
     assigned_by, handover_note)
  values
    (p_event_request_id, null, v_coordinator, null, null);

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'draft', 'submitted', p_changed_by, null);

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Tell the API about the new functions
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, including which functions exist. Without this,
-- rpc('change_event_request_status') and the new rpc('submit_event_request')
-- fail with "function not found" until the cache refreshes. 016 and 018 end
-- the same way.

notify pgrst, 'reload schema';
