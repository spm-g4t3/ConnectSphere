-- 013_venue_block_booking_conflicts.sql
-- SCRUM-125: Overlap detection and override for venue blocks
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after 012_venue_block_creation.sql.
--
-- AC3: "A block that overlaps an existing approved booking is not created
-- silently: the conflicting bookings are listed to the Venue Staff member, who
-- must either choose a non-overlapping period or explicitly confirm the
-- override, in which case each affected booking is flagged for review and its
-- Event Coordinator is notified."
--
-- This migration is the first half of that: detection and the explicit
-- override. Flagging the bookings and notifying Event Coordinators is
-- SCRUM-128, which goes inside create_venue_block below, using the booking
-- locks this migration takes.
--
-- Two things happen here:
--   * venue_block_booking_conflicts() answers "which approved bookings
--     overlap this period at this venue?" -- a read with no side effects, so
--     a later preview endpoint can call it without creating anything.
--   * create_venue_block is redefined with two extra parameters,
--     p_confirm_override and p_acknowledged_booking_ids. A block over approved
--     bookings is created only when the caller confirms the override AND has
--     acknowledged every one of the bookings that still conflict. Otherwise
--     the function answers {outcome: 'conflict', conflicts} and writes nothing.
--
-- Acknowledgement rule: every LIVE conflicting booking must be in the
-- acknowledged list. Extra ids -- a booking cancelled since the list was shown
-- -- are harmless. A booking that appeared since is not acknowledged, so the
-- caller sees the list again rather than overriding something it never saw.
--
-- KNOWN GAP: nothing inserts bookings today, so a booking created concurrently
-- with a block is not guarded against. The venue lock below does not stop a
-- booking insert (its foreign key takes only "for key share"). Whoever writes
-- the booking writer should take "for share" on the venue row, which
-- conflicts with the "for no key update" this function holds.


-- ---------------------------------------------------------------------
-- 1. Drop the 012 signature
-- ---------------------------------------------------------------------
-- `create or replace` with a different parameter list does NOT replace -- it
-- creates a second overload, and PostgREST then refuses the call as ambiguous
-- (PGRST203). 012's header asks for exactly this line.

drop function if exists create_venue_block(uuid, timestamptz, timestamptz, venue_block_reason, text, uuid);


-- ---------------------------------------------------------------------
-- 2. Which approved bookings overlap a period
-- ---------------------------------------------------------------------
-- Plain comparisons rather than tstzrange, for three reasons:
--   * starts_at < p_ends_at and ends_at > p_starts_at means the same as a
--     half-open '[)' overlap, so a booking that only touches the period at a
--     boundary does not conflict -- the same rule blocks use among themselves;
--   * they can use idx_bookings_venue_approved from 011;
--   * a null or reversed bound cannot raise an error, it just matches nothing.
--
-- Stable, and takes no locks: a stable function cannot take row locks.
-- create_venue_block locks the rows itself and then reads this.

create or replace function venue_block_booking_conflicts(
  p_venue_id  uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns table (
  booking_id       uuid,
  event_request_id uuid,
  event_name       text,
  starts_at        timestamptz,
  ends_at          timestamptz
)
language sql
stable
as $$
  select b.id, b.event_request_id, er.event_name, b.starts_at, b.ends_at
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.venue_id = p_venue_id
     and b.status = 'approved'
     and b.starts_at < p_ends_at
     and b.ends_at > p_starts_at
   order by b.starts_at, b.id;
$$;


-- ---------------------------------------------------------------------
-- 3. Creating a block
-- ---------------------------------------------------------------------
-- Errors, and what the service turns them into (venueBlockService.js), are
-- unchanged from 012:
--
--   no_data_found (P0002)  no such venue                    -> NotFoundError
--   PT409, hint VENUE_RETIRED         venue is retired      -> ConflictError
--   22023 invalid_parameter_value     period out of order,
--                                     or already ended      -> ValidationError
--   PT409, hint BLOCK_OVERLAPS_BLOCK  another active block
--                                     overlaps; its id is
--                                     in DETAIL             -> ConflictError
--   23P01 exclusion_violation         the same overlap, if
--                                     a concurrent insert
--                                     won the race          -> ConflictError
--
-- Booking conflicts are NOT an error: they are an outcome,
-- {outcome: 'conflict', conflicts}, which the service turns into a
-- ConflictError with code BLOCK_BOOKING_CONFLICT. An outcome rather than a
-- raise so the list of bookings arrives as structured jsonb, not prose.
--
-- A block-on-block overlap is checked first, because it cannot be overridden:
-- listing bookings to override would be pointless when the block could never
-- be created anyway.

create or replace function create_venue_block(
  p_venue_id                 uuid,
  p_starts_at                timestamptz,
  p_ends_at                  timestamptz,
  p_reason                   venue_block_reason,
  p_notes                    text default null,
  p_user_id                  uuid default null,
  p_confirm_override         boolean default false,
  p_acknowledged_booking_ids uuid[] default null
)
returns jsonb
language plpgsql
as $$
declare
  v_retired_at  timestamptz;
  v_overlap_id  uuid;
  v_live_ids    uuid[];
  v_conflicts   jsonb;
  v_block       venue_blocks;
begin
  -- 1. Lock the venue.
  --
  -- "for no key update" rather than "for update": it conflicts with
  -- retire_venue's UPDATE and with a second create_venue_block on the same
  -- venue, which is what serialises them, but not with the "for key share"
  -- lock a foreign-key insert takes -- so bookings can still be written
  -- against this venue while a block is being created.
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for no key update;

  if not found then
    -- The same condition update_venue (004) and retire_venue (005) raise, so
    -- "venue not found" has one code across the catalogue.
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 2. A retired venue cannot be blocked: it is already out of use, and a
  --    block on it would be a record of nothing.
  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be blocked', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 3. The period, checked BEFORE any range value is built.
  --
  -- A range constructed with its bounds reversed does not come back empty, it
  -- raises 22000 ("range lower bound must be less than or equal to range
  -- upper bound"), which no translation maps and which would surface as a
  -- 500. Checking the order here first means the overlap query below only
  -- ever sees a well-formed range.
  --
  -- Nulls are refused here too. The columns are not null, but a null bound
  -- would make the range unbounded and the overlap query would match every
  -- block on the venue.
  if p_starts_at is null or p_ends_at is null then
    raise exception 'a block needs both a start and an end'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'a block must end after it starts'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The start may be in the past -- a closure that has already begun is still
  -- worth recording -- but a block that has already ended blocks nothing.
  if p_ends_at <= now() then
    raise exception 'a block must end in the future'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 4. Overlap with another active block.
  --
  -- '[)' to match venue_blocks_no_overlap in 011, so blocks that touch at a
  -- boundary do not overlap. The exclusion constraint stays the guarantee;
  -- this check exists to name the block that clashed. The venue lock above
  -- means no other create_venue_block can insert between this read and the
  -- insert below.
  select id
    into v_overlap_id
    from venue_blocks
   where venue_id = p_venue_id
     and removed_at is null
     and tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
   order by starts_at, id
   limit 1;

  if v_overlap_id is not null then
    raise exception 'this period overlaps another block on venue %', p_venue_id
      using errcode = 'PT409',
            hint    = 'BLOCK_OVERLAPS_BLOCK',
            detail  = v_overlap_id::text;
  end if;

  -- 5. Lock the approved bookings that overlap the period.
  --
  -- "for no key update" because it is the lock SCRUM-128's UPDATE of the
  -- booking status will need. "for share" would let two callers share the
  -- rows and then deadlock when each tried to upgrade to write them.
  --
  -- Ordered by id so every caller takes the locks in the same order, which is
  -- what keeps two overlapping requests from deadlocking each other.
  --
  -- A CTE because Postgres refuses an aggregate in the same query as a
  -- locking clause; the aggregate runs outside it, over the locked rows.
  --
  -- Under READ COMMITTED a row that changed while we waited for its lock is
  -- re-checked against the WHERE, so a booking cancelled in the meantime
  -- drops out rather than being reported as a conflict.
  with locked as (
    select b.id
      from bookings b
     where b.venue_id = p_venue_id
       and b.status = 'approved'
       and b.starts_at < p_ends_at
       and b.ends_at > p_starts_at
     order by b.id
       for no key update of b
  )
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
    into v_live_ids
    from locked;

  -- 6. The conflict list, as the Venue Staff member will see it: the helper's
  --    rows, restricted to the bookings actually locked above, soonest first.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
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
    into v_conflicts
    from venue_block_booking_conflicts(p_venue_id, p_starts_at, p_ends_at) c
   where c.booking_id = any (v_live_ids);

  -- 7. The gate. With live conflicts, the block is created only when the
  --    caller confirmed the override AND acknowledged every live conflict.
  --    Otherwise answer with the list and write nothing.
  if cardinality(v_live_ids) > 0
     and not (coalesce(p_confirm_override, false)
              and v_live_ids <@ coalesce(p_acknowledged_booking_ids, '{}'))
  then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- >>> SCRUM-128 inserts its step HERE, between the gate and the insert:
  -- >>> flag each booking in v_live_ids for review (status
  -- >>> 'flagged_for_review') and notify its Event Coordinator. The rows are
  -- >>> already locked "for no key update" by step 5, so that UPDATE cannot
  -- >>> block or deadlock on them.

  -- 8. Insert. created_by and last_modified_by are both the acting user, as
  --    011 asks, so a later audit trigger can read the author off the row.
  insert into venue_blocks (
    venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by
  )
  values (
    p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id
  )
  returning * into v_block;

  -- 9. The outcome shape 012 promised, plus the bookings the override
  --    covered ('[]' when there were none).
  return jsonb_build_object(
    'outcome',           'created',
    'block',             to_jsonb(v_block),
    'affected_bookings', v_conflicts
  );
end;
$$;
