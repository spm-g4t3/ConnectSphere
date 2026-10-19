-- SCRUM363_AC2 / AC3 / AC6: manual, real PostgreSQL two-connection races.
-- Use a disposable test database with the active readiness/confirmation migrations 098 and 099.
-- These checks write data. Do not run against a real event or as one script.
-- Run each labelled block separately in two psql sessions, using service_role
-- or equivalent trusted permissions, at the default READ COMMITTED isolation.
-- Use a FRESH event for each case: safety_approved, assigned to coordinator_id,
-- future dates, every relied-on booking approved and covering its period, and
-- equipment arranged or no requirements. booking_id must belong to this event.
-- Set these variables in BOTH sessions (replace the placeholders):
--   \set event_id '...'
--   \set coordinator_id '...'
--   \set booking_id '...'
--   \timing on

-- Check the fixture before each case. ready must be true; do not proceed if not.
select id, status, assigned_coordinator_id from event_requests where id = :'event_id'::uuid;
select event_readiness(:'event_id'::uuid, false);
select id, event_request_id, status from bookings where id = :'booking_id'::uuid;

-- CASE 1: the booking flag commits first.
-- Session A: start B's block while A sleeps. The direct update isolates the same
-- booking-row write lock taken by the existing flagging functions.
begin;
update bookings set status = 'flagged_for_review'
 where id = :'booking_id'::uuid and event_request_id = :'event_id'::uuid;
select pg_sleep(15);
commit;

-- Session B: must wait on the booking, then refuse with PT409 / EVENT_NOT_READY
-- and a venue condition saying "Flagged for review". No confirmation is written.
begin;
set local lock_timeout = '30s';
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
rollback;

-- Either session: expect safety_approved, flagged_for_review, confirmed_rows = 0.
select e.status, b.status as booking_status,
       (select count(*) from event_request_status_history h
         where h.event_request_id = e.id and h.new_status = 'confirmed') as confirmed_rows
  from event_requests e join bookings b on b.event_request_id = e.id
 where e.id = :'event_id'::uuid and b.id = :'booking_id'::uuid;

-- CASE 2: confirmation commits first. Use another fresh ready event.
-- Session A: start B during the sleep. Its flag must wait for A's FOR SHARE lock.
begin;
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
select pg_sleep(15);
commit;

-- Session B: cannot finish the flag until confirmation commits. The booking was
-- approved when confirmed; a later flag preserves the confirmed event for review.
begin;
set local lock_timeout = '30s';
update bookings set status = 'flagged_for_review'
 where id = :'booking_id'::uuid and event_request_id = :'event_id'::uuid;
commit;

-- Verify one confirmation and the later flag. Repeat the verification query above:
-- expect confirmed, flagged_for_review, confirmed_rows = 1.

-- CASE 3: two confirmations. Use another fresh ready event.
-- Session A: start B during the sleep.
begin;
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
select pg_sleep(15);
commit;

-- Session B: waits on the event, then refuses with 55000 naming status confirmed.
begin;
set local lock_timeout = '30s';
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
rollback;

-- Expect exactly one confirmation history row. Repeat on another fresh event,
-- replacing A's COMMIT with ROLLBACK and B's ROLLBACK with COMMIT: B must succeed
-- and leave exactly one history row, proving A's rolled-back attempt left none.

-- CASE 4: the event starts while confirmation waits. Use another fresh ready event
-- whose start is about 10 seconds ahead and whose approved booking covers it.
-- Session A: lock the booking, without changing it; start B before the event starts.
begin;
select id from bookings
 where id = :'booking_id'::uuid and event_request_id = :'event_id'::uuid for update;
select pg_sleep(15);
commit;

-- Session B: waits until after the event start; must refuse with EVENT_NOT_READY
-- and the date condition "The event's start has passed", despite its transaction
-- having started while the event was still in the future. No confirmation row.
begin;
set local lock_timeout = '30s';
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
rollback;

-- CASES 5 AND 6: real equipment-reservation flagging, both lock orders.
-- Use fresh ready events with equipment fully arranged through SCRUM-300's
-- reservation workflow. Set these extra variables in BOTH sessions:
--   \set equipment_request_id '...'
--   \set reservation_id '...'
-- The request/reservation must belong to event_id; the reservation must be
-- active and unflagged. Verify these rows before running either case.
select id, event_request_id, status from equipment_requests
 where id = :'equipment_request_id'::uuid;
select id, event_request_id, flagged, released_at from equipment_reservations
 where id = :'reservation_id'::uuid;

-- CASE 5, Session A: flag first; start Session B while A sleeps.
begin;
select flag_equipment_reservations(array[:'reservation_id'::uuid], 'SCRUM363 equipment race');
select pg_sleep(15);
commit;

-- Session B: waits for A's equipment-request lock, then refuses with
-- EVENT_NOT_READY, listing the Pending review equipment condition.
begin;
set local lock_timeout = '30s';
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
rollback;

-- Expect safety_approved, pending_review, flagged=true, released_at=null,
-- and confirmed_rows=0. No booking or registration may have been removed.
select e.status, q.status as equipment_status, r.flagged, r.released_at,
       (select count(*) from event_request_status_history h
         where h.event_request_id = e.id and h.new_status = 'confirmed') as confirmed_rows
  from event_requests e
  join equipment_requests q on q.event_request_id = e.id
  join equipment_reservations r on r.event_request_id = e.id
 where e.id = :'event_id'::uuid and q.id = :'equipment_request_id'::uuid
   and r.id = :'reservation_id'::uuid;

-- CASE 6, Session A: use another fresh ready event; confirm first, then start B.
begin;
select confirm_event_request(:'event_id'::uuid, :'coordinator_id'::uuid, false);
select pg_sleep(15);
commit;

-- Session B: the flag transaction must wait for A's equipment-request FOR SHARE
-- lock. After A commits it flags the reservation and returns the request for
-- review, preserving the confirmed event and its reservations.
begin;
set local lock_timeout = '30s';
select flag_equipment_reservations(array[:'reservation_id'::uuid], 'SCRUM363 equipment race');
commit;
-- Repeat the verification query: expect confirmed, pending_review,
-- flagged=true, released_at=null, confirmed_rows=1.
