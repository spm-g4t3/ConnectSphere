-- Venue Staff see every booking flagged for review, each with what flagged it,
-- so they can reinstate (076) or cancel (077) it; an event's coordinator sees
-- that event's and can request a venue to replace one, which approval then
-- resolves. Two more review reasons are allowed for the event and venue edits
-- that will flag bookings later.


-- ---------------------------------------------------------------------
-- 1. Review reasons (extends 071)
-- ---------------------------------------------------------------------
-- 071's list with event_changed and venue_details_changed. Nothing sets them
-- yet. Dropped and re-added by name, as 034 does, so a re-run replaces it.

alter table bookings
  drop constraint if exists bookings_review_reason_known;

alter table bookings
  add constraint bookings_review_reason_known
  check (review_reason in ('setup_or_turnaround_changed', 'safety_review',
                           'event_changed', 'venue_details_changed'));




-- ---------------------------------------------------------------------
-- 2. bookings.replaces_booking_id
-- ---------------------------------------------------------------------
-- A coordinator resolves a flag by requesting another venue in its place. The
-- request names the flagged booking, so approving it can cancel the flag
-- (section 6) and the flagged lists (section 3) and the Venue Staff queue
-- (section 7) can show it. Added first
-- because section 3's SQL function is checked against it when created.

alter table bookings
  add column if not exists replaces_booking_id uuid references bookings (id);

create index if not exists idx_bookings_replaces_booking
  on bookings (replaces_booking_id)
  where replaces_booking_id is not null;


-- ---------------------------------------------------------------------
-- 3. flagged_bookings_json and list_flagged_bookings
-- ---------------------------------------------------------------------
-- list_pending_booking_requests' (066) shape, for flagged bookings. A safety
-- flag keeps the block that flagged the booking before it (071), so the block
-- columns are read whatever the review reason is. Oldest flag first; a
-- booking flagged before 014 has no flag time, so it is the oldest.
-- `reinstatable` is a hint for the screen only: 076 enforces the rule.
-- `replacement_requests` are the live requests raised to replace the booking,
-- oldest first. Venue Staff see them too, so they do not reinstate a booking
-- the coordinator is already replacing. A rejected or withdrawn one is no
-- longer an answer to the flag.
--
-- The shape is built once, here, for Venue Staff's list (every event) and the
-- coordinator's (one event, section 4). It checks no caller, so only the two
-- functions that do reach it.

create or replace function flagged_bookings_json(p_event_request_id uuid)
returns jsonb
language sql
stable
as $$
  with flagged as (
    select b.*,
           er.event_name,
           er.status::text                      as event_status,
           er.proposed_start                    as event_starts_at,
           er.proposed_end                      as event_ends_at,
           er.assigned_coordinator_id,
           v.name                               as venue_name,
           v.location                           as venue_location,
           vb.reason::text                      as block_reason,
           vb.notes                             as block_notes,
           vb.starts_at                         as block_starts_at,
           vb.ends_at                           as block_ends_at,
           vb.removed_at                        as block_removed_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 v.setup_minutes, v.turnaround_minutes) as occupied
      from bookings b
      join event_requests er    on er.id = b.event_request_id
      join venues v             on v.id  = b.venue_id
      left join venue_blocks vb on vb.id = b.review_block_id
     where b.status = 'flagged_for_review'
       and (p_event_request_id is null or b.event_request_id = p_event_request_id)
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',                      f.id,
               'event_request_id',        f.event_request_id,
               'venue_id',                f.venue_id,
               'starts_at',               f.starts_at,
               'ends_at',                 f.ends_at,
               'occupied_starts_at',      lower(f.occupied),
               'occupied_ends_at',        upper(f.occupied),
               'flagged_at',              f.flagged_at,
               'flagged_by',              f.flagged_by,
               'review_reason',           f.review_reason,
               'event_name',              f.event_name,
               'event_status',            f.event_status,
               'event_starts_at',         f.event_starts_at,
               'event_ends_at',           f.event_ends_at,
               'assigned_coordinator_id', f.assigned_coordinator_id,
               'venue_name',              f.venue_name,
               'venue_location',          f.venue_location,
               'block_id',                f.review_block_id,
               'block_reason',            f.block_reason,
               'block_notes',             f.block_notes,
               'block_starts_at',         f.block_starts_at,
               'block_ends_at',           f.block_ends_at,
               'block_removed_at',        f.block_removed_at,
               'reinstatable',            f.review_reason is distinct from 'safety_review',
               'replacement_requests',    coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',         r.id,
                            'venue_id',   r.venue_id,
                            'venue_name', rv.name,
                            'status',     r.status,
                            'starts_at',  r.starts_at,
                            'ends_at',    r.ends_at,
                            'created_at', r.created_at
                          )
                          order by r.created_at, r.id
                        )
                   from bookings r
                   join venues rv on rv.id = r.venue_id
                  where r.replaces_booking_id = f.id
                    and r.status in ('pending', 'conflicting')
               ), '[]'::jsonb)
             )
             order by f.flagged_at nulls first, f.created_at, f.id
           ),
           '[]'::jsonb
         )
    from flagged f;
$$;

-- Null reads every event, so nothing but the two callers below may run it.
revoke execute on function flagged_bookings_json(uuid)
  from public, anon, authenticated;

create or replace function list_flagged_bookings(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as 076 checks it. A null caller is refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view flagged bookings'
      using errcode = 'insufficient_privilege';
  end if;

  return flagged_bookings_json(null);
end;
$$;

-- As 066: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function list_flagged_bookings(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. list_event_flagged_bookings
-- ---------------------------------------------------------------------
-- One event's flagged bookings, for its assigned coordinator, in section 3's
-- shape and order.

create or replace function list_event_flagged_bookings(
  p_caller           uuid,
  p_event_request_id uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_coordinator_id uuid;
begin
  -- A null caller is refused before the event is looked up (see 018).
  if p_caller is null then
    raise exception 'only the assigned coordinator can view an event''s flagged bookings'
      using errcode = 'insufficient_privilege';
  end if;

  select er.assigned_coordinator_id
    into v_coordinator_id
    from event_requests er
   where er.id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_coordinator_id is distinct from p_caller then
    raise exception 'only the coordinator assigned to event request % can view its flagged bookings',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  return flagged_bookings_json(p_event_request_id);
end;
$$;

-- As 066: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function list_event_flagged_bookings(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. create_booking_request (066, with p_replaces_booking_id)
-- ---------------------------------------------------------------------
-- 066's function word for word except step 3a: a request may name a flagged
-- booking of the same event that it replaces. The event lock covers the
-- check, because reinstating (076) and cancelling (077) lock the event first.
-- A new parameter is a new signature, so 066's is dropped first.

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

  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(v_booking));
end;
$$;

-- As in 030, 033, 040, 051 and 066: only the API should reach this. Nothing is granted.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. decide_booking_request (066, step 14)
-- ---------------------------------------------------------------------
-- 066's function word for word plus step 14: approving a replacement cancels
-- the flagged booking it names, records the resolution as 'replaced' and
-- notifies as 076 does. 076's trigger already allows flagged_for_review ->
-- cancelled. Rejecting changes nothing on the flagged booking. Same signature, so `create or replace`.

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
  v_replaced    bookings;
  v_resolution_id uuid;
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

  -- 5. Approval only: lock the venue (see 066's section header).
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

  -- A conflicting request is still open (see 066's section header).
  if v_booking.status::text not in ('pending', 'conflicting') then
    raise exception 'booking request % is %, and only a pending or conflicting request can be decided',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  if p_decision = 'approve' then
    -- 7. An event past approval and still live: the statuses a venue can be
    --    requested for (create_booking_request, step 3).
    if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
      raise exception 'event request % has status %, and a venue can only be booked for an event that is approved, in or through the safety check, or confirmed',
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
  --     this one's occupied period, in id order (see 066's header), and
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
  -- Their events are read, not locked (see 066's section header).
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

  -- 14. SCRUM-266, approval only: the flagged booking this one replaces is
  --     cancelled, with the resolution recorded, as 077 records one. It is
  --     this event's (create_booking_request, step 3a), so the event lock
  --     covers it. Already reinstated or cancelled, it is left as it is.
  if v_booking.replaces_booking_id is not null then
    update bookings
       set status = 'cancelled'
     where id = v_booking.replaces_booking_id
       and event_request_id = v_event_id
       and status = 'flagged_for_review'
    returning * into v_replaced;

    -- The flag stays on a cancelled booking (077), so it is copied from there.
    if found then
      insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                       review_block_id, review_reason, flagged_at, flagged_by,
                                       replacement_booking_id)
      values (v_replaced.id, 'replaced', 'Replaced by an approved booking', p_caller,
              v_replaced.review_block_id, v_replaced.review_reason,
              v_replaced.flagged_at, v_replaced.flagged_by,
              v_booking.id)
      returning id into v_resolution_id;

      perform notify_flagged_booking_resolved(v_resolution_id, 'venue_staff');
    end if;
  end if;

  return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking),
                            'marked_conflicting', to_jsonb(v_marked_ids),
                            'converted_hold_id', v_converted_hold_id,
                            'replaced_booking_id', v_replaced.id);
end;
$$;

-- As in 031: it trusts p_caller to be who the API authenticated, so only the
-- API should reach this. Nothing is granted.
revoke execute on function decide_booking_request(uuid, uuid, text, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. list_pending_booking_requests (066, with `replaces`)
-- ---------------------------------------------------------------------
-- 066's function word for word plus `replaces`: the flagged booking a request
-- would replace, so Venue Staff do not reinstate that booking and then approve
-- its replacement, leaving the event two venues.

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
               ), '[]'::jsonb),
               -- Bookings only: a block or hold never marks a request
               -- conflicting. Flagged-for-review bookings are kept, because
               -- they still occupy the venue until the Coordinator decides.
               'conflicting_with', case when p.status::text = 'conflicting' then coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'booking_id',         c.id,
                            'event_request_id',   c.event_request_id,
                            'event_name',         c.event_name,
                            'starts_at',          c.starts_at,
                            'ends_at',            c.ends_at,
                            'occupied_starts_at', c.occupied_starts_at,
                            'occupied_ends_at',   c.occupied_ends_at
                          )
                          order by c.starts_at, c.id
                        )
                   from venue_occupancy_conflicts(p.venue_id, p.starts_at, p.ends_at, true,
                                                  p.event_request_id) c
                  where c.kind = 'booking'
               ), '[]'::jsonb) else '[]'::jsonb end,
               -- Null once the booking it names is no longer flagged: then
               -- approving this request leaves that booking alone (section 6).
               'replaces', (
                 select jsonb_build_object(
                          'booking_id', fb.id,
                          'venue_name', fv.name,
                          'starts_at',  fb.starts_at,
                          'ends_at',    fb.ends_at
                        )
                   from bookings fb
                   join venues fv on fv.id = fb.venue_id
                  where fb.id = p.replaces_booking_id
                    and fb.status = 'flagged_for_review'
               )
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


notify pgrst, 'reload schema';
