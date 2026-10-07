-- 025_event_request_decisions.sql
-- SCRUM-163, a subtask of SCRUM-19 (Approve or Reject a Submitted Event Request)
--
-- Renamed from 010_ on 6 October 2026, because dev
-- already had a different 010 (010_event_request_clarifications.sql). 025 was
-- agreed with the team; 024 is claimed. This file is applied to the live
-- database under its old name, so the rename is a repository correction, not a
-- schema change. Do not run it again: there is nothing left for it to do. (It
-- is idempotent, as "Safe to run again" below says, so a mistaken run changes
-- nothing.)
--
-- 014_coordinator_assignment.sql and 018_reassign_event_request.sql still call
-- it by its 010_ name, deliberately: both are applied, and
-- migrations here are append-only (001's header states the rule). 014's
-- prerequisite guard raises an error naming the old filename; it also names
-- the SCRUM-19 branch, which is enough to find this file. The "Numbered 010"
-- paragraph below is the original reasoning, kept as written.
--
-- Gives an event request somewhere to record who reviewed it, what was decided,
-- why, by whom and when. Until now the table could say a request had been
-- submitted (005) and nothing more: the status enum from 001 has carried
-- 'approved' and 'rejected' since the first migration, but nothing in the
-- schema or the service has ever written either, and there was no column to put
-- a reason in. This is that column set.
--
-- Run this once in the Supabase SQL Editor. Safe to run again.
--
-- Numbered 010 by agreement with the team, and appended rather than slotted in.
-- 001's header states the rule -- additions go in a new numbered migration
-- rather than an edit -- and this repository has already paid for breaking it:
-- two files collide at 005, and four change-request migrations were lost to a
-- renumbering. No existing file is touched here, including the ones that are
-- already mis-numbered.
--
--
-- Why this adds a coordinator column when the codebase documents the absence
-- of one:
--
-- src/domain/eventRequestStatus.js says there is no coordinator_id on
-- event_requests, and eventRequestStatus.test.js asserts that absence as a
-- design property rather than an oversight. Both remain true. This migration
-- does not add an assignment model, and nothing here assigns a request to
-- anybody.
--
-- What it adds is a *claim on review*. A coordinator who moves a request from
-- 'submitted' to 'under_review' writes themselves into
-- reviewing_coordinator_id, and only that person may then decide it. The queue
-- stays shared -- GET /api/event-requests/queue is still every coordinator's
-- view of everything waiting, and nothing distributes work to anyone -- but
-- once someone starts reviewing, the request is theirs to finish.
--
-- That is what satisfies SCRUM-19 AC1 ("only the Event Coordinator assigned to
-- an event request can approve or reject it") without building Coordinator
-- Assignment, which is core feature #5 and its own story. The distinction is
-- worth being precise about: assignment is somebody deciding who handles what,
-- ahead of the work. A claim is the reviewer identifying themselves as they
-- begin. The first needs a person or rule to do the assigning and a way to
-- reassign; the second needs one column and no process at all.
--
--
-- What this migration deliberately does not do:
--
--   * No NOT NULL on any new column. A draft, a submitted request and one under
--     review legitimately carry none of these, and the great majority of rows
--     in this table will never carry a decision at all. Mandatoriness here is a
--     property of a status, not of a row, which is the same reasoning 005's
--     header gives for leaving the requirement columns nullable.
--
--   * No defaults, for the same reason: an undecided request has no decision,
--     and a default would be this migration inventing an answer.
--
--   * No trigger setting decided_at. This is the one place the file departs
--     from 006_event_change_requests.sql, which sets processed_at from a trigger
--     the moment decision first becomes non-null -- a reader coming from that
--     file will look for the equivalent here and should know it is missing on
--     purpose. The service sets decided_at from an injected clock, the way
--     submitEventRequest already sets submitted_at, so the decision tests stay
--     deterministic instead of depending on the database's now(). A trigger
--     would overrule that injected value and there would be no way to test the
--     timestamp at all.
--
--   * No immutability enforcement. AC7 says a recorded decision cannot be
--     edited afterwards, and that cannot be expressed as a check constraint: a
--     CHECK sees only the row being written, never the row it replaces, so it
--     cannot tell a first decision from an overwrite of one. It needs either a
--     BEFORE UPDATE trigger comparing OLD to NEW, or the service refusing the
--     write. SCRUM-121 does the latter, guarding the update on the row still
--     being undecided in the same way submitEventRequest guards on the row
--     still being a draft.
--
--   * No column for releasing or reassigning a claim. A coordinator who starts
--     a review and then goes on leave currently blocks that request, and
--     nothing here unblocks it. Out of scope for SCRUM-19, and logged as a
--     question for the customer rather than answered by guessing: whether a
--     claim should expire, be handed over, or be broken by another coordinator
--     is a process question, and the wrong guess builds the wrong table.
--
--   * No index. Nothing filters, joins or sorts on these columns yet -- the
--     coordinator queue selects on status and orders by submitted_at, both of
--     which 001 already indexes. An index on decision would also be close to
--     useless: it is null for nearly every row and has two values otherwise.
--
--   * No RLS policies. The table is deny-all by design (001, section 5) and the
--     API authorises in middleware, where the caller's role is known. Nothing
--     about recording a decision changes that.


-- ---------------------------------------------------------------------
-- 1. The decision vocabulary
-- ---------------------------------------------------------------------
-- Its own type, not a subset of event_request_status, for the reason 006 gives
-- for change_request_decision: a decision is a two-valued outcome, while a
-- status is a stage in a fourteen-step process. They answer different
-- questions, and a request that is approved and then moves on to 'planning'
-- still has 'approved' as its recorded outcome -- which a column reusing the
-- status enum could not express without being read as a stage.
--
-- Guarded against pg_type exactly as 001 guards event_request_status and 006
-- guards change_request_decision, so the file can be re-run.
--
-- To add a value later:  alter type event_request_decision add value 'x';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_request_decision') then
    create type event_request_decision as enum (
      'approved',   -- cleared to proceed to planning
      'rejected'    -- turned down, with a reason recorded
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. The review claim and the decision
-- ---------------------------------------------------------------------

alter table event_requests
  -- The coordinator who claimed this request by starting its review. Written
  -- when the status moves to 'under_review' and not before: 'submitted' means
  -- nobody has picked it up, which is exactly what the shared queue shows.
  --
  -- Deliberately not constrained against status. A request bounced to
  -- 'pending_clarification' keeps its reviewer, because the Organiser is
  -- answering the coordinator who asked -- the same reasoning
  -- eventRequestStatus.js gives for that status returning to 'under_review'
  -- rather than to 'submitted'.
  --
  -- on delete restrict, matching organiser_id in 001 and processed_by in 006:
  -- removing a user must not erase who reviewed an event. Deactivating an
  -- account is an application concern, not a row deletion.
  add column if not exists reviewing_coordinator_id uuid
    references auth.users (id) on delete restrict,

  -- The outcome. Null until a decision is made, which is nearly every row --
  -- the constraint in section 3 ties it to the status so the two cannot
  -- disagree.
  add column if not exists decision event_request_decision,

  -- One note column, not a rejection_reason and an approval_note pair. A
  -- request has at most one decision, so two columns would permit a row
  -- carrying both a rejection reason and an approval note -- a state that
  -- describes nothing that can happen, and which every reader of the table
  -- would then have to write code to rule out. AC4 makes the note mandatory on
  -- rejection and optional on approval; that is a difference in when it is
  -- required, not in what it is, so it is one column and a constraint.
  add column if not exists decision_note text,

  -- Who decided. Must be the reviewing coordinator (section 5) -- this column
  -- exists separately rather than being inferred from
  -- reviewing_coordinator_id because "who holds this" and "who ended it" are
  -- different facts, and keeping both makes the constraint that ties them
  -- together something the database can check rather than something a reader
  -- has to trust.
  add column if not exists decided_by uuid
    references auth.users (id) on delete restrict,

  -- When. Set by the service from an injected clock, not by a trigger -- see
  -- the header. Distinct from updated_at, which the
  -- event_requests_set_updated_at trigger from 001 moves on every write: a
  -- later edit to anything else on the row must not appear to change when the
  -- decision was taken.
  add column if not exists decided_at timestamptz;


-- ---------------------------------------------------------------------
-- 3. The decision and the status agree with each other
-- ---------------------------------------------------------------------
-- Two one-way implications rather than 006's single biconditional, and two
-- separate constraints rather than one holding both. Three things follow from
-- that choice; the third is the reason it is not merely a matter of taste.
--
-- First, the rule itself. A decision is not a stage, and it does not expire
-- when the request moves on. ALLOWED_TRANSITIONS in
-- src/domain/eventRequestStatus.js does not stop at 'approved': it continues
-- approved -> planning -> confirmed -> completed. An event that is being
-- arranged, or has already happened, was approved once and still was -- so the
-- set of statuses that imply a decision is every status at or past the
-- decision point, not just the two the decision names.
--
-- This is where event_request_status and change_request_status genuinely
-- differ, and why 006's shape does not transfer. change_request_status ends at
-- 'processed'; nothing moves past it, so there a decided status and the
-- decision point are the same thing.
--
-- Second, why two constraints and not one expression. A violation reports the
-- constraint's name and nothing else, and these two fail for opposite reasons
-- needing opposite fixes: one means a status was advanced without recording
-- the decision that justified it, the other means a decision was written
-- against a request that has not reached the decision point. Held in one
-- constraint both arrive as the same name and whoever is debugging has to work
-- out which half tripped. The service's translateError passes the driver
-- message through, so the name is what a developer actually sees.
--
-- Third, and the reason this could not be one biconditional even if the
-- messages did not matter: THE TWO SETS ARE NOT THE SAME. 'cancelled' is
-- excluded from the first and included in the second.
--
--   - Excluded from the first, because a request can be cancelled from 'draft'
--     or 'submitted' -- or from 'under_review', or 'pending_clarification' --
--     without anyone ever having decided it. Requiring a decision on every
--     cancelled row would refuse an Organiser calling off an event they had
--     only just drafted, which the customer brief explicitly allows at any
--     stage.
--
--   - Included in the second, because ALLOWED_TRANSITIONS also permits
--     approved -> cancelled, planning -> cancelled and confirmed -> cancelled.
--     An event that was approved and then called off keeps its approval on
--     record; a second set that omitted 'cancelled' would make that row
--     unstorable. 'cancelled' is the one status reachable both with a decision
--     and without one, which is exactly why it belongs on one side only.
--
-- status is not null (001), so neither `status not in (...)` nor
-- `status in (...)` can evaluate to null, and neither check can pass a row by
-- accident through three-valued logic.
--
-- Both guarded in 005's style so the file can be re-run, with conrelid in the
-- test because constraint names are unique per table rather than per database.
-- The drop below is for a narrower case: an earlier revision of this same file
-- created a single event_requests_decision_matches_status, so an environment
-- that applied that version would otherwise keep it alongside these two. It is
-- `if exists`, so it is a no-op everywhere else.

alter table event_requests
  drop constraint if exists event_requests_decision_matches_status;

-- A decided status requires a decision: nothing can reach 'approved' or any
-- status beyond it without a recorded outcome to explain how it got there.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decided_status_has_decision'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_decided_status_has_decision check (
        status not in ('approved', 'rejected', 'planning', 'confirmed', 'completed')
        or decision is not null
      );
  end if;
end
$$;

-- A decision requires a decided status: an outcome cannot be recorded against
-- a request still waiting to be reviewed. 'cancelled' is admitted here and not
-- above, for the reason given in the block comment.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decision_has_decided_status'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_decision_has_decided_status check (
        decision is null
        or status in (
          'approved', 'rejected', 'planning', 'confirmed', 'completed', 'cancelled'
        )
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 4. A rejection must carry a reason
-- ---------------------------------------------------------------------
-- AC4: mandatory on rejection, optional on approval. An Organiser told only
-- that their event was refused has nothing to act on, and the status page
-- already promises them the reason -- STATUS_DISPLAY's text for 'rejected'
-- reads "See the Coordinator notes for the reason", so a rejection with no
-- note makes the application lie to them.
--
-- length(trim(...)) > 0 rather than a bare not-null test, matching the
-- event_name check in 001: a space is not a reason, and a form that submits
-- one should be refused here rather than storing something that renders as an
-- empty explanation.
--
-- `is distinct from` rather than `<>` so the null case is stated instead of
-- relying on a CHECK passing when its expression evaluates to null. An
-- undecided row -- decision null -- satisfies this because it is not a
-- rejection, and that should be visible in the expression rather than a
-- consequence of three-valued logic a reader has to work out.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_rejection_has_reason'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_rejection_has_reason check (
        decision is distinct from 'rejected'
        or (decision_note is not null and length(trim(decision_note)) > 0)
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 5. Only the reviewing coordinator may decide
-- ---------------------------------------------------------------------
-- AC1, enforced by the database rather than only by the service. The service
-- will check it too -- it has to, to return a useful 403 rather than a driver
-- error -- but a rule that only exists in application code is one migration or
-- one direct write away from being untrue, and this is the rule the whole
-- claim-on-review design rests on.
--
-- `is not distinct from` on the second branch, not `=`. With `=`, a row naming
-- a decider but no reviewer would compare uuid to null, evaluate to null, and
-- pass -- letting a decision exist with nobody having claimed the request,
-- which is the exact hole this constraint is here to close. `is not distinct
-- from` returns false there and the write is refused.
--
-- The first branch is what keeps undecided rows legal: decided_by null says
-- nothing has been decided, and says nothing about who holds the review.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decided_by_is_reviewer'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_decided_by_is_reviewer check (
        decided_by is null
        or decided_by is not distinct from reviewing_coordinator_id
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 6. No partial decision records
-- ---------------------------------------------------------------------
-- The three decision columns are written together or not at all. AC7 and
-- SCRUM-163's second subtask both require a refused decision to leave the
-- event completely unchanged, and the cheapest way for that to go wrong is a
-- half-written row: an outcome with no decider, or a timestamp with no
-- outcome. The service writes all three in one statement; this makes any other
-- shape unstorable, including one written by hand in the SQL editor.
--
-- Note what this does not include. reviewing_coordinator_id is deliberately
-- absent from the grouping, because a claim exists on its own for as long as
-- the review takes -- a request under review has a reviewer and no decision,
-- and that is the normal state for every request a coordinator is working on.
-- Section 5 already forces a reviewer to exist by the time a decision does.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_decision_fields_together'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_decision_fields_together check (
        (decision is null and decided_by is null and decided_at is null)
        or (decision is not null and decided_by is not null and decided_at is not null)
      );
  end if;
end
$$;
