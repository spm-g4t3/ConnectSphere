-- Migration 038: every way a booking stops occupying its venue (a release, a
-- flagged booking cancelled or replaced, an event's arrangements released) now
-- returns other events' Conflicting requests that clashed only with it to
-- Pending, through one shared function, and tells their coordinators.

-- Call once p_booking_id no longer occupies its venue. A request still blocked
-- by a booking, venue block or active hold stays Conflicting. Returns the ids
-- returned to Pending.
create or replace function return_freed_conflicting_requests(p_booking_id uuid)
returns uuid[]
language plpgsql
as $$
declare
  v_booking    record;
  v_candidates uuid[];
  v_freed      uuid[];
begin
  if p_booking_id is null then
    raise exception 'A booking id is required' using errcode = '22023';
  end if;

  select b.id, b.venue_id, b.starts_at, b.ends_at, b.event_request_id,
         er.event_name, v.name as venue_name
    into v_booking
    from bookings b
    join event_requests er on er.id = b.event_request_id
    join venues v on v.id = b.venue_id
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id using errcode = 'P0002';
  end if;

  -- The lock decide_booking_request step 5 takes, so no approval here can
  -- interleave with the re-check below.
  perform 1
    from venues
   where id = v_booking.venue_id
     for no key update;

  -- Other events' Conflicting requests that overlap it, locked in id order.
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_candidates
    from (
      select b.id
        from bookings b
       where b.id in (select o.id
                        from pending_request_overlaps(v_booking.venue_id, v_booking.starts_at,
                                                      v_booking.ends_at, v_booking.event_request_id) o)
         and b.status::text = 'conflicting'
       order by b.id
         for update
    ) locked;

  -- Those that nothing occupies now go back to Pending; anything else that
  -- still occupies one keeps it Conflicting.
  select coalesce(array_agg(c.id order by c.id), '{}')
    into v_freed
    from bookings c
   where c.id = any (v_candidates)
     and not exists (
       select 1
         from venue_occupancy_conflicts(c.venue_id, c.starts_at, c.ends_at, true, c.event_request_id)
     );

  update bookings
     set status = 'pending'
   where id = any (v_freed)
     and status::text = 'conflicting';

  -- Each freed request's coordinator, told which booking freed it.
  insert into notifications (recipient_id, type, booking_id, payload)
  select er.assigned_coordinator_id,
         'booking_request_conflict_cleared',
         b.id,
         jsonb_build_object(
           'eventRequestId',    b.event_request_id,
           'eventName',         er.event_name,
           'venueId',           b.venue_id,
           'venueName',         v_booking.venue_name,
           'startsAt',          b.starts_at,
           'endsAt',            b.ends_at,
           'releasedBookingId', v_booking.id,
           'releasedEventName', v_booking.event_name
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_freed)
     and er.assigned_coordinator_id is not null
   order by b.id;

  return v_freed;
end;
$$;
revoke execute on function return_freed_conflicting_requests(uuid) from public, anon, authenticated;

create or replace function release_venue_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_event_id   uuid;
  v_venue_id   uuid;
  v_venue_name text;
  v_event      event_requests;
  v_booking    bookings;
  v_freed      uuid[];
begin
  -- 1. A reason is required, checked as 077 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to release a venue booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event and venue, unlocked as in 077; then the event, locked.
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

  -- 3. The event's assigned coordinator only (D1). A null caller is refused
  --    explicitly (see 018).
  if p_caller is null or v_event.assigned_coordinator_id is distinct from p_caller then
    raise exception 'only the coordinator assigned to event request % can release its venue bookings',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. An Approved event only (D2).
  if v_event.status::text <> 'approved' then
    raise exception 'event request % is %, and its venue bookings can be released only while it is approved',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_APPROVED';
  end if;

  -- 5. Lock the venue.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_venue_id
     for no key update;

  -- 6. Lock the booking; an approved one only, each other kind pointed to its
  --    own action (D3).
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'approved' then
    if v_booking.status::text = 'flagged_for_review' then
      raise exception 'booking % is flagged for review; resolve it from Flagged bookings', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    elsif v_booking.status::text in ('pending', 'conflicting') then
      raise exception 'booking % is still a request; withdraw it instead', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    else
      raise exception 'booking % is %, and only an approved booking can be released',
        p_booking_id, v_booking.status
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    end if;
  end if;

  -- 7. Released, guarded so it only ever moves an approved booking.
  update bookings
     set status         = 'released',
         released_by    = p_caller,
         released_at    = now(),
         release_reason = btrim(p_reason)
   where id = p_booking_id
     and status = 'approved'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being released', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 8-9. Other events' Conflicting requests that only this booking blocked go
  --      back to Pending, and their coordinators are told.
  v_freed := return_freed_conflicting_requests(v_booking.id);

  -- 10. Every Venue Staff member, as 052 tells every Lead (D9).
  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_released',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_event_id,
           'eventName',      v_event.event_name,
           'venueId',        v_venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at,
           'releasedBy',     p_caller,
           'releasedByName', profile_display_name(p_caller),
           'reason',         v_booking.release_reason
         )
    from profiles p
   where p.role::text = 'venue_staff'
   order by p.id;

  return jsonb_build_object('outcome', 'released',
                            'booking', to_jsonb(v_booking),
                            'returned_to_pending', to_jsonb(v_freed));
end;
$$;
revoke execute on function release_venue_booking(uuid, uuid, text) from public, anon, authenticated;

create or replace function release_event_arrangements(
  p_event_request_id uuid,
  p_reason text,
  p_released_by uuid default null
)
returns void
language plpgsql
as $$
declare
  v_event_name text;
  v_released   uuid[];
  v_booking_id uuid;
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Release reason is required and cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  select event_name
    into v_event_name
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- The venues these bookings occupy, before the bookings, in
  -- decide_booking_request's order (event, venue, booking).
  perform 1
    from venues
   where id in (select b.venue_id
                  from bookings b
                 where b.event_request_id = p_event_request_id
                   and b.status in ('approved', 'flagged_for_review'))
   order by id
     for no key update;

  -- Only these occupied a venue, so only these can have left others Conflicting.
  select coalesce(array_agg(id order by id), '{}')
    into v_released
    from bookings
   where event_request_id = p_event_request_id
     and status in ('approved', 'flagged_for_review');

  update bookings
     set status = case
       when status in ('pending', 'conflicting') then 'withdrawn'::booking_status
       else 'cancelled'::booking_status
     end
   where event_request_id = p_event_request_id
     and status in ('pending', 'conflicting', 'approved', 'flagged_for_review');

  perform release_equipment_reservations(p_event_request_id, null, p_reason, null);

  update equipment_requests
     set status = 'cancelled'
   where event_request_id = p_event_request_id
     and status <> 'cancelled';

  update venue_holds
     set status = 'released',
         released_at = now(),
         released_by = p_released_by
   where event_request_id = p_event_request_id
     and status = 'active';

  -- After the holds, which occupy a venue too: each released booking may
  -- have been the only thing keeping another event's request Conflicting.
  foreach v_booking_id in array v_released loop
    perform return_freed_conflicting_requests(v_booking_id);
  end loop;
end;
$$;
revoke execute on function release_event_arrangements(uuid, text, uuid) from public, anon, authenticated;

create or replace function cancel_flagged_booking(
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
  v_booking     bookings;
  v_resolution  booking_resolutions;
begin
  -- 1. A reason is required, checked as 076 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to cancel a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event and venue, unlocked as in 066; then the event, locked.
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

  -- 3. The event's assigned coordinator, or Venue Staff. A null caller is
  --    refused explicitly (see 018).
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null
     or (v_event.assigned_coordinator_id is distinct from p_caller
         and v_role is distinct from 'venue_staff') then
    raise exception 'only the coordinator assigned to event request % or Venue Staff can cancel a flagged booking',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 3a. Lock the venue before the booking, in decide_booking_request's order,
  --     since cancelling it can free other events' requests there.
  perform 1
    from venues
   where id = v_venue_id
     for no key update;

  -- 4. Lock the booking and read its status as it is now.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be cancelled',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  -- 5. The record, with the flag as it stood.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by)
  values (p_booking_id, 'cancelled', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by)
  returning * into v_resolution;

  -- 6. Cancelled, guarded so it only ever moves a flagged booking. The flag
  --    stays on the booking, so it still shows why it was flagged.
  update bookings
     set status = 'cancelled'
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being cancelled', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 7. Tell the event's people, in the same transaction, naming which side
  --    resolved it. Venue Staff who are not the coordinator act as staff.
  perform notify_flagged_booking_resolved(
    v_resolution.id,
    case when v_event.assigned_coordinator_id = p_caller then 'event_coordinator' else 'venue_staff' end
  );

  -- 8. Other events' Conflicting requests that only this booking blocked go
  --    back to Pending, and their coordinators are told.
  perform return_freed_conflicting_requests(p_booking_id);

  return jsonb_build_object('outcome', 'cancelled',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;
revoke execute on function cancel_flagged_booking(uuid, uuid, text) from public, anon, authenticated;

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
