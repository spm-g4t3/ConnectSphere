-- SCRUM39_AC4 / AC5: real two-connection lock and rollback checks (not PGlite).
-- Run manually against a disposable PostgreSQL/Supabase test database built from
-- backend/db/baseline/ (register_for_event in 08_registration.sql) plus any later
-- migrations. This writes registrations; do not use a real event.
-- Use two separate psql sessions as service_role (or a role with equivalent rights).
-- Copy each session's block separately; do not run this file as one script.
-- Set these variables IN BOTH sessions to a dedicated, confirmed, enabled event
-- inside its registration window, with capacity 1 and no active registrations,
-- and two different existing accounts whose profiles have the Attendee role:
--   \set event_id '...'
--   \set attendee_a '...'
--   \set attendee_b '...'

-- Session A: start this block first. During the sleep, start Session B's block.
begin;
select register_for_event(:'event_id'::uuid, :'attendee_a'::uuid);
select pg_sleep(15);
commit;

-- Session B: must wait until A commits, then return outcome "capacity_reached".
begin;
select register_for_event(:'event_id'::uuid, :'attendee_b'::uuid);
rollback;

-- Either session: expect exactly one registered row, belonging to A.
select attendee_id, status from event_registrations
 where event_request_id = :'event_id'::uuid and status = 'registered';

-- SCRUM46_AC2 / AC5: the authoritative browse count must also report one place
-- taken and a registered flag only for A. Both callers see the same active count.
select * from open_event_registration_state(array[:'event_id'::uuid], :'attendee_a'::uuid);
select * from open_event_registration_state(array[:'event_id'::uuid], :'attendee_b'::uuid);

-- Duplicate race: repeat on a fresh empty test event, using attendee_a in BOTH
-- sessions. B must wait, then return outcome "already_registered"; one row remains.

-- Rollback race: repeat on another fresh empty test event, using different
-- attendees, replacing A's COMMIT with ROLLBACK. B must wait, then succeed.
-- Commit B this time. The final query must show only attendee_b, proving A's
-- failed/rolled-back transaction consumed no place.
