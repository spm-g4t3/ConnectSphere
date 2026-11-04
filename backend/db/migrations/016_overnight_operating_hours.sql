-- Migration 016: a weekday's hours may run past midnight.
-- A closing time at or before the opening time now means the next day, so the
-- only window left to refuse is an empty one (opening equals closing).

alter table venue_operating_hours drop constraint if exists venue_operating_hours_ordered;

alter table venue_operating_hours drop constraint if exists venue_operating_hours_not_empty;
alter table venue_operating_hours
  add constraint venue_operating_hours_not_empty check (closes_at <> opens_at);

-- Venue Staff may shorten the hours over approved bookings once they confirm
-- the list the API found; update_venue then flags those bookings for review
-- and tells each coordinator. One new parameter, so the old overload is dropped.

drop function if exists update_venue(uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, text, text, uuid);

create or replace function update_venue(
  p_id                 uuid,
  p_name               text    default null,
  p_location           text    default null,
  p_max_capacity       integer default null,
  p_layouts            text[]  default null,
  p_accessibility      text[]  default null,
  p_facilities         text[]  default null,
  p_hours              jsonb   default null,
  p_turnaround_minutes integer default null,
  p_setup_minutes      integer default null,
  p_emergency_access   text    default null,
  p_known_restrictions text    default null,
  p_user_id            uuid    default null,
  p_hours_flag_booking_ids uuid[] default null
)
returns jsonb
language plpgsql
as $$
declare
  v_before          jsonb;
  v_old_setup       integer;
  v_old_turnaround  integer;
  v_new_setup       integer;
  v_new_turnaround  integer;
  v_venue_name      text;
  v_clashing        uuid[] := '{}';
  -- 035: candidates already clashing under the OLD minutes (see the header).
  v_old_clashing    uuid[] := '{}';
  -- 035: whether this call really changes setup or turnaround, worked out
  --      before the update so the old set can be collected first.
  v_changing        boolean := false;
  v_locked          uuid[] := '{}';
  v_flagged         uuid[] := '{}';
  v_flagged_list    jsonb  := '[]'::jsonb;
  v_hours_locked    uuid[] := '{}';
  v_hours_flagged   uuid[] := '{}';
begin
  -- 0. Lock the venue and read the minutes it had before this change. See the
  --    header for why "for no key update".
  select v.setup_minutes, v.turnaround_minutes
    into v_old_setup, v_old_turnaround
    from venues v
   where v.id = p_id
     for no key update;

  if not found then
    raise exception 'venue % not found', p_id using errcode = 'no_data_found';
  end if;

  -- 0a. 035: will setup or turnaround really change? The new values are not in
  --     the row yet, so compare what the update below will write --
  --     coalesce(parameter, old) -- against the old minutes.
  v_changing := coalesce(p_setup_minutes, v_old_setup) is distinct from v_old_setup
             or coalesce(p_turnaround_minutes, v_old_turnaround) is distinct from v_old_turnaround;

  -- 0b. 035: the candidates that already clash under the OLD minutes, with the
  --     same condition and the same function as step 7a. It reads the
  --     minutes from venues, which still hold the old values here; the venue
  --     lock above keeps them and the bookings steady until step 7. Only
  --     when the minutes are changing, so a name-only edit stays cheap.
  if v_changing then
    select coalesce(array_agg(b.id order by b.id), '{}'::uuid[])
      into v_old_clashing
      from bookings b
     where b.venue_id = p_id
       and b.status = 'approved'
       and b.starts_at > now()
       and exists (
             select 1
               from venue_occupancy_conflicts(p_id, b.starts_at, b.ends_at, true) c
              where c.kind = 'block'
                 or (c.kind = 'booking' and c.id <> b.id)
           );
  end if;

  -- 1-6. 023's update and attribute steps, word for word.

  -- Taken before anything is written, and taken unconditionally: the venue may
  -- not exist, in which case the update below raises and this is discarded
  -- along with everything else in the transaction.
  v_before := venue_attribute_snapshot(p_id);

  update venues
  set
    name               = coalesce(p_name, name),
    location           = coalesce(p_location, location),
    max_capacity       = coalesce(p_max_capacity, max_capacity),
    turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes),
    setup_minutes      = coalesce(p_setup_minutes, setup_minutes),
    emergency_access   = case when p_emergency_access is null then emergency_access
                              else nullif(regexp_replace(p_emergency_access, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') end,
    known_restrictions = case when p_known_restrictions is null then known_restrictions
                              else nullif(regexp_replace(p_known_restrictions, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') end,
    last_modified_by   = p_user_id
  where id = p_id;

  if not found then
    raise exception 'venue % not found', p_id using errcode = 'no_data_found';
  end if;

  if p_layouts is not null then
    delete from venue_room_layouts where venue_id = p_id;
    insert into venue_room_layouts (venue_id, room_layout_code)
    select p_id, code from unnest(p_layouts) as code
    on conflict do nothing;
  end if;

  if p_accessibility is not null then
    delete from venue_accessibility_features where venue_id = p_id;
    insert into venue_accessibility_features (venue_id, accessibility_feature_code)
    select p_id, code from unnest(p_accessibility) as code
    on conflict do nothing;
  end if;

  if p_facilities is not null then
    delete from venue_facilities where venue_id = p_id;
    insert into venue_facilities (venue_id, facility_code)
    select p_id, code from unnest(p_facilities) as code
    on conflict do nothing;
  end if;

  if p_hours is not null then
    delete from venue_operating_hours where venue_id = p_id;
    insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
    select
      p_id,
      (h ->> 'day_of_week')::smallint,
      (h ->> 'opens_at')::time,
      (h ->> 'closes_at')::time
    from jsonb_array_elements(p_hours) as h;
  end if;

  perform record_venue_attribute_change(
    p_id, v_before, venue_attribute_snapshot(p_id), p_user_id
  );

  -- 7. AC8: re-check only when setup or turnaround really changed.
  select v.setup_minutes, v.turnaround_minutes, v.name
    into v_new_setup, v_new_turnaround, v_venue_name
    from venues v
   where v.id = p_id;

  if v_new_setup is distinct from v_old_setup
     or v_new_turnaround is distinct from v_old_turnaround
  then
    -- 7a. Every approved, not-yet-started booking whose occupied period (now
    --     padded with the new minutes) meets an active block or ANOTHER
    --     occupying booking. Collected in full before anything is written, so
    --     both bookings of a newly clashing pair are found. A started
    --     approved booking is never a candidate, but it is still returned by
    --     venue_occupancy_conflicts and so still counts as the other side.
    --     035: the other side is any booking the shared function returns --
    --     approved or flagged_for_review (032) -- so 034's
    --     "c.status = 'approved'" is gone. A flagged booking still holds the
    --     room everywhere else, so it holds it here too.
    select coalesce(array_agg(b.id order by b.id), '{}'::uuid[])
      into v_clashing
      from bookings b
     where b.venue_id = p_id
       and b.status = 'approved'
       and b.starts_at > now()
       and exists (
             select 1
               from venue_occupancy_conflicts(p_id, b.starts_at, b.ends_at, true) c
              where c.kind = 'block'
                 or (c.kind = 'booking' and c.id <> b.id)
           );

    -- 7a'. 035: keep only the clashes this change created. A booking that
    --      already clashed under the old minutes (step 0b) was not put in
    --      that position by this edit, so it is left for whoever created it.
    --      Reducing the minutes can only shrink the clashing set, so it now
    --      flags nothing.
    select coalesce(array_agg(x.id order by x.id), '{}'::uuid[])
      into v_clashing
      from unnest(v_clashing) as x(id)
     where x.id <> all (v_old_clashing);

    -- 7b. Lock them in id order, as 033 does, re-checking the status on the
    --     locked row so one that changed while we waited drops out. A CTE
    --     because Postgres refuses an aggregate beside a locking clause.
    with locked as (
      select b.id
        from bookings b
       where b.id = any (v_clashing)
         and b.status = 'approved'
       order by b.id
         for no key update of b
    )
    select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
      into v_locked
      from locked;

    -- 7c. Flag. One UPDATE ... RETURNING, as flag_bookings_for_block does, so
    --     the ids collected are exactly the rows this statement changed.
    with flagged as (
      update bookings b
         set status        = 'flagged_for_review',
             review_reason = 'setup_or_turnaround_changed',
             flagged_at    = now(),
             flagged_by    = p_user_id
       where b.id = any (v_locked)
         and b.status = 'approved'
      returning b.id
    )
    select coalesce(array_agg(flagged.id order by flagged.id), '{}'::uuid[])
      into v_flagged
      from flagged;

    -- 7d. Notify the event's assigned coordinator, one row per flagged
    --     booking. An event with no coordinator is skipped; its booking is
    --     still flagged. camelCase payload keys, as 014's.
    insert into notifications (recipient_id, type, booking_id, block_id, payload)
    select er.assigned_coordinator_id,
           'booking_flagged_setup_change',
           b.id,
           null,
           jsonb_build_object(
             'venueName',         v_venue_name,
             'eventName',         er.event_name,
             'startsAt',          b.starts_at,
             'endsAt',            b.ends_at,
             'occupiedStartsAt',  lower(venue_occupied_period(b.starts_at, b.ends_at,
                                                              v_new_setup, v_new_turnaround)),
             'occupiedEndsAt',    upper(venue_occupied_period(b.starts_at, b.ends_at,
                                                              v_new_setup, v_new_turnaround)),
             'setupMinutes',      v_new_setup,
             'turnaroundMinutes', v_new_turnaround,
             'reason',            'Setup or turnaround time changed'
           )
      from bookings b
      join event_requests er on er.id = b.event_request_id
     where b.id = any (v_flagged)
       and er.assigned_coordinator_id is not null;
  end if;

  -- 8. Bookings the new operating hours no longer cover, which Venue Staff
  --    confirmed. The hours rule lives in the API (domain/venueMatching.js), so
  --    this re-checks only what can change between their check and this save:
  --    still approved, on this venue, not started. Locked in id order as 7b.
  if coalesce(cardinality(p_hours_flag_booking_ids), 0) > 0 then
    with locked as (
      select b.id
        from bookings b
       where b.id = any (p_hours_flag_booking_ids)
         and b.venue_id = p_id
         and b.status = 'approved'
         and b.starts_at > now()
       order by b.id
         for no key update of b
    )
    select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
      into v_hours_locked
      from locked;

    -- 8a. No block caused it, so the reason carries the cause.
    with flagged as (
      update bookings b
         set status        = 'flagged_for_review',
             review_reason = 'venue_details_changed',
             flagged_at    = now(),
             flagged_by    = p_user_id
       where b.id = any (v_hours_locked)
         and b.status = 'approved'
      returning b.id
    )
    select coalesce(array_agg(flagged.id order by flagged.id), '{}'::uuid[])
      into v_hours_flagged
      from flagged;

    -- 8b. Notify the assigned coordinator, as 7d does; none means no notice.
    insert into notifications (recipient_id, type, booking_id, block_id, payload)
    select er.assigned_coordinator_id,
           'booking_flagged_hours_change',
           b.id,
           null,
           jsonb_build_object(
             'venueName', v_venue_name,
             'eventName', er.event_name,
             'startsAt',  b.starts_at,
             'endsAt',    b.ends_at,
             'reason',    'Operating hours changed'
           )
      from bookings b
      join event_requests er on er.id = b.event_request_id
     where b.id = any (v_hours_flagged)
       and er.assigned_coordinator_id is not null;

    v_flagged := v_flagged || v_hours_flagged;
  end if;

  -- 9. The flagged bookings, soonest first, in 033's conflict-row shape:
  --    step 7's and step 8's, disjoint because step 8 takes only approved ones.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',         b.id,
               'event_request_id',   b.event_request_id,
               'event_name',         er.event_name,
               'starts_at',          b.starts_at,
               'ends_at',            b.ends_at,
               'occupied_starts_at', lower(venue_occupied_period(b.starts_at, b.ends_at,
                                                                 v_new_setup, v_new_turnaround)),
               'occupied_ends_at',   upper(venue_occupied_period(b.starts_at, b.ends_at,
                                                                 v_new_setup, v_new_turnaround)),
               'setup_minutes',      v_new_setup,
               'turnaround_minutes', v_new_turnaround
             )
             order by b.starts_at, b.id
           ),
           '[]'::jsonb
         )
    into v_flagged_list
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_flagged);

  return jsonb_build_object('flagged_bookings', v_flagged_list);
end;
$$;

-- The whole list, restated from baseline/05_notifications.sql with the new type.
alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (type = any (array[
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
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired',
    'booking_released',
    'booking_request_conflict_cleared',
    'equipment_requested',
    'equipment_request_changed',
    'equipment_request_cancelled',
    'equipment_arranged',
    'equipment_not_fully_arranged',
    'equipment_flagged',
    'registration_schedule_conflict',
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change',
    'booking_flagged_hours_change'
  ]));

alter table notifications drop constraint if exists notifications_hours_change_needs_booking;
alter table notifications
  add constraint notifications_hours_change_needs_booking
  check ((type <> 'booking_flagged_hours_change') or (booking_id is not null));
