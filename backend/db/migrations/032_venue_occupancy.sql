-- ---------------------------------------------------------------------------
-- 032_venue_occupancy.sql
-- SCRUM-484: The shared occupied-period function
--
-- Part of SCRUM-484 "Configure Venue Setup and Turnaround Times (Venue
-- Staff)". Run this once in the Supabase SQL Editor, after
-- 031_withdraw_booking_request.sql (it reads venues.setup_minutes from 023,
-- venues.turnaround_minutes from 017, and booking_status and venue_blocks
-- from 011). Safe to re-run: both functions are new, so `create or replace`
-- is enough and nothing needs dropping first.
--
-- What it serves:
--   AC3  An event's occupied period at a venue runs from its start minus the
--        venue's setup time to its end plus the venue's turnaround time. The
--        worked example, which is a test case: an event 10:00-12:00 at a
--        venue with 30 minutes of setup and 45 of turnaround occupies the
--        venue from 09:30 to 12:45.
--   AC4  The occupied period is calculated by ONE shared function, and it is
--        the only calculation used wherever availability is decided.
--   AC5  Two periods where one ends exactly when the other starts do not
--        conflict.
--   AC6  A block keeps its own period, with no setup or turnaround added. It
--        conflicts with a booking when it overlaps the booking's occupied
--        period.
--
-- Why the rule lives in Postgres. AC4 and the story's technical note ask for
-- one Postgres function that the search, request, approval, block and
-- calendar queries all call. The writers that must enforce it are already
-- SQL and already lock rows: create_venue_block (013/014) locks the venue and
-- the bookings it overrides, and create_booking_request (030) locks the
-- event and the venue. A rule they read under those locks cannot drift from
-- the rule the screens show. SCRUM-139 wrote the same rule in JavaScript
-- (backend/src/domain/venueOccupancy.js); sub-task 5 retires that copy and
-- has search call this instead.
--
-- Two functions:
--   * venue_occupied_period() is the formula, and the ONLY place it is
--     written. A raw period -- a block, or a request checked without its own
--     padding -- is the same function with 0 and 0, so there is still one
--     formula and no second spelling of it.
--   * venue_occupancy_conflicts() answers "what occupies this venue during
--     this period?" with both kinds of conflict, bookings and blocks, in one
--     result. Callers keep the rows they care about: a block override keeps
--     kind = 'booking' and status = 'approved'; search keeps any row at all.
--
-- Why both sides are padded. A booked event needs its setup before it and
-- its turnaround after it, and so does the event being requested: it cannot
-- start setting up inside the previous event's turnaround. So a booking's
-- occupied period is compared with the request's occupied period, both
-- using the venue's own minutes (they belong to the venue; an event cannot
-- override them, so callers cannot pass their own). After the worked
-- example's booking, the earliest a next event can start is 13:15: its
-- setup begins at 12:45, exactly where the booking's turnaround ends, and
-- touching is not overlapping (AC5). 13:14 conflicts.
--
-- p_pad_requested exists for the one caller that must not pad the request:
-- a venue block, which keeps its own period (AC6). A block is checked as
-- p_pad_requested = false, so its raw period meets each booking's occupied
-- period -- exactly AC6's sentence.
--
-- Which bookings occupy: 'approved' and 'flagged_for_review', the allow-list
-- SCRUM-139 chose and the venue calendar uses. A flagged event still holds
-- its venue until its coordinator moves it (Week 7 asks to preserve the
-- original event), and the block that flagged it may since have been
-- shortened or removed. An allow-list rather than "not cancelled", so a
-- status added later ('pending', 'rejected', 'withdrawn' from 027 among
-- them) occupies nothing until someone decides it should.
--
-- Why blocks are never padded: staff choose a block's period themselves, and
-- adding buffers would change what they typed (the story's design decision).
-- A block is a closure, not an event, so it has no setup or turnaround.
--
-- Half-open throughout: every range is built '[)' and compared with &&, so a
-- period ending at 12:45 and one starting at 12:45 touch without
-- overlapping -- the same edge venue_blocks_no_overlap (011) and the
-- calendar already use.
--
-- NOTHING CALLS THESE YET. This migration only adds the functions, so it
-- changes no behaviour. The callers move across in later sub-tasks:
--   sub-task 3  venue blocks (create, amend, their conflict preview)
--   sub-task 4  the booking request (create_booking_request, 030)
--   sub-task 5  venue search (SCRUM-139's JS rule is retired)
--   sub-task 6  the calendar and the conflict payloads the screens show
-- SCRUM-188 (the suitability check) and SCRUM-258 (booking approval) must
-- call venue_occupancy_conflicts() when they are built, and carry no copy of
-- the rule of their own.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. The occupied period
-- ---------------------------------------------------------------------
-- [start - setup, end + turnaround), as a '[)' range. The worked example:
--
--   venue_occupied_period('2026-11-11 10:00+08', '2026-11-11 12:00+08', 30, 45)
--     = ["2026-11-11 09:30+08","2026-11-11 12:45+08")
--
-- immutable: the answer depends only on the arguments. Instants, not
-- wall-clock times, so the offset a timestamp was written with never
-- matters. Adding minutes to a timestamptz is exact (no day or month
-- arithmetic, so the session time zone plays no part).
--
-- strict: any null argument returns null rather than an unbounded range. A
-- null bound would otherwise make the range infinite and overlap everything;
-- null && anything is null, which a WHERE treats as no match.
--
-- integer, not smallint, for the minutes, so a caller can pass a literal
-- without a cast; the venue columns are smallint and widen on the way in.
--
-- A reversed period (end before start, after padding) raises 22000 when the
-- range is built. The bookings and venue_blocks CHECKs make that impossible
-- for stored rows, and the minutes are never negative (017/023 CHECKs), so
-- only a caller's own reversed request can reach it -- and every caller
-- validates the order before it gets here, as 013 does.

create or replace function venue_occupied_period(
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_setup_minutes      integer,
  p_turnaround_minutes integer
)
returns tstzrange
language sql
immutable
strict
parallel safe
as $$
  select tstzrange(
    p_starts_at - make_interval(mins => p_setup_minutes),
    p_ends_at   + make_interval(mins => p_turnaround_minutes),
    '[)'
  );
$$;


-- ---------------------------------------------------------------------
-- 2. What occupies a venue during a period
-- ---------------------------------------------------------------------
-- One row per conflict, bookings and blocks together:
--
--   kind                'booking' or 'block'
--   id                  the booking's or the block's id
--   status              the booking's status; null for a block
--   event_request_id    the booking's event; null for a block
--   event_name          the booking's event name; null for a block
--   reason              the block's reason; null for a booking
--   starts_at, ends_at  the row's own period, as stored
--   occupied_starts_at, the period it occupies: padded with the venue's
--   occupied_ends_at      minutes for a booking, raw for a block
--   setup_minutes,      the venue's minutes, on every row -- see below
--   turnaround_minutes
--
-- Returning starts_at beside occupied_starts_at is what lets a screen say
-- which part of an occupied period is setup or turnaround (AC7) without
-- doing the arithmetic again.
--
-- The minutes are read from the venues row for p_venue_id. An unknown venue
-- returns no rows rather than raising: every caller checks the venue exists
-- (and locks it) before asking, and a stable read that raised would only
-- duplicate that check with a second error code.
--
-- Bookings, in two steps:
--   * a pre-filter on the raw columns, widened by the venue's minutes. A
--     booking's occupied period overlaps the requested range R exactly when
--       starts_at - setup < upper(R),     i.e. starts_at < upper(R) + setup
--       ends_at + turnaround > lower(R),  i.e. ends_at > lower(R) - turnaround
--     Plain comparisons on starts_at and ends_at can use
--     idx_bookings_venue (venue_id, starts_at desc) from 009; the expression
--     on the range cannot. (idx_bookings_venue_approved from 011 is partial
--     on status = 'approved' alone, so it does not cover flagged rows.)
--   * the exact test, venue_occupied_period(...) && R, so the decision is
--     still made by the one formula. The pre-filter is equivalent, so it
--     never drops a real conflict; it is there only to narrow the read.
--
-- Blocks: active ones only (removed_at is null), compared raw --
-- venue_occupied_period(starts_at, ends_at, 0, 0) -- against R.
--
-- Why a block row still reports the venue's setup and turnaround minutes,
-- not 0: the block itself is not padded (its occupied times equal its own
-- times, which already says so), but the requested range may be. Carrying
-- the venue's minutes on every row lets a caller label how far the request's
-- own setup and turnaround reached into the block -- "your 30 minutes of
-- setup would fall inside this closure" -- without a second read of venues.
--
-- Ordered by when each row's occupation begins, then kind, then id, so the
-- order is total and the same on every call.
--
-- stable, and takes no locks: a stable function cannot take row locks. A
-- writer that needs the answer to hold (a block override, a booking request,
-- an approval) locks the venue and the rows itself, then reads this.
--
-- Default grants, deliberately. 014 revoked execute on
-- flag_bookings_for_block because that function WRITES and trusts its caller
-- to have passed a gate. This one only reads, takes no locks and trusts
-- nothing, like venue_block_booking_conflicts in 013; RLS still hides the
-- tables from the publishable key, and the API calls it with the secret key.

create or replace function venue_occupancy_conflicts(
  p_venue_id      uuid,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_pad_requested boolean
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
  conflicts as (
    select br.* from booking_rows br
    union all
    select bl.* from block_rows bl
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
