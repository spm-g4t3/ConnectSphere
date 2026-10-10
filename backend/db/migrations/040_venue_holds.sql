-- ---------------------------------------------------------------------------
-- 040_venue_holds.sql
-- SCRUM-491: A tentative venue hold with an expiry
--
-- Part of SCRUM-491 "Place a Tentative Venue Hold with Expiry - Venue Staff".
-- Run this once in the Supabase SQL Editor, after 038_equipment_review.sql
-- (it reads venues from 002, venue_occupied_period() and
-- venue_occupancy_conflicts() from 032, create_booking_request and
-- available_venue_ids() from 033, and notifications as 034 left it). Safe to
-- re-run: the enum is created in a guard, the table, columns and indexes are
-- `if not exists`, every constraint is dropped by name and added again, each
-- changed signature is dropped `if exists` directly before its create, and
-- every function is `create or replace`.
--
-- What it serves:
--   AC1  Only Venue Staff can place a hold. The route gates on the role; the
--        function checks it again, so nothing else can reach it by mistake.
--   AC2  A hold is for one Approved event and one venue, and records the
--        event, the venue, who placed it, when, and an expiry, which is
--        required and in the future.
--   AC3  An event may hold several venues, but has at most one active hold
--        at each (a unique partial index on (event, venue)).
--   AC4  A hold is placed only on an active venue whose occupied period for
--        the event (SCRUM-484) meets no occupying booking, no active block
--        and no other event's active hold. Otherwise the conflicts come back,
--        each with its period.
--   AC5  While active, a hold occupies the venue for every other event: their
--        booking requests are refused and venue search leaves the venue out.
--        The holding event's own request and search are not blocked by it.
--   AC6  The calendar reads holds through the same function, as kind 'hold'
--        with the holding event's name.
--   AC7  A hold whose expiry has passed occupies nothing, at once, whether or
--        not the expiry job has run yet. It is never a booking.
--   AC8  Once expired, the event's assigned coordinator is notified, once,
--        naming the event, the venue and the expiry.
--
-- Decisions, and why:
--
--   * The single source stays single. A hold is a third kind of row in
--     venue_occupancy_conflicts() (032), so every caller that decides
--     availability -- the booking request, venue search, the calendar --
--     sees holds without a second copy of the rule (SCRUM-484 AC4). Callers
--     that keep only kind = 'booking' (the block writers and update_venue,
--     033-036) are unchanged, so a block may still be placed over a hold
--     (the block wins) and a setup change flags no booking because of one.
--
--   * A hold's period is its event's proposed_start and proposed_end, padded
--     with the venue's setup and turnaround through venue_occupied_period(),
--     exactly as a booking of that event would be. The hold stores no period
--     of its own: what it reserves is the room for that event.
--
--   * "Active" is status = 'active' AND expires_at > now(). The second half
--     is what makes AC7 hold without the job: a hold the job has not reached
--     yet already occupies nothing. The job (process_venue_hold_expiry) only
--     records the expiry and sends the notice (AC8).
--
--   * One function, a fifth parameter. venue_occupancy_conflicts() gains
--     p_exclude_hold_event_id, default null, so the holding event's own
--     request and search can leave its holds out (AC5). A 4-argument wrapper
--     beside it is not possible: with the default, every 4-argument call
--     would match both and Postgres would refuse it as "not unique". So the
--     4-argument version is dropped and the 5-argument one created; the
--     existing 4-argument callers (033-036 and the calendar's rpc) resolve by
--     name when they run and pick up the default.
--
--   * available_venue_ids() takes the same parameter and passes it through.
--     It is dropped and recreated too, so PostgREST never sees two overloads
--     (PGRST203).
--
--   * occupancy_conflict_json() is the per-kind CASE that 033's
--     create_booking_request wrote inline, plus a 'hold' branch, so the
--     booking request and place_venue_hold build their conflict lists the
--     same way.
--
--   * place_venue_hold locks the event "for share" and then the venue "for
--     no key update", event before venue as create_booking_request does. The
--     venue lock conflicts with create_booking_request's "for share" and with
--     a second hold on the same venue, so neither can slip in between the
--     check and the insert.
--
--   * The expiry job is an in-process timer in the API
--     (jobs/venueHoldExpiryScheduler.js), calling process_venue_hold_expiry()
--     once a minute. It is idempotent: a hold is expired once, and the
--     partial unique index on notifications means it is notified about once.
--
--   * Not here, on purpose: releasing a hold early, converting it on booking
--     approval (SCRUM-258), releasing it when the event is cancelled or
--     rejected, and a notice when a hold is placed.
--
-- SQLSTATEs place_venue_hold raises:
--   42501  the placer is not Venue Staff, or is null                 403
--   P0002  no such event, or no such venue                           404
--   PT409  EVENT_NOT_APPROVED, EVENT_DATES_MISSING, VENUE_RETIRED,
--          HOLD_EXISTS (the existing hold's id in DETAIL)             409
--   22023  no expiry, or an expiry not in the future                 400
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. Hold status and the holds table
-- ---------------------------------------------------------------------
-- An enum, as booking_status and venue_block_reason are, so the database
-- decides which statuses are storable and domain/venueHoldStatus.js mirrors
-- it (a test asserts the match). Guarded as 007 guards user_role.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'venue_hold_status') then
    create type venue_hold_status as enum (
      'active',   -- occupies the venue for its event until expires_at
      'expired'   -- the expiry passed; occupies nothing, kept as a record
    );
  end if;
end
$$;

-- event_request_id cascades, as bookings does in 009: a hold for an event
-- that no longer exists holds nothing. venue_id does not: venues are never
-- hard-deleted (003), and a hold is a record of the venue too.
--
-- expired_at is set exactly when the status is 'expired', by the job. A
-- hold whose expires_at has passed but which the job has not reached yet is
-- still 'active' here and still occupies nothing (see the header).

create table if not exists venue_holds (
  id               uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete cascade,
  venue_id         uuid not null references venues (id),
  placed_by        uuid not null references auth.users (id),
  placed_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  status           venue_hold_status not null default 'active',
  expired_at       timestamptz
);

alter table venue_holds drop constraint if exists venue_holds_expired_at_matches_status;
alter table venue_holds
  add constraint venue_holds_expired_at_matches_status
  check ((status = 'expired') = (expired_at is not null));

alter table venue_holds drop constraint if exists venue_holds_expires_after_placed;
alter table venue_holds
  add constraint venue_holds_expires_after_placed
  check (expires_at > placed_at);

-- AC3: one active hold per event at each venue. Several venues per event,
-- and several events per venue at different times, are both allowed.
create unique index if not exists venue_holds_one_active_per_event_venue
  on venue_holds (event_request_id, venue_id)
  where status = 'active';

-- The conflict read: a venue's active holds.
create index if not exists idx_venue_holds_active_venue
  on venue_holds (venue_id)
  where status = 'active';

-- The job's read: active holds whose expiry has passed.
create index if not exists idx_venue_holds_active_expires
  on venue_holds (expires_at)
  where status = 'active';

-- Same posture as every other table: enabled with no policies, so a stray
-- publishable key reads nothing and the API stays the only way in.
alter table venue_holds enable row level security;


-- ---------------------------------------------------------------------
-- 2. Notifications learn about holds (extends 014 and 034)
-- ---------------------------------------------------------------------
-- A real foreign key as well as a payload value, as booking_id and block_id
-- are (014), so a later screen can link to the hold without parsing jsonb.

alter table notifications
  add column if not exists venue_hold_id uuid references venue_holds (id) on delete cascade;

-- Re-listed IN FULL, as 034 did: the six types 034 allows, plus this one.
alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
      'booking_flagged',
      'booking_request_withdrawn',
      'clarification_requested',
      'clarification_replied',
      'clarification_closed',
      'booking_flagged_setup_change',
      'venue_hold_expired'
    )
  );

-- About one hold; without it the notice names nothing.
alter table notifications drop constraint if exists notifications_hold_expired_needs_hold;
alter table notifications
  add constraint notifications_hold_expired_needs_hold
  check (type <> 'venue_hold_expired' or venue_hold_id is not null);

-- AC8: a hold is notified about once, however often the job runs.
create unique index if not exists notifications_one_per_expired_hold
  on notifications (venue_hold_id)
  where type = 'venue_hold_expired';


-- ---------------------------------------------------------------------
-- 3. What occupies a venue during a period (032, holds added)
-- ---------------------------------------------------------------------
-- 032's function, word for word, with a third kind of row and a fifth
-- parameter. Its return columns are unchanged, so every caller reads what it
-- read before. For a hold row:
--
--   kind                'hold'
--   id                  the hold's id
--   status              null (a hold has no booking status)
--   event_request_id    the holding event
--   event_name          the holding event's name
--   reason              null
--   starts_at, ends_at  the holding event's proposed_start and proposed_end
--   occupied_*          that period padded with the venue's minutes, as a
--                       booking of that event would be
--
-- Only holds that are active AND not yet past their expiry count (AC7), and
-- never the holds of p_exclude_hold_event_id (AC5). Null excludes nothing.
--
-- Dropped first: a 4-argument version left beside the 5-argument one would
-- make every 4-argument call ambiguous (see the header).

drop function if exists venue_occupancy_conflicts(uuid, timestamptz, timestamptz, boolean);

create or replace function venue_occupancy_conflicts(
  p_venue_id               uuid,
  p_starts_at              timestamptz,
  p_ends_at                timestamptz,
  p_pad_requested          boolean,
  p_exclude_hold_event_id  uuid default null
)
returns table (
  kind               text,
  id                 uuid,
  status             booking_status,
  event_request_id   uuid,
  event_name         text,
  reason             venue_block_reason,
  starts_at          timestamptz,
  ends_at            timestamptz,
  occupied_starts_at timestamptz,
  occupied_ends_at   timestamptz,
  setup_minutes      integer,
  turnaround_minutes integer
)
language sql
stable
as $$
  with venue as (
    select v.id,
           v.setup_minutes::integer      as setup_minutes,
           v.turnaround_minutes::integer as turnaround_minutes
      from venues v
     where v.id = p_venue_id
  ),
  requested as (
    select ven.id,
           ven.setup_minutes,
           ven.turnaround_minutes,
           case
             when p_pad_requested
               then venue_occupied_period(p_starts_at, p_ends_at,
                                          ven.setup_minutes, ven.turnaround_minutes)
             else venue_occupied_period(p_starts_at, p_ends_at, 0, 0)
           end as period
      from venue ven
  ),
  booking_rows as (
    select 'booking'::text                                       as kind,
           b.id,
           b.status,
           b.event_request_id,
           er.event_name,
           null::venue_block_reason                              as reason,
           b.starts_at,
           b.ends_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 req.setup_minutes, req.turnaround_minutes) as occupied,
           req.setup_minutes,
           req.turnaround_minutes
      from requested req
      join bookings b
        on b.venue_id = req.id
      join event_requests er
        on er.id = b.event_request_id
     where b.status in ('approved', 'flagged_for_review')
       and b.starts_at < upper(req.period) + make_interval(mins => req.setup_minutes)
       and b.ends_at   > lower(req.period) - make_interval(mins => req.turnaround_minutes)
       and venue_occupied_period(b.starts_at, b.ends_at,
                                 req.setup_minutes, req.turnaround_minutes) && req.period
  ),
  block_rows as (
    select 'block'::text                                         as kind,
           vb.id,
           null::booking_status                                  as status,
           null::uuid                                            as event_request_id,
           null::text                                            as event_name,
           vb.reason,
           vb.starts_at,
           vb.ends_at,
           venue_occupied_period(vb.starts_at, vb.ends_at, 0, 0) as occupied,
           req.setup_minutes,
           req.turnaround_minutes
      from requested req
      join venue_blocks vb
        on vb.venue_id = req.id
     where vb.removed_at is null
       and venue_occupied_period(vb.starts_at, vb.ends_at, 0, 0) && req.period
  ),
  -- SCRUM-491: active holds, padded like a booking of the holding event.
  -- expires_at > now() is AC7: a lapsed hold the job has not reached yet
  -- already occupies nothing. An event with no dates gives a null period
  -- (venue_occupied_period is strict), which matches nothing.
  hold_rows as (
    select 'hold'::text                                          as kind,
           vh.id,
           null::booking_status                                  as status,
           vh.event_request_id,
           er.event_name,
           null::venue_block_reason                              as reason,
           er.proposed_start                                     as starts_at,
           er.proposed_end                                       as ends_at,
           venue_occupied_period(er.proposed_start, er.proposed_end,
                                 req.setup_minutes, req.turnaround_minutes) as occupied,
           req.setup_minutes,
           req.turnaround_minutes
      from requested req
      join venue_holds vh
        on vh.venue_id = req.id
      join event_requests er
        on er.id = vh.event_request_id
     where vh.status = 'active'
       and vh.expires_at > now()
       and vh.event_request_id is distinct from p_exclude_hold_event_id
       and venue_occupied_period(er.proposed_start, er.proposed_end,
                                 req.setup_minutes, req.turnaround_minutes) && req.period
  ),
  conflicts as (
    select br.* from booking_rows br
    union all
    select bl.* from block_rows bl
    union all
    select hr.* from hold_rows hr
  )
  select c.kind,
         c.id,
         c.status,
         c.event_request_id,
         c.event_name,
         c.reason,
         c.starts_at,
         c.ends_at,
         lower(c.occupied) as occupied_starts_at,
         upper(c.occupied) as occupied_ends_at,
         c.setup_minutes,
         c.turnaround_minutes
    from conflicts c
   order by lower(c.occupied), c.kind, c.id;
$$;


-- ---------------------------------------------------------------------
-- 4. Which of these venues is free for a period (033, exclusion added)
-- ---------------------------------------------------------------------
-- 033's function, with p_exclude_hold_event_id passed straight through, so
-- an event's search does not hide the venues it holds itself (AC5). Every
-- other line and reason is 033's. Dropped first for PGRST203: two overloads
-- of one name are refused by PostgREST as ambiguous.

drop function if exists available_venue_ids(uuid[], timestamptz, timestamptz);

create or replace function available_venue_ids(
  p_venue_ids              uuid[],
  p_starts_at              timestamptz,
  p_ends_at                timestamptz,
  p_exclude_hold_event_id  uuid default null
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
             from venue_occupancy_conflicts(candidate.id, p_starts_at, p_ends_at, true,
                                            p_exclude_hold_event_id)
         );
$$;


-- ---------------------------------------------------------------------
-- 5. One conflict row as the screens receive it
-- ---------------------------------------------------------------------
-- The per-kind CASE from 033's create_booking_request, step 7, lifted out
-- so place_venue_hold builds its list the same way. The block and booking
-- branches keep 033's keys exactly; the hold branch names the hold and the
-- event holding the venue. immutable: the answer depends only on the
-- arguments.

create or replace function occupancy_conflict_json(
  p_kind               text,
  p_id                 uuid,
  p_event_request_id   uuid,
  p_event_name         text,
  p_reason             venue_block_reason,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_occupied_starts_at timestamptz,
  p_occupied_ends_at   timestamptz,
  p_setup_minutes      integer,
  p_turnaround_minutes integer
)
returns jsonb
language sql
immutable
as $$
  select case p_kind
    when 'block' then
      jsonb_build_object(
        'kind',               'block',
        'block_id',           p_id,
        'starts_at',          p_starts_at,
        'ends_at',            p_ends_at,
        'reason',             p_reason,
        'occupied_starts_at', p_occupied_starts_at,
        'occupied_ends_at',   p_occupied_ends_at,
        'setup_minutes',      p_setup_minutes,
        'turnaround_minutes', p_turnaround_minutes
      )
    when 'hold' then
      jsonb_build_object(
        'kind',               'hold',
        'hold_id',            p_id,
        'event_request_id',   p_event_request_id,
        'event_name',         p_event_name,
        'starts_at',          p_starts_at,
        'ends_at',            p_ends_at,
        'occupied_starts_at', p_occupied_starts_at,
        'occupied_ends_at',   p_occupied_ends_at,
        'setup_minutes',      p_setup_minutes,
        'turnaround_minutes', p_turnaround_minutes
      )
    else
      jsonb_build_object(
        'kind',               'booking',
        'booking_id',         p_id,
        'event_request_id',   p_event_request_id,
        'event_name',         p_event_name,
        'starts_at',          p_starts_at,
        'ends_at',            p_ends_at,
        'occupied_starts_at', p_occupied_starts_at,
        'occupied_ends_at',   p_occupied_ends_at,
        'setup_minutes',      p_setup_minutes,
        'turnaround_minutes', p_turnaround_minutes
      )
  end;
$$;


-- ---------------------------------------------------------------------
-- 6. Creating a booking request (033, step 7 replaced)
-- ---------------------------------------------------------------------
-- 033's seven-parameter signature, unchanged, so `create or replace`
-- replaces it in place. Every step but 7 is 033's word for word.
--
-- Step 7 now passes p_event_request_id as the event whose holds to leave
-- out, so an event's own hold never blocks its own request (AC5), while
-- every other event's active hold conflicts. The list is built with
-- occupancy_conflict_json(); blocks first, then bookings, then holds, each
-- soonest first, so 033's order for the first two kinds is kept.

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
  --    The event's own bookings cannot appear: step 6 has already refused an
  --    event holding a pending, approved or flagged booking.
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

-- As in 030 and 033: only the API should reach this.
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. Expiring holds and telling the coordinator (AC7, AC8)
-- ---------------------------------------------------------------------
-- Every active hold whose expiry has passed becomes 'expired', and the
-- holding event's assigned coordinator gets one 'venue_hold_expired' notice,
-- naming the event, the venue and the expiry. Returns how many holds this
-- call expired.
--
-- Idempotent. A second run finds nothing active and past its expiry, so it
-- expires and notifies nothing; two runs at once are serialised by the row
-- locks the UPDATE takes, and the loser re-checks status = 'active' on the
-- new row version and skips it. `on conflict do nothing` against the partial
-- unique index is the backstop: a hold is notified about at most once.
--
-- An event with no assigned coordinator still has its hold expired and
-- nobody is notified, as 034 decided for setup changes: a missing audience
-- must not keep a venue held.
--
-- The payload keys are camelCase, as 014's are, because the API returns the
-- payload to the frontend as it is stored.
--
-- Execute is revoked: it writes, and only the API's job should run it.

create or replace function process_venue_hold_expiry()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  with expired as (
    update venue_holds vh
       set status     = 'expired',
           expired_at = now()
     where vh.status = 'active'
       and vh.expires_at <= now()
    returning vh.id, vh.event_request_id, vh.venue_id, vh.expires_at
  ),
  notified as (
    insert into notifications (recipient_id, type, venue_hold_id, payload)
    select er.assigned_coordinator_id,
           'venue_hold_expired',
           e.id,
           jsonb_build_object(
             'eventRequestId', e.event_request_id,
             'eventName',      er.event_name,
             'venueId',        e.venue_id,
             'venueName',      v.name,
             'expiresAt',      e.expires_at
           )
      from expired e
      join event_requests er on er.id = e.event_request_id
      join venues v          on v.id  = e.venue_id
     where er.assigned_coordinator_id is not null
    on conflict (venue_hold_id) where type = 'venue_hold_expired' do nothing
    returning 1
  )
  select count(*)::integer
    into v_count
    from expired;

  return v_count;
end;
$$;

revoke execute on function process_venue_hold_expiry() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 8. Placing a hold (AC1-AC4)
-- ---------------------------------------------------------------------
-- Returns {outcome: 'placed', hold} or {outcome: 'conflict', conflicts},
-- where conflicts are built by occupancy_conflict_json(). A refused or
-- conflicting call writes nothing.
--
-- Locks: the event "for share", then the venue "for no key update" -- event
-- before venue, as create_booking_request takes them, so the two cannot
-- deadlock. The venue lock conflicts with create_booking_request's "for
-- share" and with another place_venue_hold on the venue, so no request or
-- hold can be written between the conflict check and the insert.
--
-- Before HOLD_EXISTS, process_venue_hold_expiry() runs, so a hold for the
-- same event and venue that has lapsed but is still marked active is
-- expired (and its coordinator told) rather than refusing the new one
-- through the unique index.

create or replace function place_venue_hold(
  p_event_request_id uuid,
  p_venue_id         uuid,
  p_expires_at       timestamptz,
  p_placed_by        uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_existing_id uuid;
  v_conflicts   jsonb;
  v_hold        venue_holds;
begin
  -- 1. AC1: only Venue Staff. A null placer is refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_placed_by;

  if p_placed_by is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can place a hold on a venue'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. Lock the event, "for share".
  select *
    into v_event
    from event_requests
   where id = p_event_request_id
     for share;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Lock the venue, "for no key update".
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for no key update;

  if not found then
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 4. AC2: only an Approved event, with dates.
  if v_event.status <> 'approved' then
    raise exception 'event request % has status %, and a venue can only be held for an approved event',
      p_event_request_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_APPROVED';
  end if;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'event request % has no proposed start and end', p_event_request_id
      using errcode = 'PT409', hint = 'EVENT_DATES_MISSING';
  end if;

  -- 5. AC2: an expiry is required, and must be in the future.
  if p_expires_at is null then
    raise exception 'a hold needs an expiry'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_expires_at <= now() then
    raise exception 'a hold must expire in the future'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 6. AC4: only an active venue.
  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be held', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 7. Record any lapsed holds first.
  perform process_venue_hold_expiry();

  -- 8. AC3: one active hold per event at each venue.
  select vh.id
    into v_existing_id
    from venue_holds vh
   where vh.event_request_id = p_event_request_id
     and vh.venue_id = p_venue_id
     and vh.status = 'active'
   limit 1;

  if v_existing_id is not null then
    raise exception 'event request % already holds venue %', p_event_request_id, p_venue_id
      using errcode = 'PT409', hint = 'HOLD_EXISTS', detail = v_existing_id::text;
  end if;

  -- 9. AC4: the event's occupied period against everything else at the venue.
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

  -- 10. Insert. placed_at is the database clock; a hold is active by construction.
  insert into venue_holds (event_request_id, venue_id, placed_by, expires_at, status)
  values (p_event_request_id, p_venue_id, p_placed_by, p_expires_at, 'active')
  returning * into v_hold;

  return jsonb_build_object('outcome', 'placed', 'hold', to_jsonb(v_hold));
end;
$$;

revoke execute on function place_venue_hold(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated;


notify pgrst, 'reload schema';
