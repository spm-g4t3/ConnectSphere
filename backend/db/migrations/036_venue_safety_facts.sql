-- ---------------------------------------------------------------------------
-- 036_venue_safety_facts.sql
-- SCRUM-493: Record a venue's emergency access and known restrictions
--
-- Part of SCRUM-493 "Record Venue Emergency Access and Restrictions (Venue
-- Staff)", Week 7 change 6. Run this once in the Supabase SQL Editor, after
-- 035_setup_change_recheck_refine.sql (update_venue below is 035's, so the
-- SCRUM-484 setup-change re-check must already be in place), and before
-- deploying the backend that sends p_emergency_access and
-- p_known_restrictions. Safe to re-run: the columns are
-- `add column if not exists`, both constraints are dropped by name and added
-- again, and both functions are dropped by their exact old signature before
-- being recreated.
--
-- What it serves:
--   AC1  "Only Venue Staff can add or change these two fields, on the
--        venue's create and edit screens: Emergency access, free text of up
--        to 2,000 characters covering exits, routes and assembly points, and
--        Known restrictions, free text of up to 2,000 characters covering
--        anything that limits how the venue can be used ... Both are
--        optional for each venue." The columns, their limit, and the two
--        function parameters. Who may call is the API's rule (venueStaffOnly
--        in routes/venues.js), as for every other venue field.
--   AC2  "A venue with nothing recorded shows 'Not recorded'." NULL is the
--        one stored form of "nothing recorded"; see below.
--   AC4  "A change to only these fields sends only these fields. Each change
--        records the user, the old and new values, and the date and time."
--   AC5  "Retired venues keep their information."
--   AC6  "Changing these fields does not flag existing bookings."
--
-- Decisions, and why:
--
--   * Free text, not structured fields. The customer's Week 7 list names
--     "emergency access" and "any known venue restrictions" as things the
--     Safety Officer considers, not as counts or codes, and AC1 describes
--     each as free text. The earlier draft's structured fields (number of
--     exits, maximum safe occupancy, inspection date) were the team's guess
--     and were dropped from the story. Two plain text columns, nullable,
--     with no default.
--
--   * Blank is stored as NULL, which means "Not recorded". Text is trimmed,
--     and an empty or whitespace-only entry becomes NULL, so AC2's "Not
--     recorded" has exactly one stored form and the screen never has to tell
--     NULL from '' from '   '. It is the rule block notes already follow
--     (venueBlockValidation.js checkNotes). The CHECKs make it hold for a
--     direct write too: a stored value is 1 to 2,000 characters and contains
--     at least one non-whitespace character (x ~ '[^[:space:]]').
--     char_length counts characters, as the API's Array.from(text).length
--     does, so an emoji counts once on both sides.
--
--   * "Whitespace" means the [[:space:]] class (space, tab, newline, carriage
--     return, vertical tab, form feed), not just the space. btrim() with no
--     second argument strips only spaces, so E'\n\t ' would have survived it
--     and been stored as a "recorded" value that shows as blank. The trim is
--     therefore regexp_replace(x, '^[[:space:]]+|[[:space:]]+$', '', 'g'),
--     which matches what the API's String.prototype.trim() does for every
--     character a person can type into the form, and the CHECK uses the same
--     class, so the database and the API agree on what blank is.
--
--   * NULL keeps, '' clears. update_venue reads a NULL parameter as "leave
--     this field alone", as it does for every other field, so clearing needs
--     a value of its own: '' (or whitespace), which the whitespace trim and
--     nullif(..., '') turn into NULL. The service sends '' when an edit clears a field and
--     NULL when the edit leaves it out (venueService.js toSafetyTextParam),
--     so an edit that touches only these fields sends only these fields
--     (AC4).
--
--   * The audit needs no change, exactly as 017 and 023 found. 003's
--     record_venue_change diffs every column of to_jsonb(old) against
--     to_jsonb(new), so a change to either field writes one
--     venue_change_history row with the user, the old and new values, and
--     the time (AC4); a save that changes nothing writes none. 008's
--     record_venue_creation stores to_jsonb(new), so the creation row carries
--     the starting values. They are deliberately NOT added to
--     venue_attribute_snapshot, which covers the four attribute tables and
--     would record every change twice.
--
--   * No booking is flagged (AC6). update_venue's re-check (034/035) runs
--     only when setup or turnaround really changes: its guard, v_changing in
--     step 0a and the `is distinct from` test in step 7, compares the
--     minutes and nothing else. These fields describe the venue for the
--     Safety Officer and change no occupied period, so a text-only edit
--     re-checks, flags and notifies nothing. 035's body is copied word for
--     word, so the guard and the re-check are unchanged.
--
--   * Retired venues keep the values (AC5). retire_venue (005) only stamps
--     retired_at and never clears a column, and the venue read returns
--     retired venues, so nothing here needs a special case.
--
--   * Grants: unchanged. create_venue and update_venue keep Postgres's
--     default grant and no security definer, as 023 and 034 left them; the
--     API calls them with the secret key.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. The columns and their rules
-- ---------------------------------------------------------------------
-- Nullable with no default, so every existing venue reads as not recorded.
-- No history rows are backfilled: nobody edited those venues.
--
-- The CHECKs are dropped and re-added rather than created once, so a re-run
-- after the limit has changed replaces them instead of failing on the name.

alter table venues
  add column if not exists emergency_access text;

alter table venues
  add column if not exists known_restrictions text;

alter table venues
  drop constraint if exists venues_emergency_access_length;

alter table venues
  add constraint venues_emergency_access_length
  check (
    emergency_access is null
    or (char_length(emergency_access) between 1 and 2000
        and emergency_access ~ '[^[:space:]]')
  );

alter table venues
  drop constraint if exists venues_known_restrictions_length;

alter table venues
  add constraint venues_known_restrictions_length
  check (
    known_restrictions is null
    or (char_length(known_restrictions) between 1 and 2000
        and known_restrictions ~ '[^[:space:]]')
  );


-- ---------------------------------------------------------------------
-- 2. create_venue -- 023's body, plus the two fields
-- ---------------------------------------------------------------------
-- Dropped first. create or replace with added parameters would leave 023's
-- version alongside this one, and PostgREST refuses to choose between two
-- overloads (PGRST203). No later migration (024-035) redefines create_venue,
-- so 023's signature is the one to drop.
--
-- The two parameters sit right before p_user_id, keeping the user last.
-- Callers pass named arguments through /rpc, so the position changes nothing
-- for them. A NULL or blank value stores NULL (not recorded).

drop function if exists create_venue(text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid);

create or replace function create_venue(
  p_name               text,
  p_location           text,
  p_max_capacity       integer,
  p_layouts            text[]  default '{}',
  p_accessibility      text[]  default '{}',
  p_facilities         text[]  default '{}',
  p_hours              jsonb   default '[]'::jsonb,
  p_turnaround_minutes integer default null,
  p_setup_minutes      integer default null,
  p_emergency_access   text    default null,
  p_known_restrictions text    default null,
  p_user_id            uuid    default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  -- NULL means "not given", so a caller that predates SCRUM-186 (or
  -- SCRUM-137) still gets the column default. SCRUM-493: a NULL or blank
  -- emergency access or known restrictions is stored as NULL, "not recorded".
  insert into venues (
    name, location, max_capacity, turnaround_minutes, setup_minutes,
    emergency_access, known_restrictions, last_modified_by
  )
  values (
    p_name, p_location, p_max_capacity,
    coalesce(p_turnaround_minutes, 0), coalesce(p_setup_minutes, 0),
    nullif(regexp_replace(p_emergency_access, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
    nullif(regexp_replace(p_known_restrictions, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
    p_user_id
  )
  returning id into v_id;

  insert into venue_room_layouts (venue_id, room_layout_code)
  select v_id, code from unnest(coalesce(p_layouts, '{}')) as code
  on conflict do nothing;

  insert into venue_accessibility_features (venue_id, accessibility_feature_code)
  select v_id, code from unnest(coalesce(p_accessibility, '{}')) as code
  on conflict do nothing;

  insert into venue_facilities (venue_id, facility_code)
  select v_id, code from unnest(coalesce(p_facilities, '{}')) as code
  on conflict do nothing;

  insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
  select
    v_id,
    (h ->> 'day_of_week')::smallint,
    (h ->> 'opens_at')::time,
    (h ->> 'closes_at')::time
  from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) as h;

  -- Compared against an empty snapshot, so a venue created with no attributes
  -- at all adds no second row.
  perform record_venue_attribute_change(
    v_id,
    venue_attribute_snapshot(null),
    venue_attribute_snapshot(v_id),
    p_user_id
  );

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. update_venue -- 035's body, plus the two fields
-- ---------------------------------------------------------------------
-- Dropped first: create or replace with added parameters would leave 035's
-- version alongside this one (PGRST203, as above). 035 kept 034's signature,
-- so that is the one to drop. The return type is still jsonb,
-- {flagged_bookings: [...]}.
--
-- 035's body is copied word for word. The only additions are the two
-- parameters (before p_user_id) and two lines in the venues SET:
--
--   p_* is NULL      -> keep the current value
--   p_* is '' / '  ' -> clear it (stored as NULL, "not recorded")
--   p_* is text      -> store it, trimmed
--
-- The re-check guard (v_changing, and step 7's test) still compares only
-- setup and turnaround, so a change to these fields alone flags nothing (AC6).

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
  p_emergency_access   text    default null,
  p_known_restrictions text    default null,
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
  -- 035: candidates already clashing under the OLD minutes (see the header).
  v_old_clashing    uuid[] := '{}';
  -- 035: whether this call really changes setup or turnaround, worked out
  --      before the update so the old set can be collected first.
  v_changing        boolean := false;
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


-- PostgREST caches function signatures; without this the new parameters are
-- unknown to /rpc until the cache next reloads.
notify pgrst, 'reload schema';
