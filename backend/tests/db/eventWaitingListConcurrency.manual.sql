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
-- join_event_waitlist for W3. B waits, then answers outcome 'registered': the
-- place A released went to nobody (the queue was empty), so W3 took it the
-- normal way instead of queueing. Never more registered rows than the capacity.

-- SCRUM-473: joins and departures. \set event_id, a full event with its list
-- on, and attendees W3 and W4 with no entry yet (\set attendee_w3, attendee_w4).

-- Race 5, the same attendee joining twice (a double click or a retry):
-- Session A: begin; select join_event_waitlist(:'event_id'::uuid, :'attendee_w3'::uuid); select pg_sleep(15); commit;
-- Session B: select join_event_waitlist(:'event_id'::uuid, :'attendee_w3'::uuid);
-- B waits for A's event lock, then answers outcome 'waitlisted', created false,
-- with A's entry and position. One row for W3; its waitlisted_at is A's.

-- Race 6, two attendees joining at once: as Race 5 with W3 in A and W4 in B.
-- Both are waitlisted; W3 is position n and W4 n + 1, never the same position.

-- Race 7, leaving while a promotion runs: with W1 first in the queue, Session A
-- withdraws a registered attendee (sleeping before COMMIT) while Session B runs
-- leave_event_waitlist(<W1's registration>, <W1>). B waits, then fails with
-- SQLSTATE 55000, hint ALREADY_REGISTERED: W1 kept the promoted place. Repeat
-- with A's COMMIT replaced by ROLLBACK: B then succeeds and W1 is withdrawn.

-- SCRUM-474: promotion against direct registration and capacity changes.

-- Race 8, a direct registration against a withdrawal with a queue: capacity 1,
-- X registered, W1 waiting. Session A withdraws X (sleeping before COMMIT)
-- while Session B runs register_for_event for newcomer N. B waits for A, then
-- answers 'capacity_reached': A's promotion gave the place to W1 before B could
-- count it. One registered row (W1), one registration_promoted notice (W1).

-- Race 9, a direct registration finds a place nobody promoted into: as Race 8,
-- but close registration (registration_closes_at in the past) before A's
-- withdrawal, then reopen it (null) in a third session after A commits. Session
-- B's register_for_event for N promotes W1 first and answers 'capacity_reached'.

-- Race 10, two capacity saves at once: capacity 1, X registered, W1-W3 waiting.
-- Session A saves capacity 3 (sleeping before COMMIT) while Session B saves
-- capacity 2. B waits for A, which promoted W1 and W2, then recounts under the
-- lock and answers outcome 'invalid' ("Cannot be below the 3 attendees already
-- registered"). Afterwards: capacity 3, exactly X, W1 and W2 registered, W3
-- waiting, two notices. Reverse the order (B first) and both saves succeed:
-- capacity 2 promotes W1, then capacity 3 promotes W2.

-- Race 11, a retried promotion: after Race 8, call
--   select promote_waitlisted_registrations(:'event_id'::uuid);
-- in both sessions at once. Both return 0; no row or notification changes.
