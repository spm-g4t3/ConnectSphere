-- 015_venue_block_amend_remove.sql
-- SCRUM-127: Amend and remove venue blocks
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after
-- 014_booking_review_notifications.sql. Safe to re-run: both functions are
-- `create or replace` with signatures no earlier migration defines.
--
-- AC4: "A block can be shortened, extended or removed, and the change records
-- who made it and when."
--
-- Two functions, and nothing else:
--   * update_venue_block() amends a block's period, reason or notes. An
--     amendment can widen the period over approved bookings, so it runs the
--     same booking gate as create_venue_block (014) and, on an override, the
--     same flag_bookings_for_block. AC3 does not stop applying because the
--     block already existed.
--   * remove_venue_block() soft-deletes a block, as 011 designed: removed_at
--     and removed_by are set, the row survives, and the audit trail still has
--     something to point at.
--
-- Why functions rather than an UPDATE from JavaScript: the same reason 012
-- gives for creation. The state checks (removed, ended, retired), the overlap
-- checks and the booking locks are reads that must hold until the write
-- commits, and PostgREST gives each supabase-js call its own transaction.
--
-- Ended blocks are read-only, to both functions. A past closure really
-- happened, bookings it flagged point at it through review_block_id, and
-- changing or removing it would rewrite history without unblocking anything.
--
-- Neither function unflags bookings. Shortening or removing a block leaves
-- every booking it flagged as flagged_for_review: a Coordinator resolves each
-- one by hand (SCRUM-266), which is the customer's "adjustments must be
-- handled manually".
--
-- Grants: execute on both functions is revoked from public, anon and
-- authenticated, following the house pattern 014 began. They take p_user_id
-- from the caller and write it into last_modified_by and removed_by, so left
-- callable through PostgREST's /rpc endpoint they would let anyone holding
-- the publishable key amend a block in someone else's name. The API calls
-- with the secret key (service_role), which keeps its own grant.
--
-- FOLLOW-UP: create_venue_block (012-014) takes p_user_id the same way and is
-- still callable by anon and authenticated. Revoking it is a one-line
-- migration, left out of this one so this ticket does not redefine or regrant
-- a function it does not otherwise touch.


-- ---------------------------------------------------------------------
-- 1. Amending a block
-- ---------------------------------------------------------------------
-- A patch, not a replacement: a null p_starts_at, p_ends_at or p_reason means
-- "keep the stored value". Notes need a separate flag, because for notes null
-- is a real value ("clear them") as well as "not sent":
--
--   p_notes_supplied false            keep the stored notes
--   p_notes_supplied true,  p_notes   replace them with p_notes
--   p_notes_supplied true,  null      clear them
--
-- Errors, and what the service turns them into (venueBlockService.js):
--
--   no_data_found (P0002)  no such venue, or no such block
--                          on that venue                    -> NotFoundError
--   PT409, hint BLOCK_REMOVED         block was removed     -> ConflictError
--   PT409, hint BLOCK_ENDED           block has ended       -> ConflictError
--   PT409, hint VENUE_RETIRED         venue is retired      -> ConflictError
--   22023 invalid_parameter_value     merged period out of
--                                     order or already
--                                     ended, or reason
--                                     other without notes   -> ValidationError
--   PT409, hint BLOCK_OVERLAPS_BLOCK  another active block
--                                     overlaps; its id is
--                                     in DETAIL             -> ConflictError
--   23P01 exclusion_violation         the same overlap, if
--                                     a concurrent write
--                                     won the race          -> ConflictError
--
-- Booking conflicts are an outcome, not an error, exactly as in 013:
-- {outcome: 'conflict', conflicts}, and nothing is written.

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

  -- 7. Lock the approved bookings the merged period overlaps -- step 5 of
  --    create_venue_block, with the merged bounds.
  --
  -- Only bookings this amendment newly overlaps are found. Bookings this
  -- block already flagged are flagged_for_review, not approved, so they drop
  -- out of the filter and are neither listed again nor re-notified.
  with locked as (
    select b.id
      from bookings b
     where b.venue_id = p_venue_id
       and b.status = 'approved'
       and b.starts_at < v_ends_at
       and b.ends_at > v_starts_at
     order by b.id
       for no key update of b
  )
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[])
    into v_live_ids
    from locked;

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
    from venue_block_booking_conflicts(p_venue_id, v_starts_at, v_ends_at) c
   where c.booking_id = any (v_live_ids);

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

-- See the header: it writes p_user_id, so only the API should reach it.
revoke execute on function update_venue_block(uuid, uuid, timestamptz, timestamptz, venue_block_reason, text, boolean, uuid, boolean, uuid[]) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. Removing a block
-- ---------------------------------------------------------------------
-- A soft delete, never a DELETE: 011 designed removed_at for this, and
-- bookings this block flagged point at it through review_block_id.
--
-- Errors, and what the service turns them into (venueBlockService.js):
--
--   no_data_found (P0002)  no such venue, or no such block
--                          on that venue                    -> NotFoundError
--   PT409, hint BLOCK_REMOVED         already removed       -> ConflictError
--   PT409, hint BLOCK_ENDED           block has ended       -> ConflictError
--
-- Deliberately no VENUE_RETIRED: removing a block only reduces blocking, so a
-- retired venue gives no reason to refuse it. Deliberately no booking work
-- either: see the header on why nothing is unflagged.

create or replace function remove_venue_block(
  p_venue_id uuid,
  p_block_id uuid,
  p_user_id  uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_block venue_blocks;
begin
  -- 1. Lock the venue, then the block: the order update_venue_block and
  --    create_venue_block use, so a removal and an amendment of the same
  --    block queue rather than deadlock. Nothing is read off the venue row;
  --    the lock is the point, so `perform`.
  perform 1
     from venues
    where id = p_venue_id
      for no key update;

  if not found then
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

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

  -- 2. Refuse by state, in update_venue_block's order. A second removal is a
  --    409 rather than a silent success, so the first remover's removed_at
  --    and removed_by are never overwritten.
  if v_block.removed_at is not null then
    raise exception 'venue block % has been removed', p_block_id
      using errcode = 'PT409', hint = 'BLOCK_REMOVED';
  end if;

  if v_block.ends_at <= now() then
    raise exception 'venue block % has already ended and cannot be changed', p_block_id
      using errcode = 'PT409', hint = 'BLOCK_ENDED';
  end if;

  -- 3. One statement, so removed_by and last_modified_by agree with
  --    removed_at -- the same attribution argument 005 makes for retirement.
  update venue_blocks vb
     set removed_at       = now(),
         removed_by       = p_user_id,
         last_modified_by = p_user_id
   where vb.id = p_block_id
  returning * into v_block;

  return jsonb_build_object('outcome', 'removed', 'block', to_jsonb(v_block));
end;
$$;

-- See the header: it writes p_user_id, so only the API should reach it.
revoke execute on function remove_venue_block(uuid, uuid, uuid) from public, anon, authenticated;


-- PostgREST caches the schema; without this the two new functions answer
-- PGRST202 "not found" until the cache next reloads.
notify pgrst, 'reload schema';
