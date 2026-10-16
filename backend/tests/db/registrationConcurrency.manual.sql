-- SCRUM39_AC4 / AC5: real two-connection lock and rollback checks (not PGlite).
-- Run manually against a disposable PostgreSQL/Supabase test database, after
-- SCRUM-494 and migrations 079-081. This writes registrations; do not use a real event.
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

-- Session B: must wait until A commits, then fail with "Event is full".
begin;
select register_for_event(:'event_id'::uuid, :'attendee_b'::uuid);
rollback;

-- Either session: expect exactly one registered row, belonging to A.
select attendee_id, status from registrations
 where event_request_id = :'event_id'::uuid and status = 'registered';

-- Duplicate race: repeat on a fresh empty test event, using attendee_a in BOTH
-- sessions. B must wait, then fail with "Already registered"; one row remains.

-- Rollback race: repeat on another fresh empty test event, using different
-- attendees, replacing A's COMMIT with ROLLBACK. B must wait, then succeed.
-- Commit B this time. The final query must show only attendee_b, proving A's
-- failed/rolled-back transaction consumed no place.
