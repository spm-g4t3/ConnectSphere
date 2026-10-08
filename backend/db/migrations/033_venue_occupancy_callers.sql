-- ---------------------------------------------------------------------------
-- 033_venue_occupancy_callers.sql
-- SCRUM-484: Every availability check uses the shared occupied period
--
-- Part of SCRUM-484 "Configure Venue Setup and Turnaround Times (Venue
-- Staff)". Run this once in the Supabase SQL Editor, after
-- 032_venue_occupancy.sql (every function below calls
-- venue_occupancy_conflicts() from it). Safe to re-run: the four functions
-- that already exist are `create or replace` with their exact current
-- signatures, available_venue_ids() is new, the revoke is idempotent, and the
-- old helper is dropped with `if exists`.
--
-- What it serves:
--   AC4  The occupied period is calculated by ONE shared function and is the
--        only calculation used wherever availability is decided. 032 wrote
--        that function; this migration moves every SQL caller onto it, and
--        gives the API's venue search one function to call instead of its own
--        JavaScript copy of the rule.
--   AC5  Two periods where one ends exactly when the other starts do not
--        conflict. Inherited: 032 builds every range '[)' and compares with
--        &&, so no caller below writes a period comparison of its own.
--   AC6  A block keeps its own period, with no setup or turnaround added. It
--        conflicts with a booking when it overlaps the booking's occupied
--        period. The block writers ask with p_pad_requested = false.
--   AC7  (payload only) Every booking conflict the screens receive carries
--        occupied_starts_at, occupied_ends_at, setup_minutes and
--        turnaround_minutes beside its own starts_at and ends_at, so a screen
--        can show which part of the clash is setup or turnaround without
--        doing the arithmetic again. Phase 2 renders them.
--
-- Why each function is replaced. Each is copied from its LATEST body and only
-- the period check changes; everything else is word for word:
--
--   * create_venue_block (latest: 014). Its step 5 locked approved bookings
--     whose RAW period overlapped the block, so a block 12:00-12:45 after a
--     booking ending 12:00 at a 30/45 venue was created silently over the
--     booking's turnaround. It now locks the bookings
--     venue_occupancy_conflicts() names. Copied from 014, not 013, because
--     014 added step 8b (flag and notify); copying 013 would lose it.
--   * update_venue_block (latest: 015). The same step for an amendment.
--   * flag_bookings_for_block (latest: 014). It re-applies the overlap rather
--     than trusting its caller, and that re-check was raw. Left raw, it would
--     refuse to flag exactly the bookings the new gate made the Venue Staff
--     member acknowledge -- a booking clashing only through its turnaround
--     would be listed, acknowledged, and then silently not flagged. Its
--     revoke is re-issued because `create or replace` is the moment a grant
--     slip would be noticed least.
--   * create_booking_request (latest: 030; 031 does not redefine it). Step 7
--     had two raw checks, an inline block query and the old helper. One call
--     with p_pad_requested = true replaces both, so the request's own setup
--     and turnaround count too. Flagged bookings now conflict as well (the
--     occupying statuses are approved and flagged_for_review, decision 2).
--   * available_venue_ids (new). Venue search asks "which of these venues is
--     free?" for many venues at once; this answers it with the same function.
--   * venue_block_booking_conflicts (013) is DROPPED, last, once nothing
--     calls it. Left in place it would be a second, raw spelling of the rule
--     that a future caller could pick up by mistake.
--
-- Why the lock and the decision stay in different statements. A stable
-- function cannot take row locks, so the writers keep their own
-- `for no key update` (blocks) and `for share` (requests) and ask
-- venue_occupancy_conflicts() only which rows are involved. The lock order of
-- 013-015 and 030 is unchanged: venue, then bookings in id order.
--
-- Blocks against blocks stay raw and untouched (step 4 of create, step 6 of
-- update): a block has no setup or turnaround, and venue_blocks_no_overlap
-- (011) remains the guarantee.
--
-- Half-open throughout, inherited from 032: no period comparison below uses
-- <= or >=. The `<=` checks that remain are 013's input validation (an end
-- not after its start, an end in the past), not overlap tests.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. Flagging the bookings a block overrides (014, period check replaced)
-- ---------------------------------------------------------------------
-- Same signature and return columns as 014, so create_venue_block and
-- update_venue_block read it unchanged and toBookingConflict maps it as
-- before. The occupied fields are NOT added to its columns: changing a
-- function's OUT columns needs a drop, and its callers report the occupied
-- period in their conflict list already.
--
-- The filters are re-applied rather than trusted, as in 014. Only bookings
-- that are in the list, still approved, on the block's venue and whose
-- OCCUPIED period meets the block's raw period are flagged. The same question
-- the gate asked, through the same function, so the gate and the flag cannot
-- disagree about which bookings a block overrides.
--
-- Every column is qualified with a table alias. The returned column names
-- (booking_id, starts_at, ...) are also plpgsql variables inside the body, and
-- an unqualified reference to one would be refused as ambiguous.
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

  -- 3. Notify. One row per flagged booking for each Event Coordinator.
  --
  --    The payload keys are camelCase because the API returns the payload to
  --    the frontend as it is stored; converting nested jsonb key by key in
  --    the service would buy nothing.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select p.id,
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
   cross join profiles p
   where b.id = any (v_flagged)
     and p.role = 'event_coordinator';

  -- 4. The flagged bookings, soonest first, in 014's column order.
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


-- ---------------------------------------------------------------------
-- 2. Creating a block (014, steps 5 and 6 replaced)
-- ---------------------------------------------------------------------
-- The same eight-parameter signature as 013 and 014, so `create or replace`
-- replaces it in place -- no drop, and no second overload for PostgREST to
-- refuse as ambiguous (the PGRST203 trap 012 and 013 describe).
--
-- Errors and outcomes are 014's. What changes is WHICH bookings count as
-- overlapping: those whose occupied period (padded with the venue's setup and
-- turnaround) meets the block's own, unpadded period. And each conflict now
-- carries that occupied period, for AC7.

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
  v_flagged     jsonb;
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

  -- 5. Lock the approved bookings whose occupied period meets the block.
  --
  -- SCRUM-484: WHICH bookings is venue_occupancy_conflicts()'s answer, with
  -- p_pad_requested = false -- the block keeps its own period (AC6) and each
  -- booking is padded with the venue's setup and turnaround (AC3). So a block
  -- 12:00-12:45 after a booking 10:00-12:00 at a 30/45 venue meets the
  -- booking's 09:30-12:45 and is listed; one from 12:45 only touches it (AC5).
  -- The function is stable and cannot lock, so it only names the rows; this
  -- statement locks them.
  --
  -- b.status = 'approved' stays in THIS query's WHERE, not just inside the
  -- function. The function also returns flagged_for_review bookings, which a
  -- block must not flag again. And under READ COMMITTED a row that changed
  -- while we waited for its lock is re-checked against this WHERE on its new
  -- version, so a booking cancelled or flagged in the meantime drops out
  -- rather than being reported as a conflict. The subquery's ids come from
  -- the statement's snapshot; the status re-check is what keeps them honest.
  --
  -- "for no key update" because it is the lock flag_bookings_for_block's
  -- UPDATE of the booking status will need. "for share" would let two callers
  -- share the rows and then deadlock when each tried to upgrade to write them.
  --
  -- Ordered by id so every caller takes the locks in the same order, which is
  -- what keeps two overlapping requests from deadlocking each other.
  --
  -- A CTE because Postgres refuses an aggregate in the same query as a
  -- locking clause; the aggregate runs outside it, over the locked rows.
  with locked as (
    select b.id
      from bookings b
     where b.status = 'approved'
       and b.id in (
             select c.id
               from venue_occupancy_conflicts(p_venue_id, p_starts_at, p_ends_at, false) c
              where c.kind = 'booking'
           )
     order by b.id
       for no key update of b
  )
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
    into v_live_ids
    from locked;

  -- 6. The conflict list, as the Venue Staff member will see it: the shared
  --    function's booking rows, restricted to the bookings actually locked
  --    above, soonest first.
  --
  --    013's five keys are kept, so nothing that reads them breaks. The four
  --    occupied keys are added for AC7: the booking's occupied period and the
  --    minutes that produced it, so the screen can say "Setup 09:30-10:00 ·
  --    Event 10:00-12:00 · Turnaround 12:00-12:45" and show why a block that
  --    does not touch the event itself still clashes.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',         c.id,
               'event_request_id',   c.event_request_id,
               'event_name',         c.event_name,
               'starts_at',          c.starts_at,
               'ends_at',            c.ends_at,
               'occupied_starts_at', c.occupied_starts_at,
               'occupied_ends_at',   c.occupied_ends_at,
               'setup_minutes',      c.setup_minutes,
               'turnaround_minutes', c.turnaround_minutes
             )
             order by c.starts_at, c.id
           ),
           '[]'::jsonb
         )
    into v_conflicts
    from venue_occupancy_conflicts(p_venue_id, p_starts_at, p_ends_at, false) c
   where c.kind = 'booking'
     and c.id = any (v_live_ids);

  -- 7. The gate. With live conflicts, the block is created only when the
  --    caller confirmed the override AND acknowledged every live conflict.
  --    Otherwise answer with the list and write nothing.
  if cardinality(v_live_ids) > 0
     and not (coalesce(p_confirm_override, false)
              and v_live_ids <@ coalesce(p_acknowledged_booking_ids, '{}'))
  then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. Insert. created_by and last_modified_by are both the acting user, as
  --    011 asks, so a later audit trigger can read the author off the row.
  insert into venue_blocks (
    venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by
  )
  values (
    p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id
  )
  returning * into v_block;

  -- 8b. SCRUM-128: flag the overridden bookings and notify Event Coordinators.
  --
  -- AFTER the insert, not between the gate and the insert where 013 left its
  -- marker. bookings.review_block_id is a foreign key to venue_blocks, and
  -- that key is checked immediately, statement by statement -- so a booking
  -- can only point at the block once the block's row exists, and its id is
  -- only known from `returning` above.
  --
  -- Moving it costs nothing. It is still the same transaction, so a failure
  -- here rolls back the insert too, and the step-5 locks on the bookings are
  -- still held, so no booking can change between the gate and the flag.
  --
  -- With no live conflicts v_live_ids is empty and the call flags nothing,
  -- so every created outcome carries the list, '[]' when there is none.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',       f.booking_id,
               'event_request_id', f.event_request_id,
               'event_name',       f.event_name,
               'starts_at',        f.starts_at,
               'ends_at',          f.ends_at
             )
             order by f.starts_at, f.booking_id
           ),
           '[]'::jsonb
         )
    into v_flagged
    from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;

  -- 9. 013's outcome, plus the bookings actually flagged ('[]' when none).
  return jsonb_build_object(
    'outcome',           'created',
    'block',             to_jsonb(v_block),
    'affected_bookings', v_conflicts,
    'flagged_bookings',  v_flagged
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Amending a block (015, step 7 replaced)
-- ---------------------------------------------------------------------
-- 015's ten-parameter signature, unchanged, so `create or replace` replaces
-- it in place. Errors and outcomes are 015's. The booking step is
-- create_venue_block's new step 5 and 6 above, with the merged bounds.

create or replace function update_venue_block(
  p_venue_id                 uuid,
  p_block_id                 uuid,
  p_starts_at                timestamptz default null,
  p_ends_at                  timestamptz default null,
  p_reason                   venue_block_reason default null,
  p_notes                    text default null,
  p_notes_supplied           boolean default false,
  p_user_id                  uuid default null,
  p_confirm_override         boolean default false,
  p_acknowledged_booking_ids uuid[] default null
)
returns jsonb
language plpgsql
as $$
declare
  v_retired_at  timestamptz;
  v_block       venue_blocks;
  v_starts_at   timestamptz;
  v_ends_at     timestamptz;
  v_reason      venue_block_reason;
  v_notes       text;
  v_overlap_id  uuid;
  v_live_ids    uuid[];
  v_conflicts   jsonb;
  v_flagged     jsonb;
begin
  -- 1. Lock the venue, as create_venue_block does and for the reason it gives.
  --
  -- Venue first, then block, in every function that takes both, so two
  -- writers on the same venue always queue in the same order and cannot
  -- deadlock. It also serialises this amendment against a create on the same
  -- venue, which the block-overlap check below relies on.
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for no key update;

  if not found then
    -- The same condition 004, 005 and 012 raise for a missing venue.
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 2. Lock the block, scoped to the venue.
  --
  -- Scoped by both ids so a block cannot be amended through another venue's
  -- URL, the same rule getVenueBlock follows. A block on the wrong venue is
  -- answered exactly like a missing one, so the URL reveals nothing.
  select *
    into v_block
    from venue_blocks vb
   where vb.id = p_block_id
     and vb.venue_id = p_venue_id
     for no key update;

  if not found then
    raise exception 'venue block % not found on venue %', p_block_id, p_venue_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Refuse by state, most final first, so the caller is told the reason
  --    that would still stand after fixing the others.
  --
  -- A removed block is 409, not 404: the row still exists, and saying so
  -- matches retire_venue's answer for an already-retired venue (005).
  if v_block.removed_at is not null then
    raise exception 'venue block % has been removed', p_block_id
      using errcode = 'PT409', hint = 'BLOCK_REMOVED';
  end if;

  -- Judged on the STORED end. Extending an ended block back into the future
  -- would be a new closure wearing an old one's history; create one instead.
  if v_block.ends_at <= now() then
    raise exception 'venue block % has already ended and cannot be changed', p_block_id
      using errcode = 'PT409', hint = 'BLOCK_ENDED';
  end if;

  -- After the block checks, because a removed or ended block cannot be
  -- amended on any venue, while a retired venue is the only reason left.
  if v_retired_at is not null then
    raise exception 'venue % is retired and its blocks cannot be changed', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 4. Merge the patch onto the stored row.
  --
  -- coalesce is safe for the three fields because none of their columns may
  -- be null, so null can only ever mean "not sent". coalesce on the flag
  -- treats a null p_notes_supplied as false: keeping is the harmless guess.
  v_starts_at := coalesce(p_starts_at, v_block.starts_at);
  v_ends_at   := coalesce(p_ends_at,   v_block.ends_at);
  v_reason    := coalesce(p_reason,    v_block.reason);
  v_notes     := case when coalesce(p_notes_supplied, false)
                      then p_notes
                      else v_block.notes
                 end;

  -- 5. The merged period, checked BEFORE any range value is built, with the
  --    same messages as create_venue_block (012-014) and for the reasons it
  --    gives: a reversed range raises 22000, a null bound matches everything.
  --
  -- Only the merged values tell the truth here. A new start alone can land
  -- after the stored end, which the validator cannot see.
  if v_starts_at is null or v_ends_at is null then
    raise exception 'a block needs both a start and an end'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_ends_at <= v_starts_at then
    raise exception 'a block must end after it starts'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The start may move into the past, as create allows; the end may not.
  if v_ends_at <= now() then
    raise exception 'a block must end in the future'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Mirrors venue_blocks_other_needs_notes in 011, raised here as 22023 so it
  -- reads as a validation fault rather than a constraint name. Needed in the
  -- function because only it can see the stored notes: changing the reason
  -- to other on a block with no notes, or clearing the notes on an other
  -- block, are both patches the validator sees half of.
  if v_reason = 'other' and length(trim(coalesce(v_notes, ''))) = 0 then
    raise exception 'a block with reason other needs notes'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 6. Overlap with another active block: create_venue_block's query, with
  --    the block itself excluded so it never clashes with its own old period.
  select vb.id
    into v_overlap_id
    from venue_blocks vb
   where vb.venue_id = p_venue_id
     and vb.removed_at is null
     and vb.id <> p_block_id
     and tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')
   order by vb.starts_at, vb.id
   limit 1;

  if v_overlap_id is not null then
    raise exception 'this period overlaps another block on venue %', p_venue_id
      using errcode = 'PT409',
            hint    = 'BLOCK_OVERLAPS_BLOCK',
            detail  = v_overlap_id::text;
  end if;

  -- 7. Lock the approved bookings whose occupied period meets the merged
  --    period -- step 5 of create_venue_block above, with the merged bounds,
  --    and for the reasons it gives: the shared function names the rows
  --    (block unpadded, bookings padded), this statement locks them, and
  --    b.status = 'approved' in this WHERE is re-checked after a lock wait.
  --
  -- Only bookings this amendment newly overlaps are found. Bookings this
  -- block already flagged are flagged_for_review, not approved, so they drop
  -- out of the filter and are neither listed again nor re-notified -- even
  -- though the shared function, which counts flagged bookings as occupying,
  -- still returns them.
  with locked as (
    select b.id
      from bookings b
     where b.status = 'approved'
       and b.id in (
             select c.id
               from venue_occupancy_conflicts(p_venue_id, v_starts_at, v_ends_at, false) c
              where c.kind = 'booking'
           )
     order by b.id
       for no key update of b
  )
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
    into v_live_ids
    from locked;

  -- The conflict list, built as create_venue_block's step 6 builds it: 013's
  -- keys plus the occupied period and minutes for AC7.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',         c.id,
               'event_request_id',   c.event_request_id,
               'event_name',         c.event_name,
               'starts_at',          c.starts_at,
               'ends_at',            c.ends_at,
               'occupied_starts_at', c.occupied_starts_at,
               'occupied_ends_at',   c.occupied_ends_at,
               'setup_minutes',      c.setup_minutes,
               'turnaround_minutes', c.turnaround_minutes
             )
             order by c.starts_at, c.id
           ),
           '[]'::jsonb
         )
    into v_conflicts
    from venue_occupancy_conflicts(p_venue_id, v_starts_at, v_ends_at, false) c
   where c.kind = 'booking'
     and c.id = any (v_live_ids);

  -- The gate, word for word create_venue_block's (013, step 7), so an amended
  -- block and a new one obey one acknowledgement rule.
  if cardinality(v_live_ids) > 0
     and not (coalesce(p_confirm_override, false)
              and v_live_ids <@ coalesce(p_acknowledged_booking_ids, '{}'))
  then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. Write. One statement, so the new values and last_modified_by move
  --    together and a later audit trigger reads the amender off the row.
  --
  -- last_modified_by is assigned, not coalesced, as update_venue does it
  -- (004): a NULL user records a NULL, "changed outside the app". A patch that
  -- changes nothing still writes it -- the request was an amendment, and who
  -- made it is the AC4 record.
  update venue_blocks vb
     set starts_at        = v_starts_at,
         ends_at          = v_ends_at,
         reason           = v_reason,
         notes            = v_notes,
         last_modified_by = p_user_id
   where vb.id = p_block_id
  returning * into v_block;

  -- 9. Flag the overridden bookings, AFTER the update.
  --
  -- flag_bookings_for_block re-reads the block and re-applies its period, so
  -- before the update it would see the OLD period and silently skip every
  -- booking in the extended part. Passing p_user_id makes flagged_by record
  -- the amender, not the block's creator.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'booking_id',       f.booking_id,
               'event_request_id', f.event_request_id,
               'event_name',       f.event_name,
               'starts_at',        f.starts_at,
               'ends_at',          f.ends_at
             )
             order by f.starts_at, f.booking_id
           ),
           '[]'::jsonb
         )
    into v_flagged
    from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;

  -- 10. The created outcome's shape (014), under its own name.
  return jsonb_build_object(
    'outcome',           'updated',
    'block',             to_jsonb(v_block),
    'affected_bookings', v_conflicts,
    'flagged_bookings',  v_flagged
  );
end;
$$;

-- As in 015: it writes p_user_id, so only the API should reach it.
revoke execute on function update_venue_block(uuid, uuid, timestamptz, timestamptz, venue_block_reason, text, boolean, uuid, boolean, uuid[]) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. Creating a booking request (030, step 7 replaced)
-- ---------------------------------------------------------------------
-- 030's seven-parameter signature, unchanged; 031 does not redefine it.
-- Errors, outcomes, locks and every other step are 030's word for word (see
-- 030's header for the locking protocol and the error table).
--
-- Step 7 is now one call with p_pad_requested = true: the requested event
-- needs its own setup before it and turnaround after it, so it is padded as
-- well as every booking it is compared with (032's header, "Why both sides
-- are padded"). Blocks stay raw. The call runs under the step-4 `for share`
-- venue lock, so no block can be created or amended on this venue between the
-- check and the insert.

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

  -- 7. The period, through the shared function (SCRUM-484).
  --
  --    One call answers both kinds: active blocks, compared raw, and occupying
  --    bookings (approved and flagged_for_review), padded with the venue's
  --    setup and turnaround. p_pad_requested = true pads the event's own
  --    period too, so at a 30/45 venue an event can start at 13:15 after a
  --    booking ending 12:00, and not at 13:14. Touching is clear (AC5).
  --
  --    Each kind keeps 030's keys, so the service and the screen read what
  --    they read before, and both gain the occupied period and the venue's
  --    minutes (AC7). On a block row the occupied times equal its own -- a
  --    block is never padded -- while the minutes say how far this event's
  --    own setup and turnaround reached into it.
  --
  --    Ordered as 030 ordered it -- blocks first, then bookings, each
  --    soonest first -- so the list a coordinator sees keeps its order.
  --
  --    The event's own bookings cannot appear: step 6 has already refused an
  --    event holding a pending, approved or flagged booking.
  select coalesce(
           jsonb_agg(
             case c.kind
               when 'block' then
                 jsonb_build_object(
                   'kind',               'block',
                   'block_id',           c.id,
                   'starts_at',          c.starts_at,
                   'ends_at',            c.ends_at,
                   'reason',             c.reason,
                   'occupied_starts_at', c.occupied_starts_at,
                   'occupied_ends_at',   c.occupied_ends_at,
                   'setup_minutes',      c.setup_minutes,
                   'turnaround_minutes', c.turnaround_minutes
                 )
               else
                 jsonb_build_object(
                   'kind',               'booking',
                   'booking_id',         c.id,
                   'event_request_id',   c.event_request_id,
                   'event_name',         c.event_name,
                   'starts_at',          c.starts_at,
                   'ends_at',            c.ends_at,
                   'occupied_starts_at', c.occupied_starts_at,
                   'occupied_ends_at',   c.occupied_ends_at,
                   'setup_minutes',      c.setup_minutes,
                   'turnaround_minutes', c.turnaround_minutes
                 )
             end
             order by (c.kind = 'booking'), c.starts_at, c.id
           ),
           '[]'::jsonb
         )
    into v_conflicts
    from venue_occupancy_conflicts(p_venue_id, v_event.proposed_start, v_event.proposed_end, true) c;

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

-- As in 030: only the API should reach this.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. Which of these venues is free for a period
-- ---------------------------------------------------------------------
-- For venue search: given candidate venues and the event's period, the ones
-- nothing occupies. "Free" is exactly "venue_occupancy_conflicts() returns no
-- row" with the request padded (p_pad_requested = true), the same question
-- create_booking_request asks before it writes -- so a venue search offers
-- precisely the venues a request would then accept, on the period rule.
--
-- This replaces SCRUM-139's JavaScript copy of the rule
-- (domain/venueOccupancy.js), which widened its read by the largest possible
-- setup plus turnaround and then re-applied each venue's minutes in JS. That
-- was a second spelling of the formula; AC4 allows one.
--
-- Takes a list rather than one id so search makes ONE round trip for every
-- candidate, not one per venue. `not exists` stops at a venue's first
-- conflict rather than listing them all; search never says why a venue was
-- left out (SCRUM-145), so it only needs yes or no.
--
-- A null bound returns no venue at all, not every venue. 032's functions are
-- strict, so a null period would match no conflict and every venue would look
-- free; failing closed is the safe answer to a broken request. The service
-- validates both bounds before it calls, so this is a backstop.
--
-- An id that names no venue comes back as free: 032 answers an unknown venue
-- with no rows. Search passes only ids it has just read from venues, so that
-- cannot mislead it. `distinct` so a repeated id is answered once.
--
-- The order of the result is not meaningful; search keeps its own name order.
--
-- `returns table (venue_id uuid)`, not `setof uuid`. PostgREST always answers
-- a table result as an array of objects, [{venue_id: ...}], while its shape
-- for a set of bare scalars is less certain across versions. A named column
-- gives the API one shape to read, and the name says what the id is.
--
-- stable, takes no locks, and keeps the default grants, for 032's reasons: it
-- only reads, and trusts nothing it is passed.

create or replace function available_venue_ids(
  p_venue_ids uuid[],
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns table (venue_id uuid)
language sql
stable
as $$
  select distinct candidate.id as venue_id
    from unnest(p_venue_ids) as candidate(id)
   where candidate.id is not null
     and p_starts_at is not null
     and p_ends_at is not null
     and not exists (
           select 1
             from venue_occupancy_conflicts(candidate.id, p_starts_at, p_ends_at, true)
         );
$$;


-- ---------------------------------------------------------------------
-- 6. Retire the raw helper
-- ---------------------------------------------------------------------
-- 013's venue_block_booking_conflicts() compared raw periods. Its three
-- callers -- create_venue_block (014), update_venue_block (015) and
-- create_booking_request (030) -- were all replaced above and no longer call
-- it, and nothing else in the migrations or the API does. Dropped LAST, so the
-- functions that used it are never left pointing at a missing function, even
-- if this file is run statement by statement.

drop function if exists venue_block_booking_conflicts(uuid, timestamptz, timestamptz);


-- PostgREST caches the schema; without this available_venue_ids answers
-- PGRST202 "not found" until the cache next reloads.
notify pgrst, 'reload schema';
