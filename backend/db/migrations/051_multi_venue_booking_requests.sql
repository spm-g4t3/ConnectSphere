-- ---------------------------------------------------------------------------
-- 051_multi_venue_booking_requests.sql
-- SCRUM-525: Several venue requests for one event, each with its own attendance
--
-- Part of SCRUM-525 "Request Several Venues for One Event - Event
-- Coordinator". Run this once in the Supabase SQL Editor, after
-- 049_filter_cancelled_equipment_from_cancellation_preview.sql (it changes
-- create_booking_request as 040 left it; nothing in 042-049 redefines it).
-- It is numbered 051 because 041 (041_lead_assignment.sql) and 050 are
-- already taken on other branches, and two files with one number would leave
-- the run order to chance.
--
-- Safe to re-run:
--   * the column is `add column if not exists`;
--   * the check constraint is dropped by name and added again;
--   * the backfill writes only rows whose expected_attendance is still null,
--     so a booking that already has its own number (a request made after 051,
--     or a row backfilled by an earlier run) is never overwritten;
--   * the old 7-argument signature is dropped `if exists`, and the function
--     is `create or replace` on the 8-argument one;
--   * revoke and the schema reload are idempotent.
--
-- What it serves:
--   AC1  An event may hold one live request (pending, approved or flagged for
--        review) per venue, and several venues. The same venue again is
--        refused, naming the live request in DETAIL. A booking flagged for
--        review blocks only its own venue: the event can still request
--        another one.
--   AC2  Each request stores its own expected attendance, at least 1, in
--        bookings.expected_attendance. The API always sends one.
--   AC4  An event's bookings at different venues never conflict with each
--        other. Every other conflict rule -- blocks, other events' occupying
--        bookings, other events' active holds, the padded period -- is
--        unchanged.
--   AC7  Existing bookings take their event's attendance (the backfill).
--   AC8  Who raised each request and when are already stored, per booking:
--        requested_by (030) and created_at (009). Nothing to add.
--
-- Decisions, and why:
--
--   * The per-venue rule lives in the function, under the event's `for
--     update` lock, and there is no partial unique index on (event, venue).
--     030 (its "Not done here" list) avoided an index for the same reason:
--     009's provisional data may already hold duplicates, and an index would
--     refuse to build over them. The lock is enough: two requests for one
--     event take turns on the event row (step 1), so the second always sees
--     the first's pending row in step 6, whichever venue either is for.
--
--   * bookings.expected_attendance is nullable, with a check `> 0`. Every row
--     this function writes sets it, because the function refuses a missing
--     one. An old booking whose event has no attendance (001 lets it be null)
--     has nothing honest to copy and stays null; a 0 default would only fail
--     the check. Where it is null, the recheck falls back to the event's
--     value (SCRUM-525 ST3).
--
--   * p_expected_attendance is the 8th parameter, `default null`. Postgres
--     requires every parameter after a defaulted one to have a default too
--     (p_room_layout_code onwards have), and the default keeps positional
--     7-argument callers resolving to this function. The body refuses null,
--     so the value is still required: a caller that leaves it out gets 22023,
--     not a booking without an attendance.
--
--   * The old 7-argument signature is dropped first. `create or replace` with
--     a new parameter list makes a second function beside the old one, and
--     PostgREST then refuses the call as ambiguous (PGRST203). 040 dropped
--     venue_occupancy_conflicts' old signature for the same reason.
--
--   * Steps 6, 7 and 9 change; every other step is 040's word for word,
--     including the lock order (the event `for update`, then the venue `for
--     share`). See the comments on the changed steps below.
--
-- Before running it in Supabase, two read-only checks:
--   select event_request_id, venue_id, count(*)
--     from bookings
--    where status in ('pending', 'approved', 'flagged_for_review')
--    group by 1, 2 having count(*) > 1;            -- expect no rows
--   select count(*)
--     from bookings b join event_requests e on e.id = b.event_request_id
--    where e.expected_attendance is null;          -- these stay null
-- After: pg_proc has exactly one create_booking_request, and one real
-- request succeeds.
--
-- SQLSTATEs create_booking_request raises:
--   42501  the caller is not the event's assigned coordinator, or is null  403
--   P0002  no such event, or no such venue                                404
--   PT409  EVENT_NOT_BOOKABLE, EVENT_DATES_MISSING, VENUE_RETIRED,
--          BOOKING_REQUEST_EXISTS or BOOKING_FLAGGED_FOR_REVIEW (the live
--          booking of this event at this venue; its id in DETAIL)        409
--   22023  no suitability result with a boolean "suitable"               400
--   22023  a missing expected attendance, or one below 1 (SCRUM-525)     400
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. Bookings gain their own expected attendance (AC2)
-- ---------------------------------------------------------------------
-- Nullable, for the old bookings whose event has none (see the header).
-- `add constraint` has no `if not exists`, so the constraint is dropped by
-- name and added again, as 034 and 040 do.

alter table bookings add column if not exists expected_attendance integer;

alter table bookings drop constraint if exists bookings_expected_attendance_positive;
alter table bookings
  add constraint bookings_expected_attendance_positive
  check (expected_attendance is null or expected_attendance > 0);


-- ---------------------------------------------------------------------
-- 2. Existing bookings take their event's attendance (AC7)
-- ---------------------------------------------------------------------
-- Only rows still null, so a re-run never overwrites a booking's own value.
-- An event without an attendance leaves its bookings null.

update bookings b
   set expected_attendance = e.expected_attendance
  from event_requests e
 where e.id = b.event_request_id
   and b.expected_attendance is null
   and e.expected_attendance is not null;


-- ---------------------------------------------------------------------
-- 3. Creating a booking request (040, steps 6, 7 and 9 changed)
-- ---------------------------------------------------------------------
-- The 7-argument signature goes first, so only one create_booking_request
-- exists for PostgREST to find (PGRST203).

drop function if exists create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean);

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

  -- SCRUM-525 AC2: the request's own expected attendance, at least 1. The
  -- API always sends one, defaulting to the event's, so a missing one is a
  -- fault in the caller. Checked after the event lookup, so an unknown event
  -- is still P0002.
  if p_expected_attendance is null or p_expected_attendance < 1 then
    raise exception 'an expected attendance of at least 1 is required, got %',
      coalesce(p_expected_attendance::text, 'none')
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

  -- 6. One live request per event AT THIS VENUE (SCRUM-525 AC1). Pending and
  --    approved count, and so does a booking flagged for review: it still
  --    holds this venue until it is resolved (SCRUM-266), but it no longer
  --    stops the event requesting another venue. Rejected, withdrawn and
  --    cancelled ones free the venue. A flagged one is named in preference,
  --    because it is the one the coordinator has to act on. Under the event
  --    lock, so a request for this venue that is committing now is already
  --    visible.
  select b.id, b.status
    into v_existing_id, v_existing_status
    from bookings b
   where b.event_request_id = p_event_request_id
     and b.venue_id = p_venue_id
     and b.status in ('pending', 'approved', 'flagged_for_review')
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

-- As in 030, 033 and 040: only the API should reach this. Nothing is granted.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer)
  from public, anon, authenticated;


notify pgrst, 'reload schema';
