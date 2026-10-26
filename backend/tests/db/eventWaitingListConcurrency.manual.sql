-- SCRUM-460 AC4: real two-connection waiting-list races (not PGlite).
-- Run manually against a disposable PostgreSQL/Supabase test database built from
-- backend/db/baseline/ plus every migration. This writes registrations; do not
-- use a real event. Use two psql sessions as service_role, and copy each
-- session's block separately; do not run this file as one script.
-- Set up a confirmed event, open for registration, waiting list on, a future
-- withdrawal deadline and capacity 2. Register attendees X and Y, then have W1
-- and W2 join the waiting list (join_event_waitlist), in that order. Set these
-- IN BOTH sessions:
--   \set event_id '...'
--   \set reg_x '...'   \set attendee_x '...'
--   \set reg_y '...'   \set attendee_y '...'
--   \set organiser '...'

-- Race 1, two withdrawals: each releases one place, so W1 and W2 are each
-- promoted once.
-- Session A: start this block first. During the sleep, start Session B's block.
begin;
select withdraw_registration(:'reg_x'::uuid, :'attendee_x'::uuid);
select pg_sleep(15);
commit;

-- Session B: must wait for A's event lock, then promote the next attendee only.
begin;
select withdraw_registration(:'reg_y'::uuid, :'attendee_y'::uuid);
commit;

-- Either session: exactly two registered (W1, W2), none waitlisted, and one
-- registration_promoted notification for each of W1 and W2.
select attendee_id, status from event_registrations where event_request_id = :'event_id'::uuid order by status;
select recipient_id, count(*) from notifications
 where type = 'registration_promoted' and event_request_id = :'event_id'::uuid group by recipient_id;

-- Race 2, a withdrawal against a capacity increase: reset to X, Y registered and
-- W1, W2 waiting. Session A withdraws X as above while Session B saves the same
-- settings with capacity 3:
--   select setup_event_registration(:'event_id'::uuid, :'organiser'::uuid, true,
--     <opens_at>, null, 3, <deadline>, true);
-- B must wait for A. Afterwards: Y, W1 and W2 registered (3 = capacity), each
-- promoted once; never more registered rows than the capacity.

-- Race 3, a rolled-back withdrawal: repeat Race 1 with A's COMMIT replaced by
-- ROLLBACK. A promotes nobody (its promotion rolls back with it); B's withdrawal
-- then promotes W1 only, and only W1 is notified.

-- Race 4, a join against a withdrawal: with the event full and nobody waiting,
-- Session A withdraws X (sleeping before COMMIT) while Session B runs
-- join_event_waitlist for W3. B waits, then answers "places_available": the
-- place A released was not handed to anyone because the queue was empty.
