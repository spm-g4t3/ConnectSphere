-- Retiring a venue flags its future approved bookings for review and tells
-- each event's coordinator; open requests there are left as they are, but
-- their coordinator is told the venue is gone. Nothing is cancelled: the
-- coordinator decides (replace through create_booking_request, which refuses a
-- retired venue, so the replacement is elsewhere). 076 already refuses to
-- reinstate a booking at a retired venue (VENUE_RETIRED), so it is not restated.


-- ---------------------------------------------------------------------
-- 1. Notification types (extends 084)
-- ---------------------------------------------------------------------
-- 084's list plus booking_flagged_venue_retired, added to the live constraint
-- as 083 does, so re-running this file never drops a type. A migration that
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
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired'
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
-- 2. A venue-retired notice names its booking
-- ---------------------------------------------------------------------
-- As 034 does for a setup change: the notice is about one flagged booking.

alter table notifications drop constraint if exists notifications_venue_retired_needs_booking;
alter table notifications
  add constraint notifications_venue_retired_needs_booking
  check (type <> 'booking_flagged_venue_retired' or booking_id is not null);


-- ---------------------------------------------------------------------
-- 3. retire_venue (005, with steps 2-4)
-- ---------------------------------------------------------------------
-- 005's function word for word, then steps 2-4 in the same transaction.
-- Same signature, so `create or replace` replaces it in place.
--
-- Lock order: the rule is event, then venue, then booking, but retirement
-- starts from the venue and only learns the events from its bookings. Locking
-- them after the venue would invert the order against decide_booking_request
-- and reinstate_flagged_booking (event held, waiting on the venue), so no
-- event is locked: venue (step 1's update), then bookings in id order, as
-- update_venue (036) flags. Those two functions lock the venue before the
-- booking and refuse a retired venue once they get it, and create_booking_request
-- waits on the venue too, so nothing new is approved or requested here after
-- step 1. The coordinator is read unlocked, as 036 and 084 read it.

create or replace function retire_venue(
  p_id      uuid,
  p_user_id uuid default null
)
returns void
language plpgsql
as $$
declare
  v_retired_at timestamptz;
  v_venue_name text;
  v_locked     uuid[];
  v_flagged    uuid[];
begin
  -- Both columns in ONE statement. The audit trigger reads
  -- new.last_modified_by, so setting them separately would attribute the
  -- retirement to whoever edited the venue last.
  --
  -- "and retired_at is null" is what makes this safe under concurrency: a
  -- second retirement blocks on the row lock, re-checks the predicate against
  -- the committed row, matches nothing, and reports the conflict below rather
  -- than overwriting the first timestamp.
  --
  -- last_modified_by is assigned, not coalesced, exactly as update_venue does
  -- it (004). A NULL user therefore records a NULL, which 003 reads as
  -- "changed outside the app".
  update venues
  set retired_at       = now(),
      last_modified_by = p_user_id
  where id = p_id
    and retired_at is null;

  -- Depends on venues_record_change staying an AFTER trigger. An AFTER row
  -- trigger's return value is ignored, so it cannot affect FOUND. If it were
  -- ever changed to BEFORE, its `return null` would suppress the row and this
  -- function would report "already retired" while writing nothing.
  if not found then
    -- Zero rows means one of two different things, and only the failure path
    -- pays for telling them apart.
    if exists (select 1 from venues where id = p_id) then
      -- surfaces to the service as ConflictError
      --
      -- PT409 rather than a built-in condition name: Postgres reserves codes
      -- ending in three zeroes as trappable categories and tells you not to
      -- raise them, and no assigned class means "this object is already in
      -- the state you asked for". PTxxx is PostgREST's documented escape
      -- hatch, and it carries the honest HTTP status instead of a 500.
      raise exception 'venue % is already retired', p_id using errcode = 'PT409';
    end if;

    -- surfaces to the service as NotFoundError.
    -- Deliberately the same no_data_found that update_venue raises (004), so
    -- one condition has one code across the catalogue. See the follow-up note
    -- about aligning update_venue on PT404.
    raise exception 'venue % not found', p_id using errcode = 'no_data_found';
  end if;

  -- 2. The venue as retired, for the notices. This transaction's own write.
  select v.retired_at, v.name
    into v_retired_at, v_venue_name
    from venues v
   where v.id = p_id;

  -- 2a. Lock every approved booking here that has not ended, in id order as
  --     036 does, re-checking the status on the locked row. A CTE because
  --     Postgres refuses an aggregate beside a locking clause.
  with locked as (
    select b.id
      from bookings b
     where b.venue_id = p_id
       and b.status = 'approved'
       and b.ends_at > now()
     order by b.id
       for no key update of b
  )
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
    into v_locked
    from locked;

  -- 2b. Flag them. No block caused it, so review_block_id stays null and the
  --     reason carries the cause (034's pairing: a time with a cause).
  with flagged as (
    update bookings b
       set status          = 'flagged_for_review',
           review_reason   = 'venue_details_changed',
           review_block_id = null,
           flagged_at      = now(),
           flagged_by      = p_user_id
     where b.id = any (v_locked)
       and b.status = 'approved'
    returning b.id
  )
  select coalesce(array_agg(flagged.id order by flagged.id), '{}'::uuid[])
    into v_flagged
    from flagged;

  -- 3. Tell each flagged booking's coordinator, or every Lead when the event
  --    has none, as 084 does, so no flag goes unseen.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
         'booking_flagged_venue_retired',
         b.id,
         null,
         jsonb_build_object(
           'eventRequestId', er.id,
           'eventName',      er.event_name,
           'venueId',        p_id,
           'venueName',      v_venue_name,
           'startsAt',       b.starts_at,
           'endsAt',         b.ends_at,
           'retiredAt',      v_retired_at
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

  -- 4. Open requests here keep their status (a request occupies nothing, and
  --    only Venue Staff decide it; decide_booking_request now refuses to
  --    approve it), but their coordinator learns the venue is gone. No block,
  --    so 084's once-per-block index treats each as distinct; a venue is only
  --    retired once.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
         'booking_request_venue_unavailable',
         b.id,
         null,
         jsonb_build_object(
           'cause',          'retired',
           'eventRequestId', er.id,
           'eventName',      er.event_name,
           'venueId',        p_id,
           'venueName',      v_venue_name,
           'startsAt',       b.starts_at,
           'endsAt',         b.ends_at,
           'retiredAt',      v_retired_at
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
   where b.venue_id = p_id
     and b.status in ('pending', 'conflicting')
     and b.ends_at > now();
end;
$$;
