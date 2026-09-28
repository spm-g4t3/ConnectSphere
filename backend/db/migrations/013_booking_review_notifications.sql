-- 013_booking_review_notifications.sql
-- SCRUM-128: Flag affected bookings for review and notify Event Coordinators
--
-- Part of SCRUM-17 "Block a Venue for Unavailability (Venue Staff)".
-- Run this once in the Supabase SQL Editor, after
-- 012_venue_block_booking_conflicts.sql. Safe to re-run, like 010: every
-- column, constraint, table and index is guarded, and both functions are
-- `create or replace`.
--
-- AC3: "... explicitly confirm the override, in which case each affected
-- booking is flagged for review and its Event Coordinator is notified."
--
-- 012 did the detection and the override gate; this is the second half. Four
-- things happen here:
--   * bookings gains review_block_id, flagged_at and flagged_by, so a flagged
--     booking records WHICH block flagged it, WHEN, and WHO confirmed the
--     override -- not just a status that says "something happened".
--   * notifications is created: one row per recipient per event, read by the
--     Coordinator dashboard through the API.
--   * flag_bookings_for_block() does the flagging and the notifying in one
--     place, so the rule "flag means notify" cannot be half-applied.
--   * create_venue_block is redefined -- same signature, so no drop -- to call
--     it after the insert, and to report the bookings it actually flagged.
--
-- Who is notified: every Event Coordinator. The criterion says "its Event
-- Coordinator", but nothing assigns a Coordinator to an event request yet, so
-- there is no narrower audience to pick. When an assignment column exists,
-- only the recipient query in section 3 changes. With no Coordinators at all
-- the bookings are still flagged and the block still created -- a missing
-- audience must not undo the override the Venue Staff member confirmed.
--
-- NEW HOUSE PATTERN, section 3: execute on flag_bookings_for_block is
-- revoked from public, anon and authenticated. Earlier functions were left
-- with Postgres's default grant because every one of them re-checks its own
-- input. This one does not: it trusts that the caller locked the bookings and
-- confirmed the override, which only create_venue_block does. Left callable,
-- anyone holding the publishable key could flag any booking through
-- PostgREST's /rpc endpoint without passing the gate. The API calls with the
-- secret key (service_role), which keeps its own grant, and
-- create_venue_block runs with the caller's rights, so it can still call it.


-- ---------------------------------------------------------------------
-- 1. Bookings gain review columns (extends 009 and 010)
-- ---------------------------------------------------------------------
-- on delete set null for the block: blocks are soft-deleted, so a hard delete
-- only happens outside the app, and it should not take the booking with it.
-- The booking keeps flagged_at, which still says it was flagged.
--
-- flagged_by is nullable for the reason 003 and 010 give for *_by columns:
-- NULL is the honest record of "done outside the app".

alter table bookings
  add column if not exists review_block_id uuid references venue_blocks (id) on delete set null,
  add column if not exists flagged_at      timestamptz,
  add column if not exists flagged_by      uuid references auth.users (id);

-- A flag is a block AND a time, or neither. `add constraint` has no
-- `if not exists`, so the guard reads pg_constraint instead, as the enum
-- guards in 010 read pg_type.
--
-- Deliberately not tied to status: a Coordinator resolving the review (a later
-- story) may move the booking on to cancelled while keeping the record of why
-- it was flagged. The set-null above breaks this pairing only for a hard
-- delete of a block, which the app never does.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_review_flag_paired'
  ) then
    alter table bookings
      add constraint bookings_review_flag_paired check (
        (review_block_id is null) = (flagged_at is null)
      );
  end if;
end
$$;

-- "which bookings did this block flag?" -- what removing or amending a block
-- (SCRUM-127) will ask. Only flagged rows carry a block, so only they are
-- indexed.
create index if not exists idx_bookings_review_block
  on bookings (review_block_id)
  where review_block_id is not null;


-- ---------------------------------------------------------------------
-- 2. Notifications
-- ---------------------------------------------------------------------
-- type is text with a check rather than an enum, unlike 001 and 010. New
-- notification types will arrive with other stories, and a check can be
-- replaced inside a transaction, whereas `alter type ... add value` cannot be
-- used in the same transaction that adds it. There is no JS mirror to keep in
-- step either: the service passes type through untouched.
--
-- payload is a snapshot of what the Coordinator needs to read the message
-- (venue, event, times, reason), taken when the booking was flagged. A later
-- rename of the venue or event should not rewrite what they were told.
--
-- booking_id and block_id are real foreign keys as well as payload values, so
-- a later story can link to the booking and the block without parsing jsonb.
-- on delete cascade: a notification about a record that no longer exists has
-- nothing left to say.

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),

  -- cascade, as profiles does in 007: a deleted account has no inbox.
  recipient_id uuid not null references auth.users (id) on delete cascade,

  type         text not null,

  booking_id   uuid references bookings (id) on delete cascade,
  block_id     uuid references venue_blocks (id) on delete cascade,

  payload      jsonb not null default '{}',

  -- NULL means unread. A timestamp rather than a boolean, so "when was it
  -- read" is answered for free.
  read_at      timestamptz,
  created_at   timestamptz not null default now(),

  constraint notifications_type_known check (type in ('booking_flagged')),

  -- A booking_flagged notification is about one booking and the block that
  -- flagged it; without both, it names nothing. Written as "not this type, or
  -- both set" so a future type can leave them null.
  constraint notifications_booking_flagged_needs_refs check (
    type <> 'booking_flagged' or (booking_id is not null and block_id is not null)
  )
);

-- "my notifications, newest first" -- the only read the API makes.
create index if not exists idx_notifications_recipient_created
  on notifications (recipient_id, created_at desc);

-- Same posture as every other table: enabled with no policies, so a stray
-- publishable key reads nothing and the API stays the only way in.
alter table notifications enable row level security;


-- ---------------------------------------------------------------------
-- 3. Flagging the bookings a block overrides
-- ---------------------------------------------------------------------
-- Returns the same columns as venue_block_booking_conflicts (012), so the
-- service maps both lists with one function, toBookingConflict.
--
-- plpgsql, with the caller's rights, like every function before it. It
-- expects to run inside create_venue_block, which has already locked the
-- venue and the bookings "for no key update" (012, steps 1 and 5), so the
-- UPDATE below neither waits nor deadlocks on those rows.
--
-- The filters are re-applied rather than trusted. Only bookings that are in
-- the list, still approved, on the block's venue and overlapping the block
-- (half-open, as in 012) are flagged. A stale or wrong id in p_booking_ids
-- therefore flags nothing instead of flagging a booking the block does not
-- touch.
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
  --    A CTE for the same reason as step 5 in 012: the aggregate runs
  --    outside the data-modifying statement.
  with flagged as (
    update bookings b
       set status          = 'flagged_for_review',
           review_block_id = v_block.id,
           flagged_at      = now(),
           flagged_by      = p_user_id
     where b.id = any (coalesce(p_booking_ids, '{}'))
       and b.status = 'approved'
       and b.venue_id = v_block.venue_id
       and b.starts_at < v_block.ends_at
       and b.ends_at > v_block.starts_at
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

  -- 4. The flagged bookings, soonest first, in the helper's column order.
  return query
    select b.id, b.event_request_id, er.event_name, b.starts_at, b.ends_at
      from bookings b
      join event_requests er on er.id = b.event_request_id
     where b.id = any (v_flagged)
     order by b.starts_at, b.id;
end;
$$;

-- See the header: only create_venue_block should reach this.
revoke execute on function flag_bookings_for_block(uuid, uuid[], uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. Creating a block, now flagging what it overrides
-- ---------------------------------------------------------------------
-- The same eight-parameter signature as 012, so `create or replace` replaces
-- it in place -- no drop, and no second overload for PostgREST to refuse as
-- ambiguous (the PGRST203 trap 011 and 012 describe).
--
-- Steps 1 to 7 are 012's, word for word; the errors and the conflict outcome
-- are unchanged. What is new is step 8b, and 'flagged_bookings' in the
-- created outcome. 'affected_bookings' is kept, so a caller reading 012's
-- shape does not break: it is the list the Venue Staff member acknowledged,
-- while 'flagged_bookings' is what was actually changed. Under the locks they
-- are the same bookings; the service reads the second.

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
  -- '[)' to match venue_blocks_no_overlap in 010, so blocks that touch at a
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

  -- 8. Insert. created_by and last_modified_by are both the acting user, as
  --    010 asks, so a later audit trigger can read the author off the row.
  insert into venue_blocks (
    venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by
  )
  values (
    p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id
  )
  returning * into v_block;

  -- 8b. SCRUM-128: flag the overridden bookings and notify Event Coordinators.
  --
  -- AFTER the insert, not between the gate and the insert where 012 left its
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

  -- 9. 012's outcome, plus the bookings actually flagged ('[]' when none).
  return jsonb_build_object(
    'outcome',           'created',
    'block',             to_jsonb(v_block),
    'affected_bookings', v_conflicts,
    'flagged_bookings',  v_flagged
  );
end;
$$;
