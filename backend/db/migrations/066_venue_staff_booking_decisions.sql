-- 066_venue_staff_booking_decisions.sql
-- SCRUM-258: Venue Staff see the open booking requests and approve or reject
-- each one; the decision is recorded on the booking and the coordinator told.
--
-- An approval re-checks the request's occupied period under lock, marks the
-- other events' open requests that overlap it 'conflicting' and tells their
-- coordinators, and converts the event's own hold on that venue. Each request
-- is decided on its own; the event's other bookings are not touched.
--
-- Conflicting is a flag, not an end state: changes flag and notify, and the
-- Coordinator decides. A conflicting request stays open and is handled as a
-- pending one wherever a pending one has special handling: the queue, deciding,
-- withdrawing, the one-live-request rule, and cancellation (067). It never
-- occupies a venue (venue_occupancy_conflicts, 040, is unchanged) and never
-- reverts to pending by itself.
--
-- A converted hold no longer occupies the venue; the approved booking does.
-- Nothing else that reads or writes venue_holds changes, because each acts on
-- status 'active' only: venue_occupancy_conflicts and process_venue_hold_expiry
-- (040) skip it, and cancellation (067) cancels the booking it became.
--
-- Adds: decision columns on bookings; converted columns on venue_holds; the
-- decision notification types; pending_request_overlaps,
-- list_pending_booking_requests and decide_booking_request; and restates
-- withdraw_booking_request (031) and create_booking_request (051) to treat
-- conflicting as open and, for create, to accept the safety statuses.
-- Statuses are compared as text where 062's or 065's values appear, as 062
-- explains.
--
-- Run order: 065, then 066, then 067, each as a separate execution (065's enum
-- values must commit first).
--
-- SQLSTATEs, mapped by translateError:
--   list_pending_booking_requests
--     42501  the caller is null, or does not hold venue_staff              403
--   decide_booking_request
--     42501  the caller is null, or does not hold venue_staff              403
--     22023  an unknown decision, a rejection without a reason, or a
--            reason or alternative given with an approval                  400
--     23514  a reason or alternative over 1000 characters                  400
--     P0002  no such booking                                               404
--     PT409  BOOKING_NOT_PENDING, EVENT_NOT_BOOKABLE, BOOKING_PERIOD_STALE,
--            VENUE_RETIRED                                                 409
--     40001  the guarded update matched no row (see 031)                   409
--   withdraw_booking_request and create_booking_request keep 031's and 051's.


-- ---------------------------------------------------------------------
-- 1. The decision on the booking
-- ---------------------------------------------------------------------
-- Nullable and without defaults, for 025's reasons: an undecided request has
-- no decision, and older approved bookings were never decided by anyone. The
-- status carries what was decided: a rejection stays rejected, and an approval
-- may later be flagged or cancelled while keeping who approved it and when.
--
-- No trigger keeps these columns from being edited. As 025 says, a CHECK
-- cannot tell a first write from an overwrite; the guarantee is that
-- decide_booking_request writes them only on a row still open under its
-- lock, and nothing else writes them.

alter table bookings
  add column if not exists decided_by            uuid references auth.users (id),
  add column if not exists decided_at            timestamptz,
  add column if not exists decision_reason       text,
  add column if not exists suggested_alternative text;

-- Who and when are recorded together.
alter table bookings drop constraint if exists bookings_decided_paired;
alter table bookings
  add constraint bookings_decided_paired check (
    (decided_by is null) = (decided_at is null)
  );

-- A decided request is no longer open (pending or conflicting), and was
-- never withdrawn.
alter table bookings drop constraint if exists bookings_decided_not_pending;
alter table bookings
  add constraint bookings_decided_not_pending check (
    decided_at is null or status::text not in ('pending', 'conflicting', 'withdrawn')
  );

-- A reason belongs to a decided rejection, and says something.
alter table bookings drop constraint if exists bookings_decision_reason_on_rejection;
alter table bookings
  add constraint bookings_decision_reason_on_rejection check (
    decision_reason is null
    or (status::text = 'rejected'
        and decided_at is not null
        and length(btrim(decision_reason)) > 0
        and length(decision_reason) <= 1000)
  );

-- Every rejection decided here has its reason. Tied to decided_at rather than
-- the status alone, so a rejected row written before this file still passes.
alter table bookings drop constraint if exists bookings_rejection_has_reason;
alter table bookings
  add constraint bookings_rejection_has_reason check (
    decided_at is null or status::text <> 'rejected' or decision_reason is not null
  );

-- The suggested alternative is optional, and only ever part of a rejection.
alter table bookings drop constraint if exists bookings_suggested_alternative_on_rejection;
alter table bookings
  add constraint bookings_suggested_alternative_on_rejection check (
    suggested_alternative is null
    or (decision_reason is not null
        and length(btrim(suggested_alternative)) > 0
        and length(suggested_alternative) <= 1000)
  );


-- ---------------------------------------------------------------------
-- 2. Converted holds (as 048 records released ones)
-- ---------------------------------------------------------------------
-- converted_at and converted_booking_id are set exactly when the status is
-- 'converted'. Compared as text, as 048 does, so the check needs no enum
-- literal from 065.

alter table venue_holds
  add column if not exists converted_at timestamptz,
  add column if not exists converted_booking_id uuid references bookings (id);

alter table venue_holds
  drop constraint if exists venue_holds_converted_at_matches_status;
alter table venue_holds
  add constraint venue_holds_converted_at_matches_status
  check ((status::text = 'converted') = (converted_at is not null));

alter table venue_holds
  drop constraint if exists venue_holds_converted_booking_matches_status;
alter table venue_holds
  add constraint venue_holds_converted_booking_matches_status
  check ((status::text = 'converted') = (converted_booking_id is not null));


-- ---------------------------------------------------------------------
-- 3. Notifications accept the three decision types (extends 052)
-- ---------------------------------------------------------------------
-- 052's eleven, unchanged and in 052's order, then this file's three.

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
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
      'booking_request_approved',
      'booking_request_rejected',
      'booking_request_conflicting'
    )
  );

-- As 031 does for a withdrawal: the notice names the booking it is about.
alter table notifications drop constraint if exists notifications_booking_decision_needs_booking;
alter table notifications
  add constraint notifications_booking_decision_needs_booking
  check (type not in ('booking_request_approved', 'booking_request_rejected',
                      'booking_request_conflicting')
         or booking_id is not null);


-- ---------------------------------------------------------------------
-- 4. pending_request_overlaps
-- ---------------------------------------------------------------------
-- The one home of "which open requests overlap this period": the queue
-- (section 5) and approval (section 6) both ask it. Open is pending or
-- conflicting, since a conflicting request can still be approved once its
-- clash is gone. venue_occupancy_conflicts (040) deliberately never counts
-- either as an occupant.
--
-- Read-only. Pending requests never block each other (first come, first
-- served), so the overlaps are shown for the decision, not enforced here.
--
-- Both periods are padded by venue_occupied_period() (032) with the venue's
-- minutes and compared with &&: half-open, so touching is no clash. Requests
-- of p_exclude_event_id are left out; null excludes nothing.

create or replace function pending_request_overlaps(
  p_venue_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_exclude_event_id  uuid
)
returns table (
  id                 uuid,
  event_request_id   uuid,
  event_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  occupied_starts_at timestamptz,
  occupied_ends_at   timestamptz,
  created_at         timestamptz
)
language sql
stable
as $$
  with requested as (
    select v.id,
           v.setup_minutes::integer      as setup_minutes,
           v.turnaround_minutes::integer as turnaround_minutes,
           venue_occupied_period(p_starts_at, p_ends_at,
                                 v.setup_minutes, v.turnaround_minutes) as period
      from venues v
     where v.id = p_venue_id
  ),
  pending as (
    select b.id,
           b.event_request_id,
           er.event_name,
           b.starts_at,
           b.ends_at,
           b.created_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 req.setup_minutes, req.turnaround_minutes) as occupied,
           req.period
      from requested req
      join bookings b
        on b.venue_id = req.id
      join event_requests er
        on er.id = b.event_request_id
     where b.status in ('pending', 'conflicting')
       and b.event_request_id is distinct from p_exclude_event_id
  )
  select p.id,
         p.event_request_id,
         p.event_name,
         p.starts_at,
         p.ends_at,
         lower(p.occupied),
         upper(p.occupied),
         p.created_at
    from pending p
   where p.occupied && p.period
   order by p.created_at, p.id;
$$;

revoke execute on function pending_request_overlaps(uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. list_pending_booking_requests
-- ---------------------------------------------------------------------
-- The Venue Staff queue: every open request, oldest first, each with the
-- other events' open requests that clash with it (section 4). A conflicting
-- request still waits for Venue Staff, so it is listed; each element carries
-- its `status` so the screen can tell the two apart. A jsonb array, '[]' when
-- nothing is open, as the other jsonb readers answer.

create or replace function list_pending_booking_requests(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as place_venue_hold (040) checks it. A null caller is
  -- refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view pending booking requests'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    with pending as (
      select b.*,
             er.event_name,
             er.status::text                      as event_status,
             v.name                               as venue_name,
             v.location                           as venue_location,
             venue_occupied_period(b.starts_at, b.ends_at,
                                   v.setup_minutes, v.turnaround_minutes) as occupied
        from bookings b
        join event_requests er on er.id = b.event_request_id
        join venues v          on v.id  = b.venue_id
       where b.status in ('pending', 'conflicting')
    )
    select jsonb_agg(
             jsonb_build_object(
               'id',                         p.id,
               'status',                     p.status,
               'event_request_id',           p.event_request_id,
               'event_name',                 p.event_name,
               'event_status',               p.event_status,
               'venue_id',                   p.venue_id,
               'venue_name',                 p.venue_name,
               'venue_location',             p.venue_location,
               'starts_at',                  p.starts_at,
               'ends_at',                    p.ends_at,
               'occupied_starts_at',         lower(p.occupied),
               'occupied_ends_at',           upper(p.occupied),
               'expected_attendance',        p.expected_attendance,
               'room_layout_code',           p.room_layout_code,
               'venue_requirements',         p.venue_requirements,
               'accessibility_requirements', p.accessibility_requirements,
               'setup_notes',                p.setup_notes,
               'suitability_result',         p.suitability_result,
               'suitability_overridden',     p.suitability_overridden,
               'requested_by',               p.requested_by,
               'created_at',                 p.created_at,
               -- Other events only, which also leaves this request out: 051
               -- refuses a second live request for the same event and venue,
               -- so a same-event clash is not a choice Venue Staff make.
               'overlapping', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',                 o.id,
                            'event_request_id',   o.event_request_id,
                            'event_name',         o.event_name,
                            'starts_at',          o.starts_at,
                            'ends_at',            o.ends_at,
                            'occupied_starts_at', o.occupied_starts_at,
                            'occupied_ends_at',   o.occupied_ends_at,
                            'created_at',         o.created_at
                          )
                          order by o.created_at, o.id
                        )
                   from pending_request_overlaps(p.venue_id, p.starts_at, p.ends_at,
                                                 p.event_request_id) o
               ), '[]'::jsonb)
             )
             order by p.created_at, p.id
           )
      from pending p
  ), '[]'::jsonb);
end;
$$;

-- As in 030, 040 and 051: only the API should reach this. Nothing is granted.
revoke execute on function list_pending_booking_requests(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. decide_booking_request
-- ---------------------------------------------------------------------
-- One function for both decisions: they share the role check, the locks, the
-- open check, the guarded update and the notice; approval adds the event and
-- period checks between them. A conflicting request can be decided as a
-- pending one can; the re-check still refuses an approval while the clash
-- stands.
--
-- Returns, for a rejection, {outcome: 'rejected', booking}; for an approval
-- something now occupies, {outcome: 'conflict', conflicts} built as
-- create_booking_request builds them, with nothing written; and for an
-- approval, {outcome: 'approved', booking, marked_conflicting: [id],
-- converted_hold_id}.
--
-- An approval then marks the other events' pending requests whose occupied
-- periods overlap it conflicting, as pending_request_overlaps answers, and
-- notifies each one's coordinator (step 12). Requests already conflicting stay
-- so and are not notified again. This event's other requests are never
-- touched. Last (step 13) it converts this event's active, unexpired hold at
-- the booked venue; converted_hold_id is that hold's id, or null.
--
-- Locks: the event `for update`, then (approval only) the venue `for no key
-- update`, then the booking `for update` -- event before venue as 030 and 040
-- take them, and booking last as 031 does. The venue lock is place_venue_hold's
-- (040), not the `for share` 030 foresaw: `for share` would let two approvals
-- at one venue run side by side, each seeing the other still pending, and both
-- pass the re-check. `for no key update` makes them, and any hold or block
-- being placed there, take turns; a create_booking_request's `for share` waits
-- too. A rejection frees nothing, so it takes no venue lock (031's reasoning).
--
-- Then the requests being marked, in id order. Only an approval takes them,
-- and only under its venue lock, so two approvals never wait on each other's
-- rows. A withdrawal, rejection or cancellation of one of them locks that
-- request's own event and then the request, never this event, venue or
-- booking, so it can make this wait (or wait for it) but not both. Their
-- events are not locked: an event after a booking is the reverse of 031's
-- order and would deadlock with an approval of theirs at this venue.
--
-- Then the hold row. It is this event's own row, taken with the event already
-- locked for update, as every writer of an event's holds locks the event
-- first: place_venue_hold (040, for share) and release_event_arrangements
-- (067, for update) wait on the event lock. The expiry job (also run inside
-- place_venue_hold, after its venue lock) waits on nothing this function holds
-- but hold rows, so the two can only take turns on one hold; each guards on
-- 'active' and skips it if the other won.

create or replace function decide_booking_request(
  p_booking_id            uuid,
  p_caller                uuid,
  p_decision              text,
  p_reason                text default null,
  p_suggested_alternative text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_venue_id    uuid;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_booking     bookings;
  v_conflicts   jsonb;
  v_new_status  text;
  v_venue_name  text;
  v_marked_ids  uuid[] := '{}';
  v_converted_hold_id uuid;
begin
  -- 1. Only Venue Staff, as place_venue_hold (040) checks it. A null caller is
  --    refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can decide a booking request'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. The decision and what goes with it. A reason is required to reject, and
  --    is never recorded against an approval.
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'the decision must be approve or reject, got %', coalesce(p_decision, 'none')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'reject' and (p_reason is null or length(btrim(p_reason)) = 0) then
    raise exception 'a reason is required to reject a booking request'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'approve' and (p_reason is not null or p_suggested_alternative is not null) then
    raise exception 'a reason or alternative is recorded only with a rejection'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 3. Which event and venue. Read without a lock, as 031 does: neither ever
  --    changes on a booking, and the locks that matter are taken next.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Lock the event, then read it, so its status and period hold until the
  --    write.
  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 5. Approval only: lock the venue (see above).
  if p_decision = 'approve' then
    select retired_at
      into v_retired_at
      from venues
     where id = v_venue_id
       for no key update;
  end if;

  -- 6. Lock the booking and read its status as it is now.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- A conflicting request is still open (see the section header).
  if v_booking.status::text not in ('pending', 'conflicting') then
    raise exception 'booking request % is %, and only a pending or conflicting request can be decided',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  if p_decision = 'approve' then
    -- 7. An event past approval and still live: the statuses a venue can be
    --    requested for (create_booking_request, step 3).
    if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
      raise exception 'event request % has status %, and a venue can only be booked for an approved, safety-checked or confirmed event',
        v_event_id, v_event.status
        using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
    end if;

    -- 8. The request is for the event's current period. One raised before the
    --    event moved would book the venue for the old one.
    if v_booking.starts_at is distinct from v_event.proposed_start
       or v_booking.ends_at is distinct from v_event.proposed_end then
      raise exception 'booking request % is for a period the event no longer has', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
    end if;

    if v_retired_at is not null then
      raise exception 'venue % is retired and cannot be booked', v_venue_id
        using errcode = 'PT409', hint = 'VENUE_RETIRED';
    end if;

    -- 9. The re-check, through the shared function, as create_booking_request
    --    step 7 asks it: padded, with this event's own holds left out.
    select coalesce(
             jsonb_agg(
               occupancy_conflict_json(
                 c.kind, c.id, c.event_request_id, c.event_name, c.reason,
                 c.starts_at, c.ends_at, c.occupied_starts_at, c.occupied_ends_at,
                 c.setup_minutes, c.turnaround_minutes
               )
               order by array_position(array['block', 'booking', 'hold'], c.kind), c.starts_at, c.id
             ),
             '[]'::jsonb
           )
      into v_conflicts
      from venue_occupancy_conflicts(v_venue_id, v_booking.starts_at, v_booking.ends_at, true,
                                     v_event_id) c;

    if jsonb_array_length(v_conflicts) > 0 then
      return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
    end if;

    v_new_status := 'approved';
  else
    v_new_status := 'rejected';
  end if;

  -- 10. The decision, guarded so it can only ever move an open request.
  --     Texts are trimmed; a blank alternative is none.
  update bookings
     set status                = v_new_status::booking_status,
         decided_by            = p_caller,
         decided_at            = now(),
         decision_reason       = btrim(p_reason),
         suggested_alternative = nullif(btrim(p_suggested_alternative), '')
   where id = p_booking_id
     and status in ('pending', 'conflicting')
  returning * into v_booking;

  if not found then
    raise exception 'booking request % changed while it was being decided', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 11. Tell the event's coordinator, in the same transaction. An event with
  --     no coordinator has nobody to tell.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select v_event.assigned_coordinator_id,
         'booking_request_' || v_new_status,
         v_booking.id,
         jsonb_build_object(
           'eventRequestId',       v_booking.event_request_id,
           'eventName',            v_event.event_name,
           'venueId',              v_booking.venue_id,
           'venueName',            v_venue_name,
           'startsAt',             v_booking.starts_at,
           'endsAt',               v_booking.ends_at,
           'decidedAt',            v_booking.decided_at,
           'reason',               v_booking.decision_reason,
           'suggestedAlternative', v_booking.suggested_alternative
         )
   where v_event.assigned_coordinator_id is not null;

  if v_new_status = 'rejected' then
    return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking));
  end if;

  -- 12. Approval only: lock the other events' pending requests that overlap
  --     this one's occupied period, in id order (see the section header), and
  --     mark them conflicting. The venue lock keeps a new request from being
  --     raised here meanwhile, so the set cannot grow before the update.
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_marked_ids
    from (
      select b.id
        from bookings b
       where b.id in (select o.id
                        from pending_request_overlaps(v_booking.venue_id, v_booking.starts_at,
                                                      v_booking.ends_at, v_event_id) o)
         and b.status = 'pending'
       order by b.id
         for update
    ) locked;

  update bookings
     set status = 'conflicting'
   where id = any (v_marked_ids)
     and status = 'pending';

  -- Each coordinator is told which approval their request now clashes with.
  -- Their events are read, not locked (see the section header).
  insert into notifications (recipient_id, type, booking_id, payload)
  select er.assigned_coordinator_id,
         'booking_request_conflicting',
         b.id,
         jsonb_build_object(
           'eventRequestId',         b.event_request_id,
           'eventName',              er.event_name,
           'venueId',                b.venue_id,
           'venueName',              v_venue_name,
           'startsAt',               b.starts_at,
           'endsAt',                 b.ends_at,
           'approvedBookingId',      v_booking.id,
           'approvedEventRequestId', v_booking.event_request_id,
           'approvedEventName',      v_event.event_name,
           'approvedStartsAt',       v_booking.starts_at,
           'approvedEndsAt',         v_booking.ends_at
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_marked_ids)
     and er.assigned_coordinator_id is not null
   order by b.id;

  -- 13. Approval only: this event's own hold at this venue becomes converted,
  --     if it is still active and unexpired. A hold past its expiry is not a
  --     booking and never was one here; the expiry job records it as expired.
  --     Holds at the event's other venues and other events' holds are not
  --     touched. No hold, nothing to convert. The update takes the row lock.
  update venue_holds
     set status               = 'converted',
         converted_at         = now(),
         converted_booking_id = v_booking.id
   where event_request_id = v_event_id
     and venue_id = v_booking.venue_id
     and status = 'active'
     and expires_at > now()
  returning id into v_converted_hold_id;

  return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking),
                            'marked_conflicting', to_jsonb(v_marked_ids),
                            'converted_hold_id', v_converted_hold_id);
end;
$$;

-- As in 031: it trusts p_caller to be who the API authenticated, so only the
-- API should reach this. Nothing is granted.
revoke execute on function decide_booking_request(uuid, uuid, text, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. withdraw_booking_request (031, conflicting ones too)
-- ---------------------------------------------------------------------
-- A conflicting request is the coordinator's to withdraw, as a pending one
-- is. 031's function otherwise word for word; the refusal keeps its hint.

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

  if v_booking.status not in ('pending', 'conflicting') then
    raise exception 'booking request % is %, and only a pending or conflicting request can be withdrawn',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  -- 5. The change, guarded so it can only ever move an open request.
  update bookings
     set status = 'withdrawn'
   where id = p_booking_id
     and status in ('pending', 'conflicting')
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

-- As in 031: only the API should reach this. Nothing is granted.
revoke execute on function withdraw_booking_request(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 8. create_booking_request (051, steps 3 and 6)
-- ---------------------------------------------------------------------
-- 051's function word for word except two steps. Step 3: the safety statuses
-- join approved and confirmed, the same statuses approval accepts. Step 6: a
-- conflicting request is still the event's live request at that venue, so the
-- coordinator withdraws it before requesting the venue again. Same signature,
-- so `create or replace` replaces it.

create or replace function create_booking_request(
  p_event_request_id   uuid,
  p_venue_id           uuid,
  p_requested_by       uuid,
  p_room_layout_code   text    default null,
  p_setup_notes        text    default null,
  p_suitability        jsonb   default null,
  p_confirm_unsuitable boolean default false,
  p_expected_attendance integer default null
)
returns jsonb
language plpgsql
as $$
declare
  v_event           event_requests;
  v_retired_at      timestamptz;
  v_existing_id     uuid;
  v_existing_status booking_status;
  v_conflicts       jsonb;
  v_suitable        boolean;
  v_booking         bookings;
begin
  -- 1. Lock the event, then read it, so nothing can change the row between
  --    the checks below and the insert that relies on them.
  select *
    into v_event
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- 2. Only the assigned coordinator. A null caller is refused explicitly:
  --    `is distinct from` would otherwise let a null caller match an event with
  --    no coordinator (see 018).
  if p_requested_by is null
     or v_event.assigned_coordinator_id is distinct from p_requested_by then
    raise exception 'only the coordinator assigned to event request % can request a venue for it',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 3. Only an event past approval and still live: approved, in or through
  --    the safety check, or confirmed. Compared as text, as 062 explains.
  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be requested for an approved, safety-checked or confirmed event',
      p_event_request_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- The period is the event's own, never the caller's. A null bound would make
  -- the overlap queries below match nothing and let the request through.
  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'event request % has no proposed start and end', p_event_request_id
      using errcode = 'PT409', hint = 'EVENT_DATES_MISSING';
  end if;

  -- The API always sends the result it computed. A missing one is a fault in
  -- the caller, not something to default to "suitable".
  if p_suitability is null or jsonb_typeof(p_suitability -> 'suitable') is distinct from 'boolean' then
    raise exception 'a suitability result with a boolean "suitable" is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- SCRUM-525 AC2: the request's own expected attendance, at least 1. The
  -- API always sends one, defaulting to the event's, so a missing one is a
  -- fault in the caller. Checked after the event lookup, so an unknown event
  -- is still P0002.
  if p_expected_attendance is null or p_expected_attendance < 1 then
    raise exception 'an expected attendance of at least 1 is required, got %',
      coalesce(p_expected_attendance::text, 'none')
      using errcode = 'invalid_parameter_value';
  end if;

  -- A venue cannot be for more people than the event expects; equal is fine.
  -- Checked here, at request time only (see 051's header).
  if v_event.expected_attendance is not null
     and p_expected_attendance > v_event.expected_attendance then
    raise exception 'an expected attendance of at most the event''s (%) is required, got %',
      v_event.expected_attendance, p_expected_attendance
      using errcode = 'invalid_parameter_value';
  end if;

  -- 4. Lock the venue, "for share" (see 051's header). A block being created
  --    over it, or the venue being retired, makes this wait; the reads below
  --    then see whatever that transaction committed.
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for share;

  if not found then
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 5. A retired venue cannot be requested.
  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be requested', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 6. One live request per event AT THIS VENUE (SCRUM-525 AC1). Pending,
  --    conflicting and approved count, and so does a booking flagged for
  --    review: it still holds this venue until it is resolved (SCRUM-266), but
  --    it no longer stops the event requesting another venue. Rejected,
  --    withdrawn and cancelled ones free the venue. A flagged one is named in
  --    preference, because it is the one the coordinator has to act on. Under
  --    the event lock, so a request for this venue that is committing now is
  --    already visible.
  select b.id, b.status
    into v_existing_id, v_existing_status
    from bookings b
   where b.event_request_id = p_event_request_id
     and b.venue_id = p_venue_id
     and b.status in ('pending', 'conflicting', 'approved', 'flagged_for_review')
   order by (b.status = 'flagged_for_review') desc, b.created_at, b.id
   limit 1;

  if v_existing_id is not null then
    if v_existing_status = 'flagged_for_review' then
      raise exception 'event request % has a booking at venue % flagged for review, which must be resolved first',
        p_event_request_id, p_venue_id
        using errcode = 'PT409', hint = 'BOOKING_FLAGGED_FOR_REVIEW', detail = v_existing_id::text;
    end if;

    raise exception 'event request % already has a % booking request for venue %',
      p_event_request_id, v_existing_status, p_venue_id
      using errcode = 'PT409', hint = 'BOOKING_REQUEST_EXISTS', detail = v_existing_id::text;
  end if;

  -- 7. The period, through the shared function (SCRUM-484), holds included
  --    (SCRUM-491).
  --
  --    One call answers every kind: active blocks, compared raw; occupying
  --    bookings (approved and flagged_for_review) and other events' active,
  --    unexpired holds, both padded with the venue's setup and turnaround.
  --    p_pad_requested = true pads the event's own period too, so at a 30/45
  --    venue an event can start at 13:15 after a booking ending 12:00, and
  --    not at 13:14. Touching is clear (AC5).
  --
  --    SCRUM-491 (AC5): p_event_request_id is the fifth argument, so this
  --    event's own holds are left out -- a hold never blocks the request it
  --    was placed for -- while every other event's hold conflicts.
  --
  --    Each row is built by occupancy_conflict_json(), which keeps 030's keys
  --    for blocks and bookings, plus the occupied period and the venue's
  --    minutes (AC7). Ordered blocks first, then bookings, then holds, each
  --    soonest first, so 030's order for the first two kinds is kept.
  --
  --    The check is for this venue only. Step 6 has already refused a live
  --    booking of this event here. Its bookings at other venues are not at
  --    this venue, so they never conflict (SCRUM-525 AC4); every other
  --    event's occupying booking here still does.
  select coalesce(
           jsonb_agg(
             occupancy_conflict_json(
               c.kind, c.id, c.event_request_id, c.event_name, c.reason,
               c.starts_at, c.ends_at, c.occupied_starts_at, c.occupied_ends_at,
               c.setup_minutes, c.turnaround_minutes
             )
             order by array_position(array['block', 'booking', 'hold'], c.kind), c.starts_at, c.id
           ),
           '[]'::jsonb
         )
    into v_conflicts
    from venue_occupancy_conflicts(p_venue_id, v_event.proposed_start, v_event.proposed_end, true,
                                   p_event_request_id) c;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. The suitability gate. A venue that is not suitable is requested only
  --    when the coordinator confirmed it, and the confirmation is recorded.
  v_suitable := (p_suitability ->> 'suitable')::boolean;

  if not v_suitable and not coalesce(p_confirm_unsuitable, false) then
    return jsonb_build_object('outcome', 'suitability_confirmation_required', 'suitability', p_suitability);
  end if;

  -- >>> SCRUM-174 inserts its step HERE: notify the relevant Venue Staff that
  -- >>> a request was submitted. It must be in this transaction, so a rolled
  -- >>> back request notifies nobody.

  -- 9. Insert. The status is written here and not taken from the caller or the
  --    column default, so a request is pending by construction.
  --    expected_attendance is the request's own value, not the event's
  --    (SCRUM-525 AC2).
  insert into bookings (
    venue_id, event_request_id, starts_at, ends_at, status,
    requested_by, room_layout_code, venue_requirements, accessibility_requirements,
    setup_notes, suitability_result, suitability_overridden, expected_attendance
  )
  values (
    p_venue_id, p_event_request_id, v_event.proposed_start, v_event.proposed_end, 'pending',
    p_requested_by, p_room_layout_code, v_event.venue_requirements, v_event.accessibility_requirements,
    p_setup_notes, p_suitability, not v_suitable, p_expected_attendance
  )
  returning * into v_booking;

  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(v_booking));
end;
$$;

-- As in 030, 033, 040 and 051: only the API should reach this. Nothing is granted.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer)
  from public, anon, authenticated;


notify pgrst, 'reload schema';
