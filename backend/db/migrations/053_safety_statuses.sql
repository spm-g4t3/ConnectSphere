-- 053_safety_statuses.sql
-- SCRUM-488 (SCRUM-550): the two statuses of the Operational Safety Check, and
-- the constraints that decide where an event may be stored.
--
-- One file, on purpose. PostgreSQL will not let a transaction use an enum value
-- before the transaction that added it commits, and 047/048 worked around that
-- with two files. That limit is about the enum literal, though: a literal
-- compared with an enum column is cast to the enum type, which is the "use".
-- Every constraint below compares `status::text`, as 048 does for
-- venue_holds_released_at_matches_status and 052 does for its status list, so
-- nothing here names the new values as enum values and the file runs in a
-- single SQL Editor execution. Anything that needs the values as enum literals
-- (a function that assigns status = 'safety_review') belongs in a later file.
--
-- What this does not do:
--   * No event is moved into a new status, and no existing status, decision or
--     history row is written. Adding a constraint only reads the rows.
--   * It does not touch 020, 022 or 025. Those files are history; their three
--     constraints are dropped by name and added again here.
--   * It does not change event_request_status_allows. Which moves are legal is
--     SCRUM-551's migration.
--   * 'planning' stays out of all three lists, as in 020: the enum still holds
--     it, event_requests_status_in_lifecycle refuses it, and no row can carry it.
--
-- Re-runnable: add value if not exists, drop constraint if exists.

alter type event_request_status add value if not exists 'safety_review' before 'confirmed';
alter type event_request_status add value if not exists 'safety_approved' before 'confirmed';


-- ---------------------------------------------------------------------
-- 1. The lifecycle: the nine of 020, and the two safety statuses
-- ---------------------------------------------------------------------
alter table event_requests
  drop constraint if exists event_requests_status_in_lifecycle;

alter table event_requests
  add constraint event_requests_status_in_lifecycle check (
    status::text in (
      'draft', 'submitted', 'under_review', 'pending_clarification',
      'approved', 'safety_review', 'safety_approved', 'confirmed',
      'completed', 'rejected', 'cancelled'
    )
  );


-- ---------------------------------------------------------------------
-- 2. Decided statuses (025 section 3), both lists
-- ---------------------------------------------------------------------
-- An event reaches a safety status after it was approved, so it carries that
-- decision and must keep it: safety_review and safety_approved go in the first
-- list (a decision is required) and the second (a decision is allowed).
-- 'cancelled' stays on the second list only, as in 025.
--
-- Which migration last created these two differs between databases (025, or an
-- earlier 010 that 020 rewrote), so each is dropped by name and added fresh.

alter table event_requests
  drop constraint if exists event_requests_decided_status_has_decision;

alter table event_requests
  add constraint event_requests_decided_status_has_decision check (
    status::text not in (
      'approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected'
    )
    or decision is not null
  );

alter table event_requests
  drop constraint if exists event_requests_decision_has_decided_status;

alter table event_requests
  add constraint event_requests_decision_has_decided_status check (
    decision is null
    or status::text in (
      'approved', 'safety_review', 'safety_approved', 'confirmed', 'completed',
      'rejected', 'cancelled'
    )
  );


-- ---------------------------------------------------------------------
-- 3. The status history (022 section 3)
-- ---------------------------------------------------------------------
-- It holds the same set as the lifecycle. Left as it was, every transition into
-- or out of a safety status would fail to write its history row, and the
-- shared status function would roll the whole change back.

alter table event_request_status_history
  drop constraint if exists event_request_status_history_statuses_in_lifecycle;

alter table event_request_status_history
  add constraint event_request_status_history_statuses_in_lifecycle check (
    previous_status::text in (
      'draft', 'submitted', 'under_review', 'pending_clarification',
      'approved', 'safety_review', 'safety_approved', 'confirmed',
      'completed', 'rejected', 'cancelled'
    )
    and new_status::text in (
      'draft', 'submitted', 'under_review', 'pending_clarification',
      'approved', 'safety_review', 'safety_approved', 'confirmed',
      'completed', 'rejected', 'cancelled'
    )
  );


notify pgrst, 'reload schema';
