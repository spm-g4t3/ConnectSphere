-- ---------------------------------------------------------------------------
-- 034_setup_change_recheck.sql
-- SCRUM-484: Re-check bookings when a venue's setup or turnaround changes
--
-- Part of SCRUM-484 "Configure Venue Setup and Turnaround Times (Venue
-- Staff)". Run this once in the Supabase SQL Editor, after
-- 033_venue_occupancy_callers.sql (update_venue below calls
-- venue_occupancy_conflicts() and venue_occupied_period() from 032). Safe to
-- re-run: the column is `add column if not exists`, every constraint is
-- dropped by name and added again, and update_venue is dropped by its exact
-- 023 signature before being recreated.
--
-- What it serves:
--   AC8  "Changing a venue's setup or turnaround time re-checks its approved
--        bookings for events that have not started. Any booking whose
--        occupied period now overlaps another approved booking or a block is
--        flagged for review with the reason 'Setup or turnaround time
--        changed'. Nothing is cancelled or removed, and bookings that are
--        still clear are not touched. The assigned coordinator of each
--        flagged booking's event is notified (SCRUM-174)."
--
-- Decisions, and why:
--
--   * The re-check lives INSIDE update_venue, not in the API. The minutes
--     change and the bookings they newly clash are flagged in one
--     transaction, under the venue lock, so no booking request or block can
--     slip in between the change and the re-check, and a failure in the
--     re-check rolls the change back too.
--
--   * The venue row is locked "for no key update" first and the OLD minutes
--     are read under that lock. It is the lock create_venue_block and
--     update_venue_block take (013/015/033), and it conflicts with the
--     "for share" create_booking_request takes (030/033), so the writers
--     that decide availability at this venue are serialised with this one.
--
--   * The re-check runs only when setup or turnaround really changes
--     (`is distinct from` the old value). A name-only edit, or one that
--     resends the same minutes, re-checks nothing -- even where bad data
--     already overlaps, because AC8 is about what a CHANGE caused.
--
--   * "Not started" means starts_at > now(). A started or past booking is
--     never a candidate for flagging, but a started approved booking still
--     counts as "another approved booking" that a candidate can clash with:
--     the room is still in use until its turnaround ends.
--
--   * Candidates are 'approved' bookings only. A flagged_for_review booking
--     is already flagged (014/033 take the same rule); pending, rejected,
--     withdrawn and cancelled bookings occupy nothing (032).
--
--   * A candidate clashes when venue_occupancy_conflicts(venue, its own
--     period, padded = true) returns an active block, or an approved
--     booking other than itself. The overlap is decided by 032's shared
--     function, with the NEW minutes (it reads them from venues after the
--     update), so this migration writes no period comparison of its own
--     (AC4) and inherits the half-open touching rule (AC5) and the raw block
--     (AC6).
--
--   * Every clashing id is collected BEFORE anything is updated, so the
--     overlap is judged on the pre-flag snapshot. Both bookings of a newly
--     clashing pair are therefore flagged, whichever is looked at first.
--
--   * The reason is stored as the code 'setup_or_turnaround_changed' in a new
--     bookings.review_reason column, with a CHECK listing the allowed codes.
--     The screen words it "Setup or turnaround time changed". A code rather
--     than the sentence, so the wording can change without rewriting rows.
--     review_block_id stays null for these flags: no block caused them.
--
--   * bookings_review_flag_paired (014) said a flag is a block AND a time.
--     A setup-change flag has a time and a reason but no block, so the rule
--     becomes: flagged_at is set exactly when a block OR a reason is.
--
--   * Notifications go to the event's assigned_coordinator_id
--     (SCRUM-327, 014_coordinator_assignment/017_require_assigned_coordinator),
--     one row per flagged booking, type 'booking_flagged_setup_change'. An
--     event with no assigned coordinator is still flagged and nobody is
--     notified: a missing audience must not undo the change Venue Staff
--     made. Block overrides (014/033) keep notifying every coordinator; that
--     is unchanged here.
--
--   * The notification type CHECK is re-listed IN FULL. 030 widened it to
--     booking_flagged plus the three clarification_* types; 031 then replaced
--     it with ('booking_flagged', 'booking_request_withdrawn') and silently
--     dropped the clarification types, so every clarification notification
--     (026/030) has been refused since 031 ran. Listing every type ever
--     allowed repairs that regression and adds the new one.
--
--   * The new type names its booking (booking_id not null) but not a block,
--     with its own named refs check. The existing
--     notifications_booking_flagged_needs_refs check is written
--     "type <> 'booking_flagged' or (...)", so it does not fire for the new
--     type and is left as it is.
--
--   * update_venue now returns jsonb, {flagged_bookings: [...]}, '[]' when
--     nothing was flagged, so the API can list the flagged bookings right
--     after the save. Each row has the shape of the block-conflict rows
--     (033), so the service maps it with the same function.
--
--   * Nothing is cancelled, deleted or unflagged. Reducing the minutes flags
--     nothing and leaves earlier flags in place for a coordinator to resolve.
--
--   * The audit is unchanged: 023's update and attribute steps are copied
--     word for word, so 003's record_venue_change still writes one history
--     row for the venue's own columns (AC9). Flagging bookings writes no
--     venue history.
--
--   * Grants: 023 left update_venue with Postgres's default grant and no
--     security definer, and so does this. It re-checks its own input, like
--     every function before 014; the API calls it with the secret key.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. Bookings gain a review reason (extends 014)
-- ---------------------------------------------------------------------
-- Dropped and re-added by name, as 023 does for its CHECK, so a re-run after
-- the list has been widened replaces the constraint instead of failing.

alter table bookings
  add column if not exists review_reason text;

alter table bookings
  drop constraint if exists bookings_review_reason_known;

alter table bookings
  add constraint bookings_review_reason_known
  check (review_reason in ('setup_or_turnaround_changed'));

-- A flag is a time together with a cause -- a block (014) or a reason (this
-- file) -- or none of them. Still not tied to status, for 014's reason.
alter table bookings
  drop constraint if exists bookings_review_flag_paired;

alter table bookings
  add constraint bookings_review_flag_paired check (
    (flagged_at is null) = (review_block_id is null and review_reason is null)
  );


-- ---------------------------------------------------------------------
-- 2. Notifications accept every type, and the new one (repairs 031)
-- ---------------------------------------------------------------------
-- See the header: 031 dropped the clarification types 030 had added.

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
      'booking_flagged',
      'booking_request_withdrawn',
      'clarification_requested',
      'clarification_replied',
      'clarification_closed',
      'booking_flagged_setup_change'
    )
  );

-- About one booking; no block flagged it.
alter table notifications drop constraint if exists notifications_setup_change_needs_booking;
alter table notifications
  add constraint notifications_setup_change_needs_booking
  check (type <> 'booking_flagged_setup_change' or booking_id is not null);


-- ---------------------------------------------------------------------
-- 3. update_venue -- 023's body, plus the AC8 re-check
-- ---------------------------------------------------------------------
-- Dropped first: the return type changes from void to jsonb, which
-- `create or replace` cannot do. Same parameters as 023, so callers passing
-- named arguments through /rpc see no difference in what they send.
--
--   NULL           -> leave that field or attribute set completely alone
--   an array       -> REPLACE that attribute set with exactly what was passed
--   an empty array -> clear that attribute set
--
-- Every column is qualified with a table alias, as plpgsql requires once a
-- name could also be a variable.
--
-- Errors:
--   no_data_found (P0002)  no such venue -- the same condition 023 raises

drop function if exists update_venue(uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid);

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
  p_user_id            uuid    default null
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
  v_locked          uuid[] := '{}';
  v_flagged         uuid[] := '{}';
  v_flagged_list    jsonb  := '[]'::jsonb;
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
    --     approved booking. Collected in full before anything is written, so
    --     both bookings of a newly clashing pair are found. A started
    --     approved booking is never a candidate, but it is still returned by
    --     venue_occupancy_conflicts and so still counts as the other side.
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
                 or (c.kind = 'booking' and c.status = 'approved' and c.id <> b.id)
           );

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

    -- 7e. The flagged bookings, soonest first, in 033's conflict-row shape.
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
  end if;

  return jsonb_build_object('flagged_bookings', v_flagged_list);
end;
$$;


-- PostgREST caches function signatures; without this /rpc keeps expecting
-- the old void return until the cache next reloads.
notify pgrst, 'reload schema';
