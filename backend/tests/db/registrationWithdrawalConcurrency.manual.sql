-- SCRUM-27 / SCRUM-59: real two-connection withdrawal races (not PGlite).
-- Run manually against a disposable PostgreSQL/Supabase test database built from
-- backend/db/baseline/ plus every migration. This writes registrations; do not
-- use a real event. Use two psql sessions as service_role, and copy each
-- session's block separately; do not run this file as one script.
-- Set these IN BOTH sessions: a registration with status 'registered' on a
-- confirmed event whose withdrawal deadline is in the future, and its attendee:
--   \set registration_id '...'
--   \set attendee_id '...'

-- Session A: start this block first. During the sleep, start Session B's block.
begin;
select withdraw_registration(:'registration_id'::uuid, :'attendee_id'::uuid);
select pg_sleep(15);
commit;

-- Session B: must wait until A commits, then fail with SQLSTATE 55000,
-- hint ALREADY_WITHDRAWN. Only A's call withdrew the registration.
begin;
select withdraw_registration(:'registration_id'::uuid, :'attendee_id'::uuid);
rollback;

-- Either session: one row, withdrawn, updated_at from A's call.
select id, status, updated_at from event_registrations where id = :'registration_id'::uuid;

-- Rollback race: set the registration back to 'registered', then repeat with
-- A's COMMIT replaced by ROLLBACK. B must wait, then succeed; commit B. The row
-- must be withdrawn once, by B.

-- Withdrawal against registration (SCRUM-61): on a capacity-1 event, register
-- attendee X, then run A's block withdrawing X while Session B runs
-- register_for_event(event, Y). B must wait for A, then return "registered"
-- with registeredCount 1. Repeat with A's COMMIT replaced by ROLLBACK: B must
-- wait, then return "capacity_reached". Either way the event never holds more
-- registered rows than its capacity.
