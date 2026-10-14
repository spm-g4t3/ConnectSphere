-- 031_withdraw_booking_request.sql
-- SCRUM-253: Withdraw a booking request
--
-- Part of SCRUM-243 "Submit a Venue Booking Request". Run this once in the
-- Supabase SQL Editor, after 030_create_booking_request.sql and after
-- 014_booking_review_notifications.sql (it widens that migration's
-- notifications type check). Safe to re-run.
--
-- The assigned coordinator of the event may withdraw a request that is still
-- 'pending'; it becomes 'withdrawn' (027) and Venue Staff are notified. Two
-- things happen here:
--   * notifications accepts a second type, 'booking_request_withdrawn'.
--   * withdraw_booking_request() makes the change and writes the
--     notifications in one transaction.
--
-- ---------------------------------------------------------------------
-- Why a withdrawal cannot overwrite another change
-- ---------------------------------------------------------------------
-- The status is read and written under a row lock, and the write is guarded:
--
--   1. The event row is locked `for update`, as create_booking_request (030),
--      reassign_event_request (018) and change_event_request_status (021) lock
--      it. The coordinator check therefore reads who holds the event at a point
--      where it cannot change before the write: a handover that commits first
--      refuses this call, and one that waits for it happens after.
--   2. The booking row is then locked `for update` and its status read. A
--      concurrent approval or rejection that committed first has changed the
--      status, so this call finds it no longer 'pending' and refuses, instead
--      of overwriting it. Under READ COMMITTED a row locked after waiting is
--      re-read as the other transaction left it.
--   3. The UPDATE itself says `and status = 'pending'`, so even if the lock
--      were skipped it could not move any other status to withdrawn. It is a
--      backstop, as the guard in 018 is; if it ever matches no row, something
--      has broken the locking and the call fails with 40001.
--
-- Lock order is the event, then the booking. create_booking_request locks the
-- event, then the venue, then writes a new booking, so no pair of these can
-- wait on each other. No venue lock is taken: withdrawing only frees a period,
-- so it cannot create a conflict for a block or another request to race with.
--
-- The approve and reject writers (SCRUM-258) must do the same on their side:
-- lock the booking `for update`, read its status, and update with
-- `and status = 'pending'`, so the two outcomes take turns rather than both
-- succeeding.
--
-- A second withdrawal of the same request is not treated as a success. It finds
-- the status 'withdrawn' and is refused like any other request that is not
-- pending, the way a second submit of a submitted event is (016). Nothing here
-- makes the operation idempotent.
--
-- ---------------------------------------------------------------------
-- Errors, and what the service turns them into (bookingRequestService.js)
-- ---------------------------------------------------------------------
--   no_data_found (P0002)     no such booking                   -> NotFoundError
--   insufficient_privilege    the caller is not the event's
--     (42501)                 assigned coordinator              -> ForbiddenError
--   PT409, hint BOOKING_NOT_PENDING                              -> ConflictError
--                             the request is approved, rejected, withdrawn,
--                             flagged for review or cancelled; the status is
--                             in the message
--   serialization_failure (40001)  the guarded update matched no row;
--                                  cannot happen while the locks hold -> 409
--
-- The authorization check comes before the status check, as in 018: whether a
-- request could be withdrawn is a question only its coordinator has any reason
-- to ask.
--
-- ---------------------------------------------------------------------
-- Notifying Venue Staff
-- ---------------------------------------------------------------------
-- Written by this function, in the same transaction as the status change, as
-- 014 does for flagged bookings: a withdrawal that rolls back notifies nobody.
-- One row per Venue Staff profile. SCRUM-174 has not yet said which Venue Staff
-- are "relevant" (SCRUM-216), and 014 set the precedent for that case: with no
-- narrower audience, every holder of the role. When SCRUM-174 defines one, only
-- the recipient query below changes. The type name and payload are this
-- migration's; SCRUM-174's SCRUM-210 may rename or extend them.
--
-- payload keys are camelCase because the API returns the payload as stored
-- (see 014).
--
-- Not done here: the same notification for a NEW request. That insert belongs
-- in create_booking_request (030), at the step marked for SCRUM-174.
--
-- Because it trusts p_requested_by to be who the API authenticated, execute is
-- revoked from public, anon and authenticated, as for 030.


-- ---------------------------------------------------------------------
-- 1. Notifications accept the withdrawal type
-- ---------------------------------------------------------------------
-- Preserve 052's notification vocabulary and the live safety types so applying
-- this missing migration also succeeds on a database with newer notifications.

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known
  check (type in (
    'booking_flagged',
    'booking_request_withdrawn',
    'clarification_requested',
    'clarification_replied',
    'clarification_closed',
    'booking_flagged_setup_change',
    'venue_hold_expired',
    'event_cancelled',
    'event_request_awaiting_assignment',
    'event_request_assigned',
    'event_request_coordinator_assigned',
    'safety_review_response',
    'safety_booking_flagged',
    'safety_equipment_review',
    'event_submitted_for_safety_review'
  ));

alter table notifications drop constraint if exists notifications_request_withdrawn_needs_booking;
alter table notifications
  add constraint notifications_request_withdrawn_needs_booking
  check (type <> 'booking_request_withdrawn' or booking_id is not null);


-- ---------------------------------------------------------------------
-- 2. Withdrawing a request
-- ---------------------------------------------------------------------

create or replace function withdraw_booking_request(
  p_booking_id   uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_event_id   uuid;
  v_event      event_requests;
  v_booking    bookings;
  v_venue_name text;
begin
  -- 1. Which event this is for. Read without a lock: a booking's event never
  --    changes, and the lock that matters is the event's, taken next.
  select b.event_request_id
    into v_event_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 2. Lock the event, then read it.
  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Only the assigned coordinator. A null caller is refused explicitly (see
  --    018).
  if p_requested_by is null
     or v_event.assigned_coordinator_id is distinct from p_requested_by then
    raise exception 'only the coordinator assigned to event request % can withdraw its booking requests',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. Lock the booking and read its status as it is now, not as the caller saw
  --    it.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status <> 'pending' then
    raise exception 'booking request % is %, and only a pending request can be withdrawn',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  -- 5. The change, guarded so it can only ever move a pending request.
  update bookings
     set status = 'withdrawn'
   where id = p_booking_id
     and status = 'pending'
  returning * into v_booking;

  if not found then
    raise exception 'booking request % changed while it was being withdrawn', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 6. Tell Venue Staff, in the same transaction.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_request_withdrawn',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_booking.event_request_id,
           'eventName',      v_event.event_name,
           'venueId',        v_booking.venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at
         )
    from profiles p
   where p.role = 'venue_staff';

  return jsonb_build_object('outcome', 'withdrawn', 'booking', to_jsonb(v_booking));
end;
$$;

-- See the header: only the API should reach this.
revoke execute on function withdraw_booking_request(uuid, uuid)
  from public, anon, authenticated;
