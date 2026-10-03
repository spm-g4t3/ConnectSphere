-- 014_coordinator_assignment.sql
-- SCRUM-328, a subtask of SCRUM-327 (Assign and Reassign an Event Coordinator)
--
-- Gives every event request somewhere to record which Event Coordinator is
-- responsible for it, and keeps a permanent record of every time that
-- responsibility was given or handed over: who had it before, who has it now,
-- who made the change, when, and the handover note. Then assigns a coordinator
-- to every existing request that should already have one, so that the
-- constraint requiring one (015, below) can be applied without a single
-- existing row violating it.
--
-- Run this once in the Supabase SQL Editor, AFTER 010_event_request_decisions.sql
-- from SCRUM-19. The backfill in section 5 reads reviewing_coordinator_id, which
-- that migration creates; it is already applied to the live database, but on a
-- database rebuilt from dev alone it does not exist yet, and section 5 stops
-- with an error naming the missing migration.
-- Safe to run again -- see section 5 for why the backfill in particular is.
--
-- Numbered 014 by agreement with the team, and appended rather than slotted in.
-- 010 is used by three different branches and SCRUM-17 holds 011-013, so 014
-- is the first number nobody has claimed. 001's header states the rule --
-- additions go in a new numbered migration rather than an edit -- and two
-- files already collide at 005. No existing file is touched here.
--
--
-- Why assigned_coordinator_id is a new column, not reviewing_coordinator_id:
--
-- The two columns record different facts, and the database already depends on
-- one of them never changing.
--
-- reviewing_coordinator_id (010) records who reviewed the request, and
-- 010's constraint event_requests_decided_by_is_reviewer requires decided_by to
-- equal it. Once a decision exists, that column is part of the permanent record
-- of who decided.
--
-- Assignment is a different fact. It exists before anyone starts a review
-- (a request is assigned at the moment it is submitted, while
-- reviewing_coordinator_id stays null until someone moves it to under_review)
-- and it can change hands at any point, including long after the decision, when
-- the event is in planning. If one column held both facts, reassigning an
-- approved event would either rewrite who decided it, or be refused by 010's
-- constraint. The first falsifies history and the second makes handover of a
-- decided event impossible. Neither is acceptable.
--
-- The two move together in exactly one case, and that is the service's job,
-- not this file's: when an undecided request is reassigned while someone is
-- already reviewing it, reviewing_coordinator_id follows the new coordinator,
-- so the person now responsible is the person allowed to decide. After a
-- decision it is left alone.
--
--
-- Why this migration adds no constraint requiring an assigned coordinator:
--
-- The story needs one: every request at 'submitted' or later, other than
-- 'cancelled', must have an assigned coordinator. It is deliberately not here.
-- It arrives in 015, together with SCRUM-330 (assign on submission).
--
-- A CHECK constraint cannot be deferred, so it applies to every write the
-- moment it exists. Today submitEventRequest (src/services/eventRequestService.js)
-- moves a request to 'submitted' with a plain PostgREST update, one HTTP request
-- with no transaction around it, and that update sets no coordinator. If the
-- constraint were applied now, every Organiser submission would fail with
-- 23514, which translateError turns into a 400 telling the Organiser their
-- input was rejected. That would happen on the one shared Supabase project the
-- whole team develops and demos against. It would also break the hand-run check
-- scripts that create submitted rows: check-event-change-request-service.js,
-- check-event-request-routes.js and check-venue-routes.js insert rows directly
-- at 'submitted', and check-event-request-service.js submits through
-- submitEventRequest itself.
--
-- The constraint can only be applied safely once the submit path assigns a
-- coordinator in the same transaction as the status change, which is SCRUM-330.
-- The backfill in section 5 handles every row that exists when this file runs.
-- Rows that do not exist yet are a different matter. Until SCRUM-330 ships,
-- every Organiser submission still goes through today's submitEventRequest and
-- creates a submitted row with no coordinator. So 015 must run this same
-- backfill again, immediately before it adds the constraint, in the same file.
-- Postgres checks every existing row when a CHECK constraint is added, so if
-- 015 forgets to, it fails loudly and names a violating row rather than
-- passing silently.
--
--
-- What this migration deliberately does not do:
--
--   * No constraint requiring an assigned coordinator. See above: that is 015.
--
--   * No NOT NULL on assigned_coordinator_id, for the same reason and one
--     more. A draft legitimately has no coordinator, because nobody at
--     ConnectSphere has seen it yet. Whether a coordinator is required depends
--     on the status, not on the row as a whole, which is the reasoning 005
--     gives for submitted_at and 010 gives for the decision columns.
--
--   * No default. A default would be this migration picking a coordinator
--     without applying the assignment rule. Choosing a coordinator needs a
--     query over every coordinator's current workload, and a column default
--     cannot run one.
--
--   * No trigger, either to assign on submission or to write history rows.
--     003 and 008 record venue history with triggers, so a reader will expect
--     one here. A trigger cannot know assigned_by. Express connects with the
--     secret key, so auth.uid() inside a trigger is null, as 003's header
--     explains. 003 worked around that by adding last_modified_by to venues
--     purely so the trigger could read the caller from the row, which here
--     would mean a column on event_requests whose only job is passing a value
--     to a trigger. The function SCRUM-330 adds writes the event and its history
--     row in one transaction, the way process_change_request (006) applies an
--     approved change, and it is handed the caller explicitly.
--
--   * No RLS policies. The new table is deny-all by design, the same posture
--     as 001 section 5. The API holds the secret key and authorises in
--     middleware, where the caller's role and their relationship to the event
--     are both known.
--
--   * No column for releasing, expiring or declining an assignment. The story
--     defines one move: the assigned coordinator hands the event to a colleague.
--     Whether an assignment should lapse when someone goes on leave is the same
--     open question for the customer that 010 logged about review claims, and
--     guessing the answer would build the wrong table.
--
--   * No check that a coordinator column names someone who holds the
--     event_coordinator role. The foreign keys prove the id is a real user,
--     nothing more. A CHECK cannot look at another table, and the role lives in
--     profiles. This is the same gap 006 states for processed_by, and the
--     service checks the role.
--
--   * No check that event_requests.assigned_coordinator_id agrees with the
--     newest history row. That is a rule across two tables, which no CHECK can
--     express. It holds because the one function that writes either table
--     writes both in a single transaction.
--
--   * No CHECK refusing a blank handover note. The note is optional, and a
--     blank one shows up as no note, which misleads nobody. 010's rejection
--     reason is different: a blank reason leaves the Organiser with an empty
--     explanation. Normalising '' to null is the service's job.
--
--   * No index for the assignment rule's own query (coordinator workload and
--     time since last assignment). That query is written with SCRUM-330, and
--     any index for it belongs with it, as 005 and 010 argue. Only the
--     per-event history read has a query behind it today -- see section 3.


-- ---------------------------------------------------------------------
-- 1. Who is responsible for the event now
-- ---------------------------------------------------------------------

alter table event_requests
  -- The Event Coordinator currently responsible for this request. Set
  -- automatically on submission (SCRUM-330), and changed only by a handover.
  -- Null on drafts, which nobody has been assigned yet. Null is also allowed
  -- on any other status until 015's constraint arrives.
  --
  -- on delete restrict, matching organiser_id in 001 and both coordinator
  -- columns in 010: removing a user must not silently erase who was
  -- responsible for an event. Deactivating a coordinator, and handing their
  -- events to someone else first, is an application process, not a row
  -- deletion.
  add column if not exists assigned_coordinator_id uuid
    references auth.users (id) on delete restrict;


-- ---------------------------------------------------------------------
-- 2. Every assignment and handover, kept permanently
-- ---------------------------------------------------------------------
-- Named event_request_assignment_history, following venue_change_history
-- (003): the table it belongs to, then what is recorded, then _history. The
-- _history suffix tells a reader the rows are only ever inserted, never
-- edited. The live database already has a venue_block_history in the same
-- shape. Something like "coordinator_assignments" would read as the current
-- assignment, but the current assignment is the column in section 1. This
-- table is how it got there.
--
-- One row per assignment. The first row for a request has a null
-- previous_coordinator_id, and every handover adds one more row, so a
-- request's history reads as a chain: null -> A, A -> B, B -> C.

create table if not exists event_request_assignment_history (
  id                      uuid primary key default gen_random_uuid(),

  -- on delete restrict, not cascade, and this is the choice 003 makes for
  -- venue_change_history rather than the one 006 makes for change requests.
  -- 006 cascades because a change request is a piece of work that only has
  -- meaning while its event exists. This table is different: it is the record
  -- of who was accountable for an event, and an audit record has to outlive
  -- careless deletions of the thing it describes. Nothing in the application
  -- hard-deletes an event request: cancellation is how an event ends, just as
  -- retirement is how a venue ends in 003. With cascade, a hand-run delete in
  -- the SQL editor would erase the accountability record without any warning.
  -- With restrict, whoever deletes an event has to delete its history first,
  -- on purpose.
  --
  -- The cost, stated as 003 states it: removing a test event now means
  -- deleting its history rows first. That will matter to the check scripts'
  -- cleanup once SCRUM-330 starts writing history on submission.
  event_request_id        uuid not null
    references event_requests (id) on delete restrict,

  -- Who held the event before this change. Null means this row is the first
  -- assignment: nobody held it before. It is never null on a handover.
  previous_coordinator_id uuid
    references auth.users (id) on delete restrict,

  -- Who holds it as a result of this change. Never null: an assignment that
  -- names nobody records nothing.
  new_coordinator_id      uuid not null
    references auth.users (id) on delete restrict,

  -- Who made the change. Null means the system assigned the event
  -- automatically: on submission, or by the backfill in section 5. That
  -- matches 003, where a null changed_by means "not done by a person in the
  -- app". On a handover this is normally the previous coordinator. It is a
  -- separate column so that a handover made by someone else stays visible,
  -- rather than being inferred from previous_coordinator_id.
  assigned_by             uuid
    references auth.users (id) on delete restrict,

  -- The optional handover note, for whoever is receiving the event. Always
  -- null on an automatic assignment, because there is nobody handing over.
  handover_note           text,

  -- When the assignment took effect. The name is created_at, not 003's
  -- changed_at, because a history row is never updated, so the moment it was
  -- written is the moment of the change.
  created_at              timestamptz not null default now()
);

-- A handover from a coordinator to themselves is refused by the database,
-- not left only to the service. Three reasons:
--
--   - It describes nothing that happened, yet the table would present it as
--     a handover. Anyone counting handovers, or reading the chain above,
--     would have to know to skip it.
--   - It is a rule about this row alone. That is exactly what a CHECK can
--     enforce. 010 explains that immutability cannot be a CHECK because it
--     needs the previous row; this rule only needs the row being written.
--   - The service still refuses it first, so the person sees a clear
--     message rather than a driver error. This is the same arrangement as
--     010 section 5: the service check produces a useful error, and the
--     database check holds even for writes that do not go through the
--     service.
--
-- `is distinct from`, not `<>`, so that the first assignment
-- (previous_coordinator_id null) passes because of how the expression is
-- written, not because a CHECK that evaluates to null counts as a pass.
--
-- Added in its own guarded block, not declared inside the create table
-- above. On a re-run, create table if not exists skips the entire statement,
-- constraints included. So a constraint declared inline would never be added
-- to a table that already existed without it, for example one created by an
-- earlier version of this file. A separate block checks for the constraint
-- itself. As in 005 section 3 and 010 sections 3-6, the check uses conrelid
-- as well as conname, because a constraint name only has to be unique within
-- its table, so the name alone could match a constraint on another table.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_request_assignment_history_coordinator_changes'
      and conrelid = 'public.event_request_assignment_history'::regclass
  ) then
    alter table event_request_assignment_history
      add constraint event_request_assignment_history_coordinator_changes check (
        previous_coordinator_id is distinct from new_coordinator_id
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. Index
-- ---------------------------------------------------------------------
-- Unlike 005 and 010, which added no index because nothing queried their
-- columns, this one has a real query behind it: an event's assignment history,
-- read newest first, wherever the Organiser or a coordinator views that event.
-- It has the same shape as idx_venue_change_history_venue (003) and
-- idx_event_change_requests_event (006): the event id first, so a lookup only
-- reads that event's rows, then created_at descending, so the rows are already
-- in display order.

create index if not exists idx_event_request_assignment_history_event
  on event_request_assignment_history (event_request_id, created_at desc);


-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- Same posture as 001, 003 and 006: RLS enabled with no policies, so a stray
-- publishable key reads nothing. The API decides who may see an event's
-- history.

alter table event_request_assignment_history enable row level security;


-- ---------------------------------------------------------------------
-- 5. Backfill: assign every request that should already have a coordinator
-- ---------------------------------------------------------------------
-- Which rows: every request with a status other than 'draft' and 'cancelled'
-- that has no coordinator yet. These are exactly the rows 015's constraint
-- will require a coordinator for. 'cancelled' is left alone because a request
-- can be cancelled straight from draft, before anyone was ever responsible,
-- and assigning one now would invent a responsibility that never existed.
--
-- Who gets each one: the story's rule, applied in full rather than by
-- hardcoding today's single coordinator.
--
--   1. Candidates are every profile with role 'event_coordinator'. That literal
--      is the only role value this file uses. The live user_role enum differs
--      from 007's declaration elsewhere (it reads 'technical_support', not
--      'technical_support_staff'), so no other value is assumed to exist.
--   2. Fewest active events first. Active means assigned to that coordinator
--      and in submitted, under_review, pending_clarification, approved,
--      planning or confirmed. That is wider than the review queue
--      (COORDINATOR_QUEUE_STATUSES) on purpose: 007 describes the coordinator
--      role as owning planning for an assigned event, so the work continues
--      after approval. completed, rejected and cancelled are terminal in
--      ALLOWED_TRANSITIONS and carry no further work.
--   3. Ties go to whoever has gone longest without a new assignment, read from
--      the history table. A coordinator who has never been assigned anything
--      sorts first (nulls first).
--   4. Then profiles.id. This choice is arbitrary; it is there only so that
--      the same data always produces the same result.
--
-- Rows are assigned one at a time, oldest submission first, in a loop rather
-- than in a single UPDATE. That is necessary, not a matter of style. A single
-- UPDATE judges every row against the workloads as they were before it
-- started, so with several coordinators it would give every row to whoever
-- was least loaded at the start. Going one row at a time lets each assignment
-- count toward the next choice, which is what "fewest active events" means.
--
-- One exception comes before the rule. If a row already has a
-- reviewing_coordinator_id, it is assigned to that reviewer. Assigning anyone
-- else would immediately create an event whose assigned coordinator cannot
-- decide it, because 010's event_requests_decided_by_is_reviewer only accepts
-- a decision from the reviewer. reviewing_coordinator_id is only read here,
-- never written.
--
-- Each assignment writes one history row with previous_coordinator_id null
-- (first assignment), assigned_by null (the system assigned it) and no note.
-- created_at is clock_timestamp(), not the column default now(). now() is
-- fixed for the whole transaction, so every backfilled row would otherwise
-- share one timestamp, and rule 3 could not tell apart assignments made
-- earlier in this same loop.
-- The timestamp records when the backfill ran, not when the request was
-- submitted. Nobody was assigned at submission time, so dating the row then
-- would invent history.
--
-- Side effect worth knowing: the UPDATE fires event_requests_set_updated_at
-- (001), so updated_at moves to now on every row the backfill touches. Those
-- rows will move to the top of the Organiser's list, which is sorted by
-- updated_at. That is accurate, because the row did change.
--
-- Against the live data as of 2 October 2026 (five rows: two submitted, two
-- under_review, one draft; none with a reviewing_coordinator_id; one
-- event_coordinator in profiles): the four non-draft rows are each assigned
-- to that one coordinator and get one history row each. The draft is not
-- touched. With a single coordinator the workload rule and the tie-break
-- cannot be demonstrated on live data, because every choice has only one
-- answer. The tests cover the rule with several coordinators.
--
-- Running this a second time is safe and writes nothing. The loop only
-- selects rows whose assigned_coordinator_id is still null, and the UPDATE
-- checks for null again. A history row is only inserted when the UPDATE
-- actually changed a row (`found`), so a second run cannot create duplicate
-- history.
--
-- If there is a row to assign and no coordinator exists, this raises an error
-- and stops. Leaving the row without a coordinator would only surface later,
-- as a confusing failure when 015 is applied. On a fresh database with no
-- rows, nothing needs assigning, so the error cannot fire.
--
-- No lock is taken, so a request submitted while this runs may be missed. So
-- will every request submitted after this runs and before SCRUM-330 ships. Both
-- are harmless now, because nothing requires a coordinator yet, and both are
-- why 015 must repeat this backfill before adding its constraint (see the
-- header).

-- Prerequisite check. The backfill reads reviewing_coordinator_id, which
-- 010_event_request_decisions.sql (SCRUM-19) creates. That column exists on the
-- live database but not on dev, so a database rebuilt from dev alone would
-- otherwise reach the loop below and fail with Postgres's "column does not
-- exist", which names neither the missing migration nor the branch it is on.
-- This stops first with an error that does. Sections 1-4 above are all
-- idempotent, so once 010 is applied, running the whole file again is safe.
--
-- table_schema is included because information_schema.columns lists every
-- schema, the same reason the constraint guards include conrelid.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'event_requests'
      and column_name = 'reviewing_coordinator_id'
  ) then
    raise exception '014_coordinator_assignment.sql needs event_requests.reviewing_coordinator_id, which does not exist. Apply 010_event_request_decisions.sql from SCRUM-19 (branch SCRUM-19-Approve-or-Reject-a-Submitted-Event-Request-Event-Coordinator) first, then run this file again.';
  end if;
end
$$;

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
      select p.id
        into v_coordinator
        from profiles p
       where p.role = 'event_coordinator'
       order by
         (select count(*)
            from event_requests a
           where a.assigned_coordinator_id = p.id
             and a.status in ('submitted', 'under_review', 'pending_clarification',
                              'approved', 'planning', 'confirmed')) asc,
         (select max(h.created_at)
            from event_request_assignment_history h
           where h.new_coordinator_id = p.id) asc nulls first,
         p.id asc
       limit 1;

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
-- 6. Tell the API about the new column and table
-- ---------------------------------------------------------------------
-- PostgREST caches the schema. Without this, the API cannot read the new
-- column or table until that cache refreshes, and a request for them fails
-- even though the migration has run. 006 and 010_event_request_clarifications
-- end the same way.

notify pgrst, 'reload schema';
