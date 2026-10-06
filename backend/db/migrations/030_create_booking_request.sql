-- 030_create_booking_request.sql
-- SCRUM-252: Create a venue booking request
--
-- Part of SCRUM-243 "Submit a Venue Booking Request". Run this once in the
-- Supabase SQL Editor, after 028_booking_status_default_pending.sql and after
-- 014_coordinator_assignment.sql (it reads event_requests.assigned_coordinator_id).
-- Safe to re-run: every column and constraint is guarded and the function is
-- `create or replace`.
--
-- A venue booking request is a bookings row in the 'pending' status (027). This
-- migration gives that row somewhere to keep what only a request carries, and
-- adds the one function that creates it.
--
--   * bookings gains requested_by, room_layout_code, venue_requirements,
--     accessibility_requirements, setup_notes, suitability_result and
--     suitability_overridden.
--   * create_booking_request() checks and writes in ONE transaction, after
--     taking the locks below, and answers with an outcome.
--
-- ---------------------------------------------------------------------
-- The locking protocol (from the SCRUM-17 migrations 012-015)
-- ---------------------------------------------------------------------
-- 013's header, "KNOWN GAP", says: nothing inserted bookings yet, so a booking
-- created while a block was being created was not guarded; "whoever writes the
-- booking writer should take 'for share' on the venue row, which conflicts with
-- the 'for no key update' this function holds". This is that writer.
--
-- A foreign-key insert takes only `for key share` on the venue, which does not
-- conflict with create_venue_block's `for no key update`, so without the
-- explicit lock a request could slip in beside a block being created over the
-- same period. `for share` conflicts with that lock, with update_venue_block's
-- and with retire_venue's UPDATE of the venue row, and not with another
-- request's `for share`. So two requests for different events at one venue run
-- side by side, and a block or a retirement takes its turn with them.
--
-- The venue lock alone does not stop one event raising two requests at two
-- venues at once: those take different venue locks. So the event row is locked
-- first, `for update`, as change_event_request_status (021) and
-- reassign_event_request (018) lock it. Two requests for the same event take
-- turns on it, and the second then sees the first's pending row.
--
-- Lock order: the event row, then the venue row. create_venue_block locks the
-- venue and then bookings, never an event row, so no pair can wait on each
-- other. A later writer that locks both must keep this order.
--
-- Approving a pending request (a later story) creates the approved hold that
-- blocks and conflict checks look at. It must take `for share` on the venue and
-- repeat the conflict check, because a request that was clear when it was
-- raised may not be by then: block creation and conflict detection only look at
-- approved bookings, so a pending row neither blocks a period nor is flagged
-- by one.
--
-- ---------------------------------------------------------------------
-- Errors, and what the service turns them into (bookingRequestService.js)
-- ---------------------------------------------------------------------
--   no_data_found (P0002)       no such event, or no such venue    -> NotFoundError
--   insufficient_privilege      the caller is not the event's
--     (42501)                   assigned coordinator               -> ForbiddenError
--   22023 invalid_parameter_value  no suitability result given    -> ValidationError
--   PT409, hint:                                                   -> ConflictError
--     EVENT_NOT_BOOKABLE        the event is not approved or confirmed
--     EVENT_DATES_MISSING       the event has no proposed start and end
--     VENUE_RETIRED             the venue is retired
--     BOOKING_REQUEST_EXISTS    the event already has a pending or approved
--                               booking; its id is in DETAIL
--     BOOKING_FLAGGED_FOR_REVIEW  the event has a booking flagged for review
--                               (resolved through SCRUM-266); id in DETAIL
--
-- Two answers are outcomes, not errors, so the lists arrive as structured
-- jsonb rather than prose, as in 013:
--   {outcome: 'conflict', conflicts}                      nothing written
--   {outcome: 'suitability_confirmation_required', ...}   nothing written
--   {outcome: 'created', booking}
--
-- The checks run in that order: refusals first, then the period, then the
-- suitability gate. A conflict is therefore reported even when the suitability
-- result is also a failure.
--
-- Suitability (N10, SCRUM-188) is computed by the API and passed in as
-- p_suitability, {suitable: boolean, criteria: [...]}. The function does not
-- compute it. It stores the result with the request, and if the venue is not
-- suitable it requires p_confirm_unsuitable. Because it trusts that argument,
-- and trusts p_requested_by to be who the API authenticated, execute is revoked
-- from public, anon and authenticated, as for flag_bookings_for_block (014).
-- The API calls with the secret key, which keeps its own grant.
--
-- Not done here, and why:
--   * No notification. SCRUM-174 owns the booking notification types, payloads
--     and the choice of which Venue Staff to notify (SCRUM-210 to SCRUM-216,
--     not built). 014 allows only the 'booking_flagged' type, and widening that
--     check is theirs to do. The marked step in the function is where the
--     insert belongs.
--   * No unique index on bookings (event_request_id) for active statuses. 009's
--     provisional table may already hold several approved bookings for one
--     event, and an index would refuse to build over them.


-- ---------------------------------------------------------------------
-- 1. Bookings gain the request columns (extends 009, 011 and 014)
-- ---------------------------------------------------------------------
-- requested_by is nullable for the reason 003 and 011 give for *_by columns:
-- NULL is the honest record of "written outside the app", and it is how every
-- booking that exists today reads.
--
-- venue_requirements and accessibility_requirements are copied from the event
-- when the request is made, so Venue Staff read what was asked for then, even
-- if the event is edited afterwards. room_layout_code is the layout the
-- Coordinator picked; the event has no layout of its own.
--
-- suitability_result is the N10 result the request was made with, and
-- suitability_overridden says the Coordinator confirmed despite a failure, so
-- Venue Staff can see both (SCRUM-188, last criterion).

alter table bookings
  add column if not exists requested_by                uuid references auth.users (id),
  add column if not exists room_layout_code            text references room_layouts (code) on delete restrict,
  add column if not exists venue_requirements          text,
  add column if not exists accessibility_requirements  text,
  add column if not exists setup_notes                 text,
  add column if not exists suitability_result          jsonb,
  add column if not exists suitability_overridden      boolean not null default false;

-- Mirrors venue_blocks_notes_length in 011. `add constraint` has no
-- `if not exists`, so the guard reads pg_constraint, as 014 does.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_setup_notes_length'
  ) then
    alter table bookings
      add constraint bookings_setup_notes_length check (
        setup_notes is null or length(setup_notes) <= 1000
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Creating a request
-- ---------------------------------------------------------------------

create or replace function create_booking_request(
  p_event_request_id   uuid,
  p_venue_id           uuid,
  p_requested_by       uuid,
  p_room_layout_code   text    default null,
  p_setup_notes        text    default null,
  p_suitability        jsonb   default null,
  p_confirm_unsuitable boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_event           event_requests;
  v_retired_at      timestamptz;
  v_existing_id     uuid;
  v_existing_status booking_status;
  v_blocks          jsonb;
  v_bookings        jsonb;
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

  -- 3. Only an approved or confirmed event.
  if v_event.status not in ('approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be requested for an approved or confirmed event',
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

  -- 4. Lock the venue, "for share" (see the header). A block being created
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

  -- 6. One live request per event. Pending and approved count, and so does a
  --    booking flagged for review: it still holds the event's venue until it
  --    is resolved (SCRUM-266). A flagged one is named in preference, because
  --    it is the one the coordinator has to act on. Under the event lock, so a
  --    request for another venue that is committing now is already visible.
  select b.id, b.status
    into v_existing_id, v_existing_status
    from bookings b
   where b.event_request_id = p_event_request_id
     and b.status in ('pending', 'approved', 'flagged_for_review')
   order by (b.status = 'flagged_for_review') desc, b.created_at, b.id
   limit 1;

  if v_existing_id is not null then
    if v_existing_status = 'flagged_for_review' then
      raise exception 'event request % has a booking flagged for review, which must be resolved first',
        p_event_request_id
        using errcode = 'PT409', hint = 'BOOKING_FLAGGED_FOR_REVIEW', detail = v_existing_id::text;
    end if;

    raise exception 'event request % already has a % booking request', p_event_request_id, v_existing_status
      using errcode = 'PT409', hint = 'BOOKING_REQUEST_EXISTS', detail = v_existing_id::text;
  end if;

  -- 7. The period: active blocks, then approved bookings, half-open as in 011
  --    and 013 so a period that only touches at an edge is clear.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'kind',      'block',
               'block_id',  vb.id,
               'starts_at', vb.starts_at,
               'ends_at',   vb.ends_at,
               'reason',    vb.reason
             )
             order by vb.starts_at, vb.id
           ),
           '[]'::jsonb
         )
    into v_blocks
    from venue_blocks vb
   where vb.venue_id = p_venue_id
     and vb.removed_at is null
     and vb.starts_at < v_event.proposed_end
     and vb.ends_at > v_event.proposed_start;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'kind',             'booking',
               'booking_id',       c.booking_id,
               'event_request_id', c.event_request_id,
               'event_name',       c.event_name,
               'starts_at',        c.starts_at,
               'ends_at',          c.ends_at
             )
             order by c.starts_at, c.booking_id
           ),
           '[]'::jsonb
         )
    into v_bookings
    from venue_block_booking_conflicts(p_venue_id, v_event.proposed_start, v_event.proposed_end) c;

  v_conflicts := v_blocks || v_bookings;

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
  insert into bookings (
    venue_id, event_request_id, starts_at, ends_at, status,
    requested_by, room_layout_code, venue_requirements, accessibility_requirements,
    setup_notes, suitability_result, suitability_overridden
  )
  values (
    p_venue_id, p_event_request_id, v_event.proposed_start, v_event.proposed_end, 'pending',
    p_requested_by, p_room_layout_code, v_event.venue_requirements, v_event.accessibility_requirements,
    p_setup_notes, p_suitability, not v_suitable
  )
  returning * into v_booking;

  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(v_booking));
end;
$$;

-- See the header: only the API should reach this.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;
