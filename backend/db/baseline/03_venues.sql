-- Baseline 03: venues, their opening hours, the lookup vocabularies with their
-- seed rows, which venue has what, the venue change history and the venue functions.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- A venue is retired, never deleted: bookings and history keep pointing at it.
create table venues (
  id uuid not null default gen_random_uuid(),
  name text not null,
  location text not null,
  max_capacity integer not null,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_modified_by uuid,
  turnaround_minutes smallint not null default 0,
  setup_minutes smallint not null default 0,
  emergency_access text,
  known_restrictions text,
  constraint venues_pkey primary key (id),
  constraint venues_last_modified_by_fkey foreign key (last_modified_by) references auth.users(id),
  constraint venues_emergency_access_length check (
    emergency_access is null
    or (char_length(emergency_access) between 1 and 2000
        and emergency_access ~ '[^[:space:]]')
  ),
  constraint venues_known_restrictions_length check (
    known_restrictions is null
    or (char_length(known_restrictions) between 1 and 2000
        and known_restrictions ~ '[^[:space:]]')
  ),
  constraint venues_location_check check (length(trim(location)) > 0),
  constraint venues_max_capacity_check check (max_capacity > 0),
  constraint venues_name_check check (length(trim(name)) > 0),
  constraint venues_setup_minutes_allowed check (setup_minutes = any (array[0, 15, 30, 45, 60, 90, 120])),
  constraint venues_turnaround_minutes_allowed check (turnaround_minutes = any (array[0, 15, 30, 45, 60, 90, 120]))
);
create index idx_venues_active on venues (name) where (retired_at is null);
create index idx_venues_active_capacity on venues (max_capacity) where (retired_at is null);
alter table venues enable row level security;

create trigger venues_set_updated_at
  before update on venues
  for each row
  execute function set_updated_at();

create table venue_operating_hours (
  venue_id uuid not null,
  day_of_week smallint not null,
  opens_at time not null,
  closes_at time not null,
  constraint venue_operating_hours_pkey primary key (venue_id, day_of_week),
  constraint venue_operating_hours_venue_id_fkey foreign key (venue_id) references venues(id) on delete cascade,
  constraint venue_operating_hours_day_of_week_check check ((day_of_week >= 0) and (day_of_week <= 6)),
  constraint venue_operating_hours_ordered check (closes_at > opens_at)
);
alter table venue_operating_hours enable row level security;

-- Lookup vocabularies: the app stores the codes, and people see the labels.

create table room_layouts (
  code text not null,
  label text not null,
  constraint room_layouts_pkey primary key (code),
  constraint room_layouts_code_check check ((code = lower(code)) and (length(trim(code)) > 0))
);
alter table room_layouts enable row level security;

create table accessibility_features (
  code text not null,
  label text not null,
  constraint accessibility_features_pkey primary key (code),
  constraint accessibility_features_code_check check ((code = lower(code)) and (length(trim(code)) > 0))
);
alter table accessibility_features enable row level security;

create table facilities (
  code text not null,
  label text not null,
  constraint facilities_pkey primary key (code),
  constraint facilities_code_check check ((code = lower(code)) and (length(trim(code)) > 0))
);
alter table facilities enable row level security;

insert into room_layouts (code, label) values
  ('classroom',  'Classroom'),
  ('theatre',    'Theatre'),
  ('boardroom',  'Boardroom'),
  ('banquet',    'Banquet'),
  ('exhibition', 'Exhibition'),
  ('u_shape',    'U-Shape');

insert into accessibility_features (code, label) values
  ('step_free_entrance',  'Step-free entrance'),
  ('accessible_toilet',   'Wheelchair-accessible toilet'),
  ('hearing_loop',        'Hearing loop'),
  ('lift_access',         'Lift access'),
  ('accessible_parking',  'Accessible parking');

insert into facilities (code, label) values
  ('projector',          'Projector'),
  ('screen',             'Screen'),
  ('wifi',               'Wi-Fi'),
  ('air_conditioning',   'Air conditioning'),
  ('whiteboard',         'Whiteboard'),
  ('video_conferencing', 'Video conferencing'),
  ('pa_system',          'PA system'),
  ('catering',           'Catering');

create table venue_room_layouts (
  venue_id uuid not null,
  room_layout_code text not null,
  constraint venue_room_layouts_pkey primary key (venue_id, room_layout_code),
  constraint venue_room_layouts_room_layout_code_fkey foreign key (room_layout_code) references room_layouts(code) on delete restrict,
  constraint venue_room_layouts_venue_id_fkey foreign key (venue_id) references venues(id) on delete cascade
);
create index idx_venue_room_layouts_code on venue_room_layouts (room_layout_code);
alter table venue_room_layouts enable row level security;

create table venue_accessibility_features (
  venue_id uuid not null,
  accessibility_feature_code text not null,
  constraint venue_accessibility_features_pkey primary key (venue_id, accessibility_feature_code),
  constraint venue_accessibility_features_accessibility_feature_code_fkey foreign key (accessibility_feature_code) references accessibility_features(code) on delete restrict,
  constraint venue_accessibility_features_venue_id_fkey foreign key (venue_id) references venues(id) on delete cascade
);
create index idx_venue_accessibility_features_code on venue_accessibility_features (accessibility_feature_code);
alter table venue_accessibility_features enable row level security;

create table venue_facilities (
  venue_id uuid not null,
  facility_code text not null,
  constraint venue_facilities_pkey primary key (venue_id, facility_code),
  constraint venue_facilities_facility_code_fkey foreign key (facility_code) references facilities(code) on delete restrict,
  constraint venue_facilities_venue_id_fkey foreign key (venue_id) references venues(id) on delete cascade
);
create index idx_venue_facilities_code on venue_facilities (facility_code);
alter table venue_facilities enable row level security;

-- One row per venue change, with the old and new values.
create table venue_change_history (
  id uuid not null default gen_random_uuid(),
  venue_id uuid not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  old_values jsonb not null,
  new_values jsonb not null,
  constraint venue_change_history_pkey primary key (id),
  constraint venue_change_history_changed_by_fkey foreign key (changed_by) references auth.users(id),
  constraint venue_change_history_venue_id_fkey foreign key (venue_id) references venues(id) on delete restrict
);
create index idx_venue_change_history_venue on venue_change_history (venue_id, changed_at desc);
alter table venue_change_history enable row level security;

create or replace function record_venue_change()
returns trigger
language plpgsql
as $$
declare
  old_row     jsonb := to_jsonb(old);
  new_row     jsonb := to_jsonb(new);
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  col         text;
begin
  for col in select jsonb_object_keys(new_row) loop
    if col in ('updated_at', 'last_modified_by') then
      continue;
    end if;

    if old_row -> col is distinct from new_row -> col then
      old_changed := old_changed || jsonb_build_object(col, old_row -> col);
      new_changed := new_changed || jsonb_build_object(col, new_row -> col);
    end if;
  end loop;

  -- Nothing meaningful changed. Saving a form without editing anything should
  -- not leave an audit entry.
  if old_changed = '{}'::jsonb then
    return null;
  end if;

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (new.id, new.last_modified_by, old_changed, new_changed);

  return null;
end;
$$;

create trigger venues_record_change
  after update on venues
  for each row
  execute function record_venue_change();

create or replace function record_venue_creation()
returns trigger
language plpgsql
as $$
declare
  new_row jsonb := to_jsonb(new);
begin
  -- Dropped for the same reason record_venue_change drops them: both are
  -- bookkeeping that changes on every write, and neither is a venue detail
  -- anyone reading the history is looking for.
  new_row := new_row - 'updated_at' - 'last_modified_by';

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (new.id, new.last_modified_by, '{}'::jsonb, new_row);

  return null;
end;
$$;

create trigger venues_record_creation
  after insert on venues
  for each row
  execute function record_venue_creation();

-- The layouts, accessibility features and facilities live in junction tables, so
-- create_venue and update_venue record their changes through these two.

create or replace function venue_attribute_snapshot(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'room_layouts', coalesce(
      (select jsonb_agg(room_layout_code order by room_layout_code)
         from venue_room_layouts where venue_id = p_id), '[]'::jsonb),
    'accessibility_features', coalesce(
      (select jsonb_agg(accessibility_feature_code order by accessibility_feature_code)
         from venue_accessibility_features where venue_id = p_id), '[]'::jsonb),
    'facilities', coalesce(
      (select jsonb_agg(facility_code order by facility_code)
         from venue_facilities where venue_id = p_id), '[]'::jsonb),
    'operating_hours', coalesce(
      (select jsonb_agg(
                jsonb_build_object('day_of_week', day_of_week,
                                   'opens_at', opens_at,
                                   'closes_at', closes_at)
                order by day_of_week)
         from venue_operating_hours where venue_id = p_id), '[]'::jsonb)
  );
$$;

create or replace function record_venue_attribute_change(
  p_id      uuid,
  p_before  jsonb,
  p_after   jsonb,
  p_user_id uuid
)
returns void
language plpgsql
as $$
declare
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  k           text;
begin
  for k in select jsonb_object_keys(p_after) loop
    if p_before -> k is distinct from p_after -> k then
      old_changed := old_changed || jsonb_build_object(k, p_before -> k);
      new_changed := new_changed || jsonb_build_object(k, p_after -> k);
    end if;
  end loop;

  if old_changed = '{}'::jsonb then
    return;
  end if;

  insert into venue_change_history (venue_id, changed_by, old_values, new_values)
  values (p_id, p_user_id, old_changed, new_changed);
end;
$$;

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
