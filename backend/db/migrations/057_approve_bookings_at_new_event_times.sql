-- Migration 057: Venue Staff approve a flagged booking or an open request at
-- the event's current period, so a rescheduled event keeps its venue when the
-- venue is free then. The functions are restated whole from their latest
-- definitions with the same signatures; only the period steps change, and
-- Venue Staff's queue shows and checks the period an approval would book.

-- The period a reinstated booking had before it moved to the event's; null
-- when it kept its own.
alter table booking_resolutions add column if not exists previous_starts_at timestamptz;
alter table booking_resolutions add column if not exists previous_ends_at timestamptz;

create or replace function reinstate_flagged_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
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
  v_resolution  booking_resolutions;
  v_moved       boolean;
  v_starts_at   timestamptz;
  v_ends_at     timestamptz;
begin
  -- 1. Only Venue Staff, as decide_booking_request checks it.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can reinstate a flagged booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. A reason is required; the table's check would refuse it later anyway,
  --    but with a constraint name instead of a sentence.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to reinstate a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 3. Which event and venue, unlocked as in 066; then event, venue, booking.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select retired_at
    into v_retired_at
    from venues
   where id = v_venue_id
     for no key update;

  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 4. The booking is flagged, and not for the safety check.
  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be reinstated',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  if v_booking.review_reason = 'safety_review' then
    raise exception 'booking % was flagged by the safety review, and can only be cancelled or replaced',
      p_booking_id
      using errcode = 'PT409', hint = 'SAFETY_FLAG_NOT_REINSTATABLE';
  end if;

  -- 5. The event is still live and past approval (066, step 7).
  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be booked for an event that is approved, in or through the safety check, or confirmed',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- 6. A booking that still covers the event's start to end keeps its own
  --    period; one the event has moved off is checked, and reinstated, at the
  --    event's current period. An event with no period has nothing to book.
  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'booking % no longer covers the event''s period', p_booking_id
      using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
  end if;

  v_moved := not (v_booking.starts_at <= v_event.proposed_start
                  and v_booking.ends_at >= v_event.proposed_end);
  v_starts_at := case when v_moved then v_event.proposed_start else v_booking.starts_at end;
  v_ends_at   := case when v_moved then v_event.proposed_end   else v_booking.ends_at   end;

  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be booked', v_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 7. The re-check of the period from step 6, as 066 asks it. A flagged
  --    booking counts as an occupant, so this one is left out, or it would
  --    clash with itself.
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
    from venue_occupancy_conflicts(v_venue_id, v_starts_at, v_ends_at, true,
                                   v_event_id) c
   where not (c.kind = 'booking' and c.id = p_booking_id);

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. The record first, while the booking still carries the flag and the
  --    period it copies. The previous period is kept only when it moves.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by,
                                   previous_starts_at, previous_ends_at)
  values (p_booking_id, 'reinstated', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by,
          case when v_moved then v_booking.starts_at end,
          case when v_moved then v_booking.ends_at end)
  returning * into v_resolution;

  -- 9. Approved again at the period from step 6, with the whole flag cleared
  --    (034's pairing), guarded so it only ever moves a flagged booking.
  update bookings
     set status          = 'approved',
         starts_at       = v_starts_at,
         ends_at         = v_ends_at,
         flagged_at      = null,
         flagged_by      = null,
         review_block_id = null,
         review_reason   = null
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being reinstated', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 10. Tell the event's people, in the same transaction. The notice reads the
  --     booking after step 9, so it carries the period it was reinstated at.
  perform notify_flagged_booking_resolved(v_resolution.id, 'venue_staff');

  return jsonb_build_object('outcome', 'reinstated',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;
revoke execute on function reinstate_flagged_booking(uuid, uuid, text) from public, anon, authenticated;

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
  v_previous_starts_at timestamptz;
  v_previous_ends_at   timestamptz;
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

    -- 8. The approval is for the event's current period, never one it has
    --    moved from: a request raised before the move takes the new period,
    --    and is checked at it. An event with no period has nothing to book.
    if v_event.proposed_start is null or v_event.proposed_end is null then
      raise exception 'booking request % is for a period the event no longer has', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
    end if;

    if v_booking.starts_at is distinct from v_event.proposed_start
       or v_booking.ends_at is distinct from v_event.proposed_end then
      v_previous_starts_at := v_booking.starts_at;
      v_previous_ends_at   := v_booking.ends_at;
    end if;

    if v_retired_at is not null then
      raise exception 'venue % is retired and cannot be booked', v_venue_id
        using errcode = 'PT409', hint = 'VENUE_RETIRED';
    end if;

    -- 9. The re-check of the event's period, through the shared function, as
    --    create_booking_request step 7 asks it: padded, with this event's own
    --    holds left out. An open request occupies nothing, so cannot clash
    --    with itself.
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
      from venue_occupancy_conflicts(v_venue_id, v_event.proposed_start, v_event.proposed_end, true,
                                     v_event_id) c;

    if jsonb_array_length(v_conflicts) > 0 then
      return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
    end if;

    v_new_status := 'approved';
  else
    v_new_status := 'rejected';
  end if;

  -- 10. The decision, guarded so it can only ever move an open request.
  --     Texts are trimmed; a blank alternative is none. An approval takes the
  --     event's period from step 8; a rejection keeps the request's own.
  update bookings
     set status                = v_new_status::booking_status,
         starts_at             = case when v_new_status = 'approved' then v_event.proposed_start else starts_at end,
         ends_at               = case when v_new_status = 'approved' then v_event.proposed_end else ends_at end,
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
  --     no coordinator has nobody to tell. The period is the one decided; the
  --     previous one is set only when the approval moved the request.
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
           'suggestedAlternative', v_booking.suggested_alternative,
           'previousStartsAt',     v_previous_starts_at,
           'previousEndsAt',       v_previous_ends_at
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

      -- It no longer occupies its venue. Step 5 locked this booking's venue;
      -- the replaced one may be at another, so lock that one too.
      if v_replaced.venue_id is distinct from v_venue_id then
        perform 1
          from venues
         where id = v_replaced.venue_id
           for no key update;
      end if;

      perform return_freed_conflicting_requests(v_replaced.id);
    end if;
  end if;

  return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking),
                            'marked_conflicting', to_jsonb(v_marked_ids),
                            'converted_hold_id', v_converted_hold_id,
                            'replaced_booking_id', v_replaced.id);
end;
$$;
revoke execute on function decide_booking_request(uuid, uuid, text, text, text) from public, anon, authenticated;

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
    -- An approval books the event's current period (decide_booking_request,
    -- step 8), so the occupied period and both clash lists are judged there;
    -- an event with no period falls back to the request's own.
    with periods as (
      select b.*,
             er.event_name,
             er.status::text                      as event_status,
             er.proposed_start                    as event_starts_at,
             er.proposed_end                      as event_ends_at,
             v.name                               as venue_name,
             v.location                           as venue_location,
             v.setup_minutes,
             v.turnaround_minutes,
             case when er.proposed_start is not null and er.proposed_end is not null
                  then er.proposed_start else b.starts_at end as approval_starts_at,
             case when er.proposed_start is not null and er.proposed_end is not null
                  then er.proposed_end else b.ends_at end     as approval_ends_at
        from bookings b
        join event_requests er on er.id = b.event_request_id
        join venues v          on v.id  = b.venue_id
       where b.status in ('pending', 'conflicting')
    ),
    pending as (
      select pr.*,
             venue_occupied_period(pr.approval_starts_at, pr.approval_ends_at,
                                   pr.setup_minutes, pr.turnaround_minutes) as occupied
        from periods pr
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
               'event_starts_at',            p.event_starts_at,
               'event_ends_at',              p.event_ends_at,
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
                   from pending_request_overlaps(p.venue_id, p.approval_starts_at, p.approval_ends_at,
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
                   from venue_occupancy_conflicts(p.venue_id, p.approval_starts_at, p.approval_ends_at, true,
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
revoke execute on function list_pending_booking_requests(uuid) from public, anon, authenticated;
