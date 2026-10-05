-- 022_event_status_transitions.sql
-- SCRUM-318 (Manage the Event Status Lifecycle), closing the gaps found when the
-- story was verified end to end.
--
-- Run this once in the Supabase SQL Editor, after 021. Safe to run again: the
-- functions are create or replace, and each constraint is guarded on its name.
-- 021 is not edited. It may already have been applied, and it stays the record
-- of what it did.
--
--
-- 1. The database now refuses an illegal transition itself
--
-- 021's change_event_request_status checked that the request was still in the
-- status the caller saw, and left "is this move legal?" to the service
-- (canTransition). That kept one copy of the table, but it meant any other
-- caller of the function, the API's rpc endpoint included, could move a
-- request between any two statuses and have it recorded as a normal change.
-- SCRUM-318 says every transition outside the list is rejected, so the function
-- now holds the list too: event_request_status_allows(from, to), the sixteen
-- transitions of the story and nothing else.
--
-- Two copies of a table can disagree, and the answer is a test that compares
-- them for every pair of statuses (eventStatusLifecycleDatabase.test.js), not
-- one copy. Change the table in src/domain/eventRequestStatus.js and here
-- together or that test fails.
--
-- An illegal move is refused with object_not_in_prerequisite_state (55000), as
-- a stale status is, so the service turns both into a 409 whose message names
-- the status the request is in. Nothing is written, so no history row either.
--
--
-- 2. rejected -> draft now works
--
-- It is one of the sixteen, and it could not succeed: 005's
-- event_requests_submitted_at_matches_status refuses a draft that still has a
-- submitted_at, and the function never cleared it. A request reopened as a
-- draft now loses its submitted_at, as a new draft has none, and is submitted
-- again through submit_event_request like any draft.
--
-- SCRUM-19's decision columns (010: decision, decision_note, decided_by,
-- decided_at) are not created by any migration in this folder, but 010's
-- constraints on them exist on a database that has had SCRUM-19. A rejected
-- request carries a decision, and a draft may not, so those four are cleared in
-- the same statement as the status; two statements would each break a
-- constraint. The columns are looked up first, and the dynamic statement is used
-- only when they exist, so this file runs on a database without them.
-- assigned_coordinator_id is left as it is: 017 allows a draft to carry one, and
-- submit_event_request chooses again on resubmission.
--
--
-- 3. The status history holds only the nine statuses
--
-- The enum still carries 'planning' (Postgres cannot drop a value, see 020), and
-- 020 refuses it on event_requests. The history columns used the same enum with
-- no such check, so a row could still say a request had been in 'planning'.
-- They now carry the same nine-status check.
--
--
-- What this migration deliberately does not do:
--
--   * No history row for 020's planning -> approved data move. A history row
--     needs the user who caused the change, and a one-off data migration has
--     none. The application never wrote 'planning', so a database that had any
--     such row got it by hand.
--
--   * No change to submit_event_request, pick_event_coordinator or
--     reassign_event_request.


-- ---------------------------------------------------------------------
-- 1. The allowed transitions
-- ---------------------------------------------------------------------
-- Immutable: the answer depends only on the arguments. Compared as text so the
-- literal list does not depend on 'planning' existing in the enum, and so a
-- status outside the list, 'planning' included, is simply not allowed.
--
-- The sixteen, in the order of the story. draft -> submitted is here for
-- completeness; change_event_request_status refuses it as a target before it
-- gets this far, because submitting is submit_event_request's job.

create or replace function event_request_status_allows(
  p_from event_request_status,
  p_to   event_request_status
)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
      from (values
        ('draft',                 'submitted'),
        ('submitted',             'under_review'),
        ('under_review',          'pending_clarification'),
        ('pending_clarification', 'under_review'),
        ('under_review',          'approved'),
        ('under_review',          'rejected'),
        ('approved',              'rejected'),
        ('rejected',              'draft'),
        ('approved',              'confirmed'),
        ('confirmed',             'approved'),
        ('confirmed',             'completed'),
        ('submitted',             'cancelled'),
        ('under_review',          'cancelled'),
        ('pending_clarification', 'cancelled'),
        ('approved',              'cancelled'),
        ('confirmed',             'cancelled')
      ) as t (from_status, to_status)
     where t.from_status = p_from::text
       and t.to_status   = p_to::text
  );
$$;


-- ---------------------------------------------------------------------
-- 2. change_event_request_status, refusing an illegal move
-- ---------------------------------------------------------------------
-- 021's function with two changes, and its header is still the reasoning for the
-- rest: the legality check after the stale-status check, and the reopen handling
-- of the update. The SQLSTATEs are unchanged; an illegal move reuses 55000.
--
-- The legality check comes after the stale-status check so that the message
-- names the status the request is in under the lock, which is the status that
-- matters, and before any write.

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

  if not event_request_status_allows(v_request.status, p_new_status) then
    raise exception 'event request % has status %, which cannot change to %',
      p_event_request_id, v_request.status, p_new_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- `is distinct from` so that an event with no coordinator, compared with a
  -- caller who named one, is a mismatch and not an unknown that passes.
  if p_expected_coordinator is not null
     and v_request.assigned_coordinator_id is distinct from p_expected_coordinator then
    raise exception 'event request % is no longer assigned to this coordinator', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  if p_new_status = 'draft'
     and exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name   = 'event_requests'
          and column_name  = 'decision'
     ) then
    -- A reopened request: no submission time and no decision, together. See 2
    -- of the header. Dynamic, because the decision columns are not created by
    -- this folder's migrations and a static reference would fail to run where
    -- they do not exist.
    execute
      'update event_requests
          set status       = $1,
              submitted_at = null,
              decision     = null,
              decision_note = null,
              decided_by   = null,
              decided_at   = null
        where id = $2
          and status = $3
       returning *'
      into v_request
      using p_new_status, p_event_request_id, p_expected_status;
  else
    -- The status, and the clarification note that goes with it, in one
    -- statement. The note is the reason for entering pending_clarification and
    -- is cleared on leaving it; every other transition leaves it alone. A
    -- reopened draft has no submission time (005).
    -- `and status = p_expected_status` cannot fail to match while the lock is
    -- held. It makes the statement itself unable to move a row that is not in
    -- the status the caller checked, as 018's guard does.
    update event_requests
       set status             = p_new_status,
           submitted_at       = case
             when p_new_status = 'draft' then null
             else submitted_at
           end,
           clarification_note = case
             when p_new_status = 'pending_clarification' then p_reason
             when p_expected_status = 'pending_clarification' then null
             else clarification_note
           end
     where id = p_event_request_id
       and status = p_expected_status
    returning * into v_request;
  end if;

  -- Both branches leave v_request empty when no row matched.
  if v_request.id is null then
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
-- 3. The history holds only the nine statuses
-- ---------------------------------------------------------------------
-- The same list as 020's event_requests_status_in_lifecycle, and the same
-- reasoning: listing all nine is a statement of the model, and `planning` is
-- left out. Both columns are not null, so the check cannot pass a row through
-- three-valued logic. Guarded on name and table, as 020 and 021 are.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_request_status_history_statuses_in_lifecycle'
      and conrelid = 'public.event_request_status_history'::regclass
  ) then
    alter table event_request_status_history
      add constraint event_request_status_history_statuses_in_lifecycle check (
        previous_status in (
          'draft', 'submitted', 'under_review', 'pending_clarification',
          'approved', 'confirmed', 'completed', 'rejected', 'cancelled'
        )
        and new_status in (
          'draft', 'submitted', 'under_review', 'pending_clarification',
          'approved', 'confirmed', 'completed', 'rejected', 'cancelled'
        )
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 4. Tell the API about the new function
-- ---------------------------------------------------------------------
-- PostgREST caches the schema, functions included. 016, 018, 020 and 021 end
-- the same way.

notify pgrst, 'reload schema';
