-- Every Venue Staff user is told when a coordinator submits a venue booking
-- request, so a new request is seen without watching the queue.


-- ---------------------------------------------------------------------
-- 1. Notification types (extends 076)
-- ---------------------------------------------------------------------
-- 076's list plus booking_request_submitted, added to the live constraint as
-- 076 does, so re-running this file never drops a type. A migration that
-- restates the list after this one must still include all of ours.

do $$
declare
  v_def   text;
  v_known text[] := '{}';
  v_ours  text[] := array[
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
    'event_submitted_for_safety_review',
    'booking_request_approved',
    'booking_request_rejected',
    'booking_request_conflicting',
    'flagged_booking_resolved',
    'booking_request_submitted'
  ];
  v_item  text;
begin
  select pg_get_constraintdef(c.oid)
    into v_def
    from pg_constraint c
   where c.conrelid = 'notifications'::regclass
     and c.conname = 'notifications_type_known';

  if v_def is not null then
    select coalesce(array_agg(t.m[1] order by t.ord), '{}')
      into v_known
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;

  foreach v_item in array v_ours loop
    if not v_item = any (v_known) then
      v_known := v_known || v_item;
    end if;
  end loop;

  alter table notifications drop constraint if exists notifications_type_known;

  execute format(
    'alter table notifications add constraint notifications_type_known check (type in (%s))',
    (select string_agg(quote_literal(x.item), ', ' order by x.ord)
       from unnest(v_known) with ordinality as x(item, ord))
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 2. A submitted-request notice names its booking
-- ---------------------------------------------------------------------
-- As 031 does for a withdrawal: the notice is about one booking request.

alter table notifications drop constraint if exists notifications_request_submitted_needs_booking;
alter table notifications
  add constraint notifications_request_submitted_needs_booking
  check (type <> 'booking_request_submitted' or booking_id is not null);


-- ---------------------------------------------------------------------
-- 3. create_booking_request (078, with step 10)
-- ---------------------------------------------------------------------
-- 078's function word for word plus step 10, which notifies Venue Staff once
-- the request is inserted. Same signature as 078; 066's older one is dropped
-- again, as 078 does, so a re-run on any database leaves one overload.

drop function if exists create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer);

create or replace function create_booking_request(
  p_event_request_id   uuid,
  p_venue_id           uuid,
  p_requested_by       uuid,
  p_room_layout_code   text    default null,
  p_setup_notes        text    default null,
  p_suitability        jsonb   default null,
  p_confirm_unsuitable boolean default false,
  p_expected_attendance integer default null,
  p_replaces_booking_id uuid    default null
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
  v_replaced        bookings;
  v_venue_name      text;
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
    raise exception 'event request % has status %, and a venue can only be requested for an event that is approved, in or through the safety check, or confirmed',
      p_event_request_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- The period is the event's own, never the caller's. A null bound would make
  -- the overlap queries below match nothing and let the request through.
  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'event request % has no proposed start and end', p_event_request_id
      using errcode = 'PT409', hint = 'EVENT_DATES_MISSING';
  end if;

  -- 3a. SCRUM-266: the booking this request replaces, if any, is one of this
  --     event's and is still flagged. Its status cannot change meanwhile:
  --     076 and 077 lock this event before they touch it.
  if p_replaces_booking_id is not null then
    select *
      into v_replaced
      from bookings
     where id = p_replaces_booking_id;

    if not found or v_replaced.event_request_id is distinct from p_event_request_id then
      raise exception 'booking % is not a booking of event request %',
        p_replaces_booking_id, p_event_request_id
        using errcode = 'PT409', hint = 'REPLACED_BOOKING_NOT_ON_EVENT';
    end if;

    if v_replaced.status::text <> 'flagged_for_review' then
      raise exception 'booking % is %, and only a booking flagged for review can be replaced',
        p_replaces_booking_id, v_replaced.status
        using errcode = 'PT409', hint = 'REPLACED_BOOKING_NOT_FLAGGED';
    end if;
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

  -- 9. Insert. The status is written here and not taken from the caller or the
  --    column default, so a request is pending by construction.
  --    expected_attendance is the request's own value, not the event's
  --    (SCRUM-525 AC2).
  insert into bookings (
    venue_id, event_request_id, starts_at, ends_at, status,
    requested_by, room_layout_code, venue_requirements, accessibility_requirements,
    setup_notes, suitability_result, suitability_overridden, expected_attendance,
    replaces_booking_id
  )
  values (
    p_venue_id, p_event_request_id, v_event.proposed_start, v_event.proposed_end, 'pending',
    p_requested_by, p_room_layout_code, v_event.venue_requirements, v_event.accessibility_requirements,
    p_setup_notes, p_suitability, not v_suitable, p_expected_attendance,
    p_replaces_booking_id
  )
  returning * into v_booking;

  -- 10. Tell every Venue Staff user, in the same transaction, so a rolled back
  --     request notifies nobody. A conflict or an unconfirmed unsuitable venue
  --     returned above without a request, so it notifies nobody either.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_request_submitted',
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

  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(v_booking));
end;
$$;

-- As in 030, 033, 040, 051, 066 and 078: only the API should reach this. Nothing is granted.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer, uuid)
  from public, anon, authenticated;
