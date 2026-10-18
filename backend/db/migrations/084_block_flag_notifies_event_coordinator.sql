-- A venue block's booking_flagged notice goes to the flagged event's assigned
-- coordinator, not to every Event Coordinator. An event with no coordinator
-- yet notifies every Event Coordinator Lead instead.
--
-- A block also tells the coordinator of every open request (pending or
-- conflicting) it covers, without changing the request: Venue Staff still
-- decide it.


-- ---------------------------------------------------------------------
-- 1. Notification types (extends 083)
-- ---------------------------------------------------------------------
-- 083's list plus booking_request_venue_unavailable, added to the live
-- constraint as 083 does, so re-running this file never drops a type.

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
    'booking_request_submitted',
    'booking_request_venue_unavailable'
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
-- 2. An unavailable-venue notice names its request, once per block
-- ---------------------------------------------------------------------
-- The notice is about one booking request. The index makes amending the same
-- block (update_venue_block re-runs the flagging) tell nobody twice;
-- recipient_id is in it so an unassigned event still reaches every Lead.

alter table notifications drop constraint if exists notifications_request_unavailable_needs_booking;
alter table notifications
  add constraint notifications_request_unavailable_needs_booking
  check (type <> 'booking_request_venue_unavailable' or booking_id is not null);

create unique index if not exists notifications_request_unavailable_once_per_block
  on notifications (booking_id, block_id, recipient_id)
  where type = 'booking_request_venue_unavailable';


-- ---------------------------------------------------------------------
-- 3. Flagging the bookings a block overrides (033, step 3 replaced)
-- ---------------------------------------------------------------------
-- Same signature and return columns as 033, so `create or replace` replaces
-- it in place and create_venue_block and update_venue_block read it
-- unchanged. Step 3's recipients differ from 033, and step 4 is new.
--
-- Errors:
--   no_data_found (P0002)  no such block, or it has been removed

create or replace function flag_bookings_for_block(
  p_block_id    uuid,
  p_booking_ids uuid[],
  p_user_id     uuid default null
)
returns table (
  booking_id       uuid,
  event_request_id uuid,
  event_name       text,
  starts_at        timestamptz,
  ends_at          timestamptz
)
language plpgsql
as $$
declare
  v_block      venue_blocks;
  v_venue_name text;
  v_flagged    uuid[];
begin
  -- 1. The block must exist and be active. A removed block overrides nothing.
  select *
    into v_block
    from venue_blocks vb
   where vb.id = p_block_id
     and vb.removed_at is null;

  if not found then
    raise exception 'venue block % not found', p_block_id using errcode = 'no_data_found';
  end if;

  select v.name
    into v_venue_name
    from venues v
   where v.id = v_block.venue_id;

  -- 2. Flag. One UPDATE ... RETURNING, so the ids collected are exactly the
  --    rows this statement changed -- a booking cancelled in the meantime
  --    fails the status filter and is neither flagged nor notified about.
  --    A CTE for the same reason as step 5 in 013: the aggregate runs
  --    outside the data-modifying statement.
  --
  --    SCRUM-484: the overlap is venue_occupancy_conflicts()'s, with the
  --    block unpadded (AC6) and each booking padded by the venue's setup and
  --    turnaround. Its booking rows include flagged_for_review ones, but
  --    b.status = 'approved' below still limits flagging to approved rows: a
  --    booking already flagged is not flagged twice.
  with flagged as (
    update bookings b
       set status          = 'flagged_for_review',
           review_block_id = v_block.id,
           flagged_at      = now(),
           flagged_by      = p_user_id
     where b.id = any (coalesce(p_booking_ids, '{}'))
       and b.status = 'approved'
       and b.venue_id = v_block.venue_id
       and b.id in (
             select c.id
               from venue_occupancy_conflicts(v_block.venue_id, v_block.starts_at,
                                              v_block.ends_at, false) c
              where c.kind = 'booking'
           )
    returning b.id
  )
  select coalesce(array_agg(flagged.id order by flagged.id), '{}'::uuid[])
    into v_flagged
    from flagged;

  -- 3. Notify. One row per flagged booking for the event's assigned
  --    coordinator, or for every Event Coordinator Lead when it has none.
  --    AC5 means the event's own coordinator; the Leads cover an unassigned
  --    event so no flag goes unseen.
  --
  --    The payload keys are camelCase because the API returns the payload to
  --    the frontend as it is stored; converting nested jsonb key by key in
  --    the service would buy nothing.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
         'booking_flagged',
         b.id,
         v_block.id,
         jsonb_build_object(
           'venueName',     v_venue_name,
           'eventName',     er.event_name,
           'startsAt',      b.starts_at,
           'endsAt',        b.ends_at,
           'reason',        v_block.reason,
           'blockStartsAt', v_block.starts_at,
           'blockEndsAt',   v_block.ends_at
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   cross join lateral (
           select er.assigned_coordinator_id as recipient_id
            where er.assigned_coordinator_id is not null
           union all
           select p.id
             from profiles p
            where er.assigned_coordinator_id is null
              and p.role = 'event_coordinator_lead'
         ) r
   where b.id = any (v_flagged);

  -- 4. Tell the coordinator of each open request the block now covers, with
  --    the same recipients as step 3. The status is left alone: a request
  --    does not occupy the venue, so the block flags nothing (domain rule),
  --    but the coordinator learns early that this venue is unlikely.
  --
  --    The overlap is step 2's -- block unpadded, request padded by the
  --    venue's setup and turnaround -- written out: the occupancy function
  --    skips open requests, and pending_request_overlaps would pad the block.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
         'booking_request_venue_unavailable',
         b.id,
         v_block.id,
         jsonb_build_object(
           'cause',          'block',
           'eventRequestId', er.id,
           'eventName',      er.event_name,
           'venueId',        v.id,
           'venueName',      v.name,
           'startsAt',       b.starts_at,
           'endsAt',         b.ends_at,
           'reason',         v_block.reason,
           'blockStartsAt',  v_block.starts_at,
           'blockEndsAt',    v_block.ends_at
         )
    from bookings b
    join venues v          on v.id  = b.venue_id
    join event_requests er on er.id = b.event_request_id
   cross join lateral (
           select er.assigned_coordinator_id as recipient_id
            where er.assigned_coordinator_id is not null
           union all
           select p.id
             from profiles p
            where er.assigned_coordinator_id is null
              and p.role = 'event_coordinator_lead'
         ) r
   where b.venue_id = v_block.venue_id
     and b.status in ('pending', 'conflicting')
     and venue_occupied_period(b.starts_at, b.ends_at,
                               v.setup_minutes::integer, v.turnaround_minutes::integer)
         && venue_occupied_period(v_block.starts_at, v_block.ends_at, 0, 0)
  -- No conflict target: naming booking_id here would clash with this
  -- function's own booking_id output column. The only unique index a new
  -- row can meet is notifications_request_unavailable_once_per_block.
  on conflict do nothing;

  -- 5. The flagged bookings, soonest first, in 014's column order.
  return query
    select b.id, b.event_request_id, er.event_name, b.starts_at, b.ends_at
      from bookings b
      join event_requests er on er.id = b.event_request_id
     where b.id = any (v_flagged)
     order by b.starts_at, b.id;
end;
$$;

-- As in 014: only create_venue_block and update_venue_block should reach
-- this. It writes and trusts its caller to have passed the override gate.
revoke execute on function flag_bookings_for_block(uuid, uuid[], uuid) from public, anon, authenticated;
