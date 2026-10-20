-- Baseline 04: venue blocks and their history, bookings, holds and flagged-booking
-- resolutions, with the occupancy, block, booking and hold functions.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

-- A block takes a venue out of use for a period; removing one keeps the row.
create table venue_blocks (
  id uuid not null default gen_random_uuid(),
  venue_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason venue_block_reason not null,
  notes text,
  created_by uuid,
  last_modified_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid,
  constraint venue_blocks_pkey primary key (id),
  constraint venue_blocks_created_by_fkey foreign key (created_by) references auth.users(id),
  constraint venue_blocks_last_modified_by_fkey foreign key (last_modified_by) references auth.users(id),
  constraint venue_blocks_removed_by_fkey foreign key (removed_by) references auth.users(id),
  constraint venue_blocks_venue_id_fkey foreign key (venue_id) references venues(id) on delete restrict,
  constraint venue_blocks_notes_length check ((notes is null) or (length(notes) <= 1000)),
  constraint venue_blocks_other_needs_notes check ((reason <> 'other'::venue_block_reason) or (length(trim(coalesce(notes, ''::text))) > 0)),
  constraint venue_blocks_removed_by_needs_removed_at check ((removed_by is null) or (removed_at is not null)),
  constraint venue_blocks_times_ordered check (ends_at > starts_at),
  -- Active blocks on one venue never overlap. '[)' lets a block start as another ends.
  constraint venue_blocks_no_overlap exclude using gist (venue_id with =, tstzrange(starts_at, ends_at, '[)'::text) with &&) where ((removed_at is null))
);
create index idx_venue_blocks_venue_active on venue_blocks (venue_id, starts_at) where (removed_at is null);
alter table venue_blocks enable row level security;

create trigger venue_blocks_set_updated_at
  before update on venue_blocks
  for each row
  execute function set_updated_at();

create table venue_block_history (
  id uuid not null default gen_random_uuid(),
  block_id uuid not null,
  action text not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  old_values jsonb not null,
  new_values jsonb not null,
  constraint venue_block_history_pkey primary key (id),
  constraint venue_block_history_block_id_fkey foreign key (block_id) references venue_blocks(id) on delete restrict,
  constraint venue_block_history_changed_by_fkey foreign key (changed_by) references auth.users(id),
  constraint venue_block_history_action_known check (action = any (array['created'::text, 'amended'::text, 'removed'::text]))
);
create index idx_venue_block_history_block on venue_block_history (block_id, changed_at desc);
alter table venue_block_history enable row level security;

-- One row per venue booked for an event; an event may have several.
create table bookings (
  id uuid not null default gen_random_uuid(),
  venue_id uuid not null,
  event_request_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Only an approved booking occupies the venue; clashing pending requests are allowed.
  status booking_status not null default 'pending',
  review_block_id uuid,
  flagged_at timestamptz,
  flagged_by uuid,
  review_reason text,
  expected_attendance integer,
  room_layout_code text,
  requested_by uuid,
  venue_requirements text,
  accessibility_requirements text,
  setup_notes text,
  suitability_result jsonb,
  suitability_overridden boolean not null default false,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  suggested_alternative text,
  replaces_booking_id uuid,
  released_by uuid,
  released_at timestamptz,
  release_reason text,
  flag_reason text,
  constraint bookings_pkey primary key (id),
  constraint bookings_decided_by_fkey foreign key (decided_by) references auth.users(id),
  constraint bookings_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint bookings_flagged_by_fkey foreign key (flagged_by) references auth.users(id),
  constraint bookings_released_by_fkey foreign key (released_by) references auth.users(id) on delete restrict,
  constraint bookings_replaces_booking_id_fkey foreign key (replaces_booking_id) references bookings(id),
  constraint bookings_requested_by_fkey foreign key (requested_by) references auth.users(id),
  constraint bookings_review_block_id_fkey foreign key (review_block_id) references venue_blocks(id) on delete set null,
  constraint bookings_room_layout_code_fkey foreign key (room_layout_code) references room_layouts(code) on delete restrict,
  constraint bookings_venue_id_fkey foreign key (venue_id) references venues(id) on delete restrict,
  constraint bookings_decided_not_pending check ((decided_at is null) or ((status)::text <> all (array['pending'::text, 'conflicting'::text, 'withdrawn'::text]))),
  constraint bookings_decided_paired check ((decided_by is null) = (decided_at is null)),
  constraint bookings_decision_reason_on_rejection check ((decision_reason is null) or (((status)::text = 'rejected'::text) and (decided_at is not null) and (length(btrim(decision_reason)) > 0) and (length(decision_reason) <= 1000))),
  constraint bookings_expected_attendance_positive check ((expected_attendance is null) or (expected_attendance > 0)),
  constraint bookings_flag_reason_known check (flag_reason = any (array['venue_block'::text, 'venue_edit'::text, 'safety_review'::text, 'event_change'::text])),
  constraint bookings_flag_reason_requires_block check ((flag_reason <> 'venue_block'::text) or (review_block_id is not null)),
  constraint bookings_rejection_has_reason check ((decided_at is null) or ((status)::text <> 'rejected'::text) or (decision_reason is not null)),
  constraint bookings_release_matches_status check (((status)::text = 'released'::text) = (released_at is not null)),
  constraint bookings_release_paired check (((released_by is null) and (released_at is null) and (release_reason is null)) or ((released_by is not null) and (released_at is not null) and (release_reason is not null))),
  constraint bookings_release_reason_length check ((release_reason is null) or ((release_reason = btrim(release_reason)) and ((length(release_reason) >= 1) and (length(release_reason) <= 1000)))),
  -- Not tied to status: a booking can move on (say, to cancelled) and keep the record of
  -- why it was flagged.
  constraint bookings_review_flag_paired check ((flagged_at is null) = ((review_block_id is null) and (review_reason is null) and (flag_reason is null))),
  constraint bookings_review_reason_known check (review_reason = any (array['setup_or_turnaround_changed'::text, 'safety_review'::text, 'event_changed'::text, 'venue_details_changed'::text])),
  constraint bookings_setup_notes_length check ((setup_notes is null) or (length(setup_notes) <= 1000)),
  constraint bookings_suggested_alternative_on_rejection check ((suggested_alternative is null) or ((decision_reason is not null) and (length(btrim(suggested_alternative)) > 0) and (length(suggested_alternative) <= 1000))),
  constraint bookings_times_ordered check (ends_at > starts_at)
);
create index idx_bookings_event_request on bookings (event_request_id);
create index idx_bookings_replaces_booking on bookings (replaces_booking_id) where (replaces_booking_id is not null);
create index idx_bookings_review_block on bookings (review_block_id) where (review_block_id is not null);
create index idx_bookings_venue on bookings (venue_id, starts_at desc);
create index idx_bookings_venue_approved on bookings (venue_id, starts_at, ends_at) where (status = 'approved'::booking_status);
alter table bookings enable row level security;

-- A hold reserves a venue for a short time; an expired hold never counts as a booking.
create table venue_holds (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  venue_id uuid not null,
  placed_by uuid not null,
  placed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status venue_hold_status not null default 'active',
  expired_at timestamptz,
  released_at timestamptz,
  released_by uuid,
  converted_at timestamptz,
  converted_booking_id uuid,
  constraint venue_holds_pkey primary key (id),
  constraint venue_holds_converted_booking_id_fkey foreign key (converted_booking_id) references bookings(id),
  constraint venue_holds_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint venue_holds_placed_by_fkey foreign key (placed_by) references auth.users(id),
  constraint venue_holds_released_by_fkey foreign key (released_by) references auth.users(id),
  constraint venue_holds_venue_id_fkey foreign key (venue_id) references venues(id),
  constraint venue_holds_converted_at_matches_status check (((status)::text = 'converted'::text) = (converted_at is not null)),
  constraint venue_holds_converted_booking_matches_status check (((status)::text = 'converted'::text) = (converted_booking_id is not null)),
  constraint venue_holds_expired_at_matches_status check ((status = 'expired'::venue_hold_status) = (expired_at is not null)),
  constraint venue_holds_expires_after_placed check (expires_at > placed_at),
  constraint venue_holds_released_at_matches_status check (((status)::text = 'released'::text) = (released_at is not null))
);
create index idx_venue_holds_active_expires on venue_holds (expires_at) where (status = 'active'::venue_hold_status);
create index idx_venue_holds_active_venue on venue_holds (venue_id) where (status = 'active'::venue_hold_status);
-- One active hold per event at each venue. An event may hold several venues.
create unique index venue_holds_one_active_per_event_venue on venue_holds (event_request_id, venue_id) where (status = 'active'::venue_hold_status);
alter table venue_holds enable row level security;

-- How a flagged booking was resolved: reinstated, cancelled or replaced.
create table booking_resolutions (
  id uuid not null default gen_random_uuid(),
  booking_id uuid not null,
  outcome text not null,
  reason text not null,
  resolved_by uuid not null,
  review_block_id uuid,
  review_reason text,
  flagged_at timestamptz,
  flagged_by uuid,
  replacement_booking_id uuid,
  created_at timestamptz not null default now(),
  constraint booking_resolutions_pkey primary key (id),
  constraint booking_resolutions_booking_id_fkey foreign key (booking_id) references bookings(id) on delete restrict,
  constraint booking_resolutions_replacement_booking_id_fkey foreign key (replacement_booking_id) references bookings(id),
  constraint booking_resolutions_resolved_by_fkey foreign key (resolved_by) references auth.users(id) on delete restrict,
  constraint booking_resolutions_review_block_id_fkey foreign key (review_block_id) references venue_blocks(id) on delete set null,
  constraint booking_resolutions_outcome_check check (outcome = any (array['reinstated'::text, 'cancelled'::text, 'replaced'::text])),
  constraint booking_resolutions_reason_check check ((reason = btrim(reason)) and ((length(reason) >= 1) and (length(reason) <= 1000))),
  -- Only a replacement names the booking that replaced this one.
  constraint booking_resolutions_replacement_paired check ((outcome = 'replaced'::text) = (replacement_booking_id is not null))
);
create index idx_booking_resolutions_booking on booking_resolutions (booking_id, created_at);
alter table booking_resolutions enable row level security;

-- Occupancy: a booking or block occupies its venue from setup before to turnaround after.
-- These sql functions are checked when created, so they follow the tables they read.

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

-- Venue blocks: create, amend and remove, each recorded in the block history.

create or replace function record_venue_block_change()
returns trigger
language plpgsql
as $$
declare
  old_row     jsonb;
  new_row     jsonb := to_jsonb(new);
  old_changed jsonb := '{}'::jsonb;
  new_changed jsonb := '{}'::jsonb;
  col         text;
begin
  -- old_values '{}' is 008's convention for "this did not exist before".
  if tg_op = 'INSERT' then
    insert into venue_block_history (block_id, action, changed_by, old_values, new_values)
    values (new.id, 'created', new.last_modified_by, '{}'::jsonb,
            new_row - 'updated_at' - 'last_modified_by');
    return null;
  end if;

  old_row := to_jsonb(old);

  for col in select jsonb_object_keys(new_row) loop
    if col in ('updated_at', 'last_modified_by') then
      continue;
    end if;

    if old_row -> col is distinct from new_row -> col then
      old_changed := old_changed || jsonb_build_object(col, old_row -> col);
      new_changed := new_changed || jsonb_build_object(col, new_row -> col);
    end if;
  end loop;

  -- Nothing meaningful changed. update_venue_block (015) still bumps
  -- last_modified_by and updated_at on a no-op save, but that is not an
  -- amendment and gets no entry.
  if old_changed = '{}'::jsonb then
    return null;
  end if;

  -- Removal is the one transition worth naming: remove_venue_block (015) is
  -- the only thing that sets removed_at, and nothing ever clears it.
  insert into venue_block_history (block_id, action, changed_by, old_values, new_values)
  values (
    new.id,
    case
      when old.removed_at is null and new.removed_at is not null then 'removed'
      else 'amended'
    end,
    new.last_modified_by,
    old_changed,
    new_changed
  );

  return null;
end;
$$;

create trigger venue_blocks_record_change
  after insert or update on venue_blocks
  for each row
  execute function record_venue_block_change();

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

  -- 3. Notify. One row per flagged booking for the event's assigned
  --    coordinator, or for every Event Coordinator Lead when it has none.
  --    AC5 means the event's own coordinator; the Leads cover an unassigned
  --    event so no flag goes unseen.
  --
  --    The payload keys are camelCase because the API returns the payload to
  --    the frontend as it is stored; converting nested jsonb key by key in
  --    the service would buy nothing.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
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

  -- 4. Tell the coordinator of each open request the block now covers, with
  --    the same recipients as step 3. The status is left alone: a request
  --    does not occupy the venue, so the block flags nothing (domain rule),
  --    but the coordinator learns early that this venue is unlikely.
  --
  --    The overlap is step 2's -- block unpadded, request padded by the
  --    venue's setup and turnaround -- written out: the occupancy function
  --    skips open requests, and pending_request_overlaps would pad the block.
  insert into notifications (recipient_id, type, booking_id, block_id, payload)
  select r.recipient_id,
         'booking_request_venue_unavailable',
         b.id,
         v_block.id,
         jsonb_build_object(
           'cause',          'block',
           'eventRequestId', er.id,
           'eventName',      er.event_name,
           'venueId',        v.id,
           'venueName',      v.name,
           'startsAt',       b.starts_at,
           'endsAt',         b.ends_at,
           'reason',         v_block.reason,
           'blockStartsAt',  v_block.starts_at,
           'blockEndsAt',    v_block.ends_at
         )
    from bookings b
    join venues v          on v.id  = b.venue_id
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
   where b.venue_id = v_block.venue_id
     and b.status in ('pending', 'conflicting')
     and venue_occupied_period(b.starts_at, b.ends_at,
                               v.setup_minutes::integer, v.turnaround_minutes::integer)
         && venue_occupied_period(v_block.starts_at, v_block.ends_at, 0, 0)
  -- No conflict target: naming booking_id here would clash with this
  -- function's own booking_id output column. The only unique index a new
  -- row can meet is notifications_request_unavailable_once_per_block.
  on conflict do nothing;

  -- 5. The flagged bookings, soonest first, in 014's column order.
  return query
    select b.id, b.event_request_id, er.event_name, b.starts_at, b.ends_at
      from bookings b
      join event_requests er on er.id = b.event_request_id
     where b.id = any (v_flagged)
     order by b.starts_at, b.id;
end;
$$;
revoke execute on function flag_bookings_for_block(uuid, uuid[], uuid) from public, anon, authenticated;

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
revoke execute on function update_venue_block(uuid, uuid, timestamp with time zone, timestamp with time zone, venue_block_reason, text, boolean, uuid, boolean, uuid[]) from public, anon, authenticated;

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
revoke execute on function remove_venue_block(uuid, uuid, uuid) from public, anon, authenticated;

-- Booking requests and venue staff decisions.

create or replace function pending_request_overlaps(
  p_venue_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_exclude_event_id  uuid
)
returns table (
  id                 uuid,
  event_request_id   uuid,
  event_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  occupied_starts_at timestamptz,
  occupied_ends_at   timestamptz,
  created_at         timestamptz
)
language sql
stable
as $$
  with requested as (
    select v.id,
           v.setup_minutes::integer      as setup_minutes,
           v.turnaround_minutes::integer as turnaround_minutes,
           venue_occupied_period(p_starts_at, p_ends_at,
                                 v.setup_minutes, v.turnaround_minutes) as period
      from venues v
     where v.id = p_venue_id
  ),
  pending as (
    select b.id,
           b.event_request_id,
           er.event_name,
           b.starts_at,
           b.ends_at,
           b.created_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 req.setup_minutes, req.turnaround_minutes) as occupied,
           req.period
      from requested req
      join bookings b
        on b.venue_id = req.id
      join event_requests er
        on er.id = b.event_request_id
     where b.status in ('pending', 'conflicting')
       and b.event_request_id is distinct from p_exclude_event_id
  )
  select p.id,
         p.event_request_id,
         p.event_name,
         p.starts_at,
         p.ends_at,
         lower(p.occupied),
         upper(p.occupied),
         p.created_at
    from pending p
   where p.occupied && p.period
   order by p.created_at, p.id;
$$;
revoke execute on function pending_request_overlaps(uuid, timestamp with time zone, timestamp with time zone, uuid) from public, anon, authenticated;

create or replace function create_booking_request(
  p_event_request_id   uuid,
  p_venue_id           uuid,
  p_requested_by       uuid,
  p_room_layout_code   text    default null,
  p_setup_notes        text    default null,
  p_suitability        jsonb   default null,
  p_confirm_unsuitable boolean default false,
  p_expected_attendance integer default null,
  p_replaces_booking_id uuid    default null
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
  v_replaced        bookings;
  v_venue_name      text;
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

  -- 3. Only an event past approval and still live: approved, in or through
  --    the safety check, or confirmed. Compared as text, as 062 explains.
  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be requested for an event that is approved, in or through the safety check, or confirmed',
      p_event_request_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- The period is the event's own, never the caller's. A null bound would make
  -- the overlap queries below match nothing and let the request through.
  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'event request % has no proposed start and end', p_event_request_id
      using errcode = 'PT409', hint = 'EVENT_DATES_MISSING';
  end if;

  -- 3a. SCRUM-266: the booking this request replaces, if any, is one of this
  --     event's and is still flagged. Its status cannot change meanwhile:
  --     076 and 077 lock this event before they touch it.
  if p_replaces_booking_id is not null then
    select *
      into v_replaced
      from bookings
     where id = p_replaces_booking_id;

    if not found or v_replaced.event_request_id is distinct from p_event_request_id then
      raise exception 'booking % is not a booking of event request %',
        p_replaces_booking_id, p_event_request_id
        using errcode = 'PT409', hint = 'REPLACED_BOOKING_NOT_ON_EVENT';
    end if;

    if v_replaced.status::text <> 'flagged_for_review' then
      raise exception 'booking % is %, and only a booking flagged for review can be replaced',
        p_replaces_booking_id, v_replaced.status
        using errcode = 'PT409', hint = 'REPLACED_BOOKING_NOT_FLAGGED';
    end if;
  end if;

  -- The API always sends the result it computed. A missing one is a fault in
  -- the caller, not something to default to "suitable".
  if p_suitability is null or jsonb_typeof(p_suitability -> 'suitable') is distinct from 'boolean' then
    raise exception 'a suitability result with a boolean "suitable" is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- SCRUM-525 AC2: the request's own expected attendance, at least 1. The
  -- API always sends one, defaulting to the event's, so a missing one is a
  -- fault in the caller. Checked after the event lookup, so an unknown event
  -- is still P0002.
  if p_expected_attendance is null or p_expected_attendance < 1 then
    raise exception 'an expected attendance of at least 1 is required, got %',
      coalesce(p_expected_attendance::text, 'none')
      using errcode = 'invalid_parameter_value';
  end if;

  -- A venue cannot be for more people than the event expects; equal is fine.
  -- Checked here, at request time only (see 051's header).
  if v_event.expected_attendance is not null
     and p_expected_attendance > v_event.expected_attendance then
    raise exception 'an expected attendance of at most the event''s (%) is required, got %',
      v_event.expected_attendance, p_expected_attendance
      using errcode = 'invalid_parameter_value';
  end if;

  -- 4. Lock the venue, "for share" (see 051's header). A block being created
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

  -- 6. One live request per event AT THIS VENUE (SCRUM-525 AC1). Pending,
  --    conflicting and approved count, and so does a booking flagged for
  --    review: it still holds this venue until it is resolved (SCRUM-266), but
  --    it no longer stops the event requesting another venue. Rejected,
  --    withdrawn and cancelled ones free the venue. A flagged one is named in
  --    preference, because it is the one the coordinator has to act on. Under
  --    the event lock, so a request for this venue that is committing now is
  --    already visible.
  select b.id, b.status
    into v_existing_id, v_existing_status
    from bookings b
   where b.event_request_id = p_event_request_id
     and b.venue_id = p_venue_id
     and b.status in ('pending', 'conflicting', 'approved', 'flagged_for_review')
   order by (b.status = 'flagged_for_review') desc, b.created_at, b.id
   limit 1;

  if v_existing_id is not null then
    if v_existing_status = 'flagged_for_review' then
      raise exception 'event request % has a booking at venue % flagged for review, which must be resolved first',
        p_event_request_id, p_venue_id
        using errcode = 'PT409', hint = 'BOOKING_FLAGGED_FOR_REVIEW', detail = v_existing_id::text;
    end if;

    raise exception 'event request % already has a % booking request for venue %',
      p_event_request_id, v_existing_status, p_venue_id
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
  --    The check is for this venue only. Step 6 has already refused a live
  --    booking of this event here. Its bookings at other venues are not at
  --    this venue, so they never conflict (SCRUM-525 AC4); every other
  --    event's occupying booking here still does.
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

  -- 9. Insert. The status is written here and not taken from the caller or the
  --    column default, so a request is pending by construction.
  --    expected_attendance is the request's own value, not the event's
  --    (SCRUM-525 AC2).
  insert into bookings (
    venue_id, event_request_id, starts_at, ends_at, status,
    requested_by, room_layout_code, venue_requirements, accessibility_requirements,
    setup_notes, suitability_result, suitability_overridden, expected_attendance,
    replaces_booking_id
  )
  values (
    p_venue_id, p_event_request_id, v_event.proposed_start, v_event.proposed_end, 'pending',
    p_requested_by, p_room_layout_code, v_event.venue_requirements, v_event.accessibility_requirements,
    p_setup_notes, p_suitability, not v_suitable, p_expected_attendance,
    p_replaces_booking_id
  )
  returning * into v_booking;

  -- 10. Tell every Venue Staff user, in the same transaction, so a rolled back
  --     request notifies nobody. A conflict or an unconfirmed unsuitable venue
  --     returned above without a request, so it notifies nobody either.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_request_submitted',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_booking.event_request_id,
           'eventName',      v_event.event_name,
           'venueId',        v_booking.venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at
         )
    from profiles p
   where p.role = 'venue_staff';

  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(v_booking));
end;
$$;
revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer, uuid) from public, anon, authenticated;

create or replace function withdraw_booking_request(
  p_booking_id   uuid,
  p_requested_by uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_event_id   uuid;
  v_event      event_requests;
  v_booking    bookings;
  v_venue_name text;
begin
  -- 1. Which event this is for. Read without a lock: a booking's event never
  --    changes, and the lock that matters is the event's, taken next.
  select b.event_request_id
    into v_event_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 2. Lock the event, then read it.
  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Only the assigned coordinator. A null caller is refused explicitly (see
  --    018).
  if p_requested_by is null
     or v_event.assigned_coordinator_id is distinct from p_requested_by then
    raise exception 'only the coordinator assigned to event request % can withdraw its booking requests',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. Lock the booking and read its status as it is now, not as the caller saw
  --    it.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status not in ('pending', 'conflicting') then
    raise exception 'booking request % is %, and only a pending or conflicting request can be withdrawn',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  -- 5. The change, guarded so it can only ever move an open request.
  update bookings
     set status = 'withdrawn'
   where id = p_booking_id
     and status in ('pending', 'conflicting')
  returning * into v_booking;

  if not found then
    raise exception 'booking request % changed while it was being withdrawn', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 6. Tell Venue Staff, in the same transaction.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_request_withdrawn',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_booking.event_request_id,
           'eventName',      v_event.event_name,
           'venueId',        v_booking.venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at
         )
    from profiles p
   where p.role = 'venue_staff';

  return jsonb_build_object('outcome', 'withdrawn', 'booking', to_jsonb(v_booking));
end;
$$;
revoke execute on function withdraw_booking_request(uuid, uuid) from public, anon, authenticated;

create or replace function list_pending_booking_requests(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as place_venue_hold (040) checks it. A null caller is
  -- refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view pending booking requests'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    with pending as (
      select b.*,
             er.event_name,
             er.status::text                      as event_status,
             v.name                               as venue_name,
             v.location                           as venue_location,
             venue_occupied_period(b.starts_at, b.ends_at,
                                   v.setup_minutes, v.turnaround_minutes) as occupied
        from bookings b
        join event_requests er on er.id = b.event_request_id
        join venues v          on v.id  = b.venue_id
       where b.status in ('pending', 'conflicting')
    )
    select jsonb_agg(
             jsonb_build_object(
               'id',                         p.id,
               'status',                     p.status,
               'event_request_id',           p.event_request_id,
               'event_name',                 p.event_name,
               'event_status',               p.event_status,
               'venue_id',                   p.venue_id,
               'venue_name',                 p.venue_name,
               'venue_location',             p.venue_location,
               'starts_at',                  p.starts_at,
               'ends_at',                    p.ends_at,
               'occupied_starts_at',         lower(p.occupied),
               'occupied_ends_at',           upper(p.occupied),
               'expected_attendance',        p.expected_attendance,
               'room_layout_code',           p.room_layout_code,
               'venue_requirements',         p.venue_requirements,
               'accessibility_requirements', p.accessibility_requirements,
               'setup_notes',                p.setup_notes,
               'suitability_result',         p.suitability_result,
               'suitability_overridden',     p.suitability_overridden,
               'requested_by',               p.requested_by,
               'created_at',                 p.created_at,
               -- Other events only, which also leaves this request out: 051
               -- refuses a second live request for the same event and venue,
               -- so a same-event clash is not a choice Venue Staff make.
               'overlapping', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',                 o.id,
                            'event_request_id',   o.event_request_id,
                            'event_name',         o.event_name,
                            'starts_at',          o.starts_at,
                            'ends_at',            o.ends_at,
                            'occupied_starts_at', o.occupied_starts_at,
                            'occupied_ends_at',   o.occupied_ends_at,
                            'created_at',         o.created_at
                          )
                          order by o.created_at, o.id
                        )
                   from pending_request_overlaps(p.venue_id, p.starts_at, p.ends_at,
                                                 p.event_request_id) o
               ), '[]'::jsonb),
               -- Bookings only: a block or hold never marks a request
               -- conflicting. Flagged-for-review bookings are kept, because
               -- they still occupy the venue until the Coordinator decides.
               'conflicting_with', case when p.status::text = 'conflicting' then coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'booking_id',         c.id,
                            'event_request_id',   c.event_request_id,
                            'event_name',         c.event_name,
                            'starts_at',          c.starts_at,
                            'ends_at',            c.ends_at,
                            'occupied_starts_at', c.occupied_starts_at,
                            'occupied_ends_at',   c.occupied_ends_at
                          )
                          order by c.starts_at, c.id
                        )
                   from venue_occupancy_conflicts(p.venue_id, p.starts_at, p.ends_at, true,
                                                  p.event_request_id) c
                  where c.kind = 'booking'
               ), '[]'::jsonb) else '[]'::jsonb end,
               -- Null once the booking it names is no longer flagged: then
               -- approving this request leaves that booking alone (section 6).
               'replaces', (
                 select jsonb_build_object(
                          'booking_id', fb.id,
                          'venue_name', fv.name,
                          'starts_at',  fb.starts_at,
                          'ends_at',    fb.ends_at
                        )
                   from bookings fb
                   join venues fv on fv.id = fb.venue_id
                  where fb.id = p.replaces_booking_id
                    and fb.status = 'flagged_for_review'
               )
             )
             order by p.created_at, p.id
           )
      from pending p
  ), '[]'::jsonb);
end;
$$;
revoke execute on function list_pending_booking_requests(uuid) from public, anon, authenticated;

create or replace function decide_booking_request(
  p_booking_id            uuid,
  p_caller                uuid,
  p_decision              text,
  p_reason                text default null,
  p_suggested_alternative text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_venue_id    uuid;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_booking     bookings;
  v_conflicts   jsonb;
  v_new_status  text;
  v_venue_name  text;
  v_marked_ids  uuid[] := '{}';
  v_converted_hold_id uuid;
  v_replaced    bookings;
  v_resolution_id uuid;
begin
  -- 1. Only Venue Staff, as place_venue_hold (040) checks it. A null caller is
  --    refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can decide a booking request'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. The decision and what goes with it. A reason is required to reject, and
  --    is never recorded against an approval.
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'the decision must be approve or reject, got %', coalesce(p_decision, 'none')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'reject' and (p_reason is null or length(btrim(p_reason)) = 0) then
    raise exception 'a reason is required to reject a booking request'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'approve' and (p_reason is not null or p_suggested_alternative is not null) then
    raise exception 'a reason or alternative is recorded only with a rejection'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 3. Which event and venue. Read without a lock, as 031 does: neither ever
  --    changes on a booking, and the locks that matter are taken next.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Lock the event, then read it, so its status and period hold until the
  --    write.
  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 5. Approval only: lock the venue (see 066's section header).
  if p_decision = 'approve' then
    select retired_at
      into v_retired_at
      from venues
     where id = v_venue_id
       for no key update;
  end if;

  -- 6. Lock the booking and read its status as it is now.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking request % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- A conflicting request is still open (see 066's section header).
  if v_booking.status::text not in ('pending', 'conflicting') then
    raise exception 'booking request % is %, and only a pending or conflicting request can be decided',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_PENDING';
  end if;

  if p_decision = 'approve' then
    -- 7. An event past approval and still live: the statuses a venue can be
    --    requested for (create_booking_request, step 3).
    if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
      raise exception 'event request % has status %, and a venue can only be booked for an event that is approved, in or through the safety check, or confirmed',
        v_event_id, v_event.status
        using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
    end if;

    -- 8. The request is for the event's current period. One raised before the
    --    event moved would book the venue for the old one.
    if v_booking.starts_at is distinct from v_event.proposed_start
       or v_booking.ends_at is distinct from v_event.proposed_end then
      raise exception 'booking request % is for a period the event no longer has', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
    end if;

    if v_retired_at is not null then
      raise exception 'venue % is retired and cannot be booked', v_venue_id
        using errcode = 'PT409', hint = 'VENUE_RETIRED';
    end if;

    -- 9. The re-check, through the shared function, as create_booking_request
    --    step 7 asks it: padded, with this event's own holds left out.
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
      from venue_occupancy_conflicts(v_venue_id, v_booking.starts_at, v_booking.ends_at, true,
                                     v_event_id) c;

    if jsonb_array_length(v_conflicts) > 0 then
      return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
    end if;

    v_new_status := 'approved';
  else
    v_new_status := 'rejected';
  end if;

  -- 10. The decision, guarded so it can only ever move an open request.
  --     Texts are trimmed; a blank alternative is none.
  update bookings
     set status                = v_new_status::booking_status,
         decided_by            = p_caller,
         decided_at            = now(),
         decision_reason       = btrim(p_reason),
         suggested_alternative = nullif(btrim(p_suggested_alternative), '')
   where id = p_booking_id
     and status in ('pending', 'conflicting')
  returning * into v_booking;

  if not found then
    raise exception 'booking request % changed while it was being decided', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 11. Tell the event's coordinator, in the same transaction. An event with
  --     no coordinator has nobody to tell.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_booking.venue_id;

  insert into notifications (recipient_id, type, booking_id, payload)
  select v_event.assigned_coordinator_id,
         'booking_request_' || v_new_status,
         v_booking.id,
         jsonb_build_object(
           'eventRequestId',       v_booking.event_request_id,
           'eventName',            v_event.event_name,
           'venueId',              v_booking.venue_id,
           'venueName',            v_venue_name,
           'startsAt',             v_booking.starts_at,
           'endsAt',               v_booking.ends_at,
           'decidedAt',            v_booking.decided_at,
           'reason',               v_booking.decision_reason,
           'suggestedAlternative', v_booking.suggested_alternative
         )
   where v_event.assigned_coordinator_id is not null;

  if v_new_status = 'rejected' then
    return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking));
  end if;

  -- 12. Approval only: lock the other events' pending requests that overlap
  --     this one's occupied period, in id order (see 066's header), and
  --     mark them conflicting. The venue lock keeps a new request from being
  --     raised here meanwhile, so the set cannot grow before the update.
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_marked_ids
    from (
      select b.id
        from bookings b
       where b.id in (select o.id
                        from pending_request_overlaps(v_booking.venue_id, v_booking.starts_at,
                                                      v_booking.ends_at, v_event_id) o)
         and b.status = 'pending'
       order by b.id
         for update
    ) locked;

  update bookings
     set status = 'conflicting'
   where id = any (v_marked_ids)
     and status = 'pending';

  -- Each coordinator is told which approval their request now clashes with.
  -- Their events are read, not locked (see 066's section header).
  insert into notifications (recipient_id, type, booking_id, payload)
  select er.assigned_coordinator_id,
         'booking_request_conflicting',
         b.id,
         jsonb_build_object(
           'eventRequestId',         b.event_request_id,
           'eventName',              er.event_name,
           'venueId',                b.venue_id,
           'venueName',              v_venue_name,
           'startsAt',               b.starts_at,
           'endsAt',                 b.ends_at,
           'approvedBookingId',      v_booking.id,
           'approvedEventRequestId', v_booking.event_request_id,
           'approvedEventName',      v_event.event_name,
           'approvedStartsAt',       v_booking.starts_at,
           'approvedEndsAt',         v_booking.ends_at
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_marked_ids)
     and er.assigned_coordinator_id is not null
   order by b.id;

  -- 13. Approval only: this event's own hold at this venue becomes converted,
  --     if it is still active and unexpired. A hold past its expiry is not a
  --     booking and never was one here; the expiry job records it as expired.
  --     Holds at the event's other venues and other events' holds are not
  --     touched. No hold, nothing to convert. The update takes the row lock.
  update venue_holds
     set status               = 'converted',
         converted_at         = now(),
         converted_booking_id = v_booking.id
   where event_request_id = v_event_id
     and venue_id = v_booking.venue_id
     and status = 'active'
     and expires_at > now()
  returning id into v_converted_hold_id;

  -- 14. SCRUM-266, approval only: the flagged booking this one replaces is
  --     cancelled, with the resolution recorded, as 077 records one. It is
  --     this event's (create_booking_request, step 3a), so the event lock
  --     covers it. Already reinstated or cancelled, it is left as it is.
  if v_booking.replaces_booking_id is not null then
    update bookings
       set status = 'cancelled'
     where id = v_booking.replaces_booking_id
       and event_request_id = v_event_id
       and status = 'flagged_for_review'
    returning * into v_replaced;

    -- The flag stays on a cancelled booking (077), so it is copied from there.
    if found then
      insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                       review_block_id, review_reason, flagged_at, flagged_by,
                                       replacement_booking_id)
      values (v_replaced.id, 'replaced', 'Replaced by an approved booking', p_caller,
              v_replaced.review_block_id, v_replaced.review_reason,
              v_replaced.flagged_at, v_replaced.flagged_by,
              v_booking.id)
      returning id into v_resolution_id;

      perform notify_flagged_booking_resolved(v_resolution_id, 'venue_staff');
    end if;
  end if;

  return jsonb_build_object('outcome', v_new_status, 'booking', to_jsonb(v_booking),
                            'marked_conflicting', to_jsonb(v_marked_ids),
                            'converted_hold_id', v_converted_hold_id,
                            'replaced_booking_id', v_replaced.id);
end;
$$;
revoke execute on function decide_booking_request(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function refuse_decided_booking_change()
returns trigger
language plpgsql
as $$
begin
  if old.released_at is not null
     and ((new.released_by, new.released_at, new.release_reason)
            is distinct from (old.released_by, old.released_at, old.release_reason)
          or new.status is distinct from old.status) then
    raise exception 'booking % has been released, and a release cannot be changed or undone', old.id
      using errcode = '42501';
  end if;

  -- A release only ever comes from approved, decided or not.
  if new.status::text = 'released'
     and old.status::text is distinct from 'released'
     and old.status::text <> 'approved' then
    raise exception 'booking % is %, and only an approved booking can be released',
      old.id, old.status
      using errcode = '42501';
  end if;

  if old.decided_at is null then
    return new;
  end if;

  if (new.decided_by, new.decided_at, new.decision_reason, new.suggested_alternative)
     is distinct from
     (old.decided_by, old.decided_at, old.decision_reason, old.suggested_alternative) then
    raise exception 'booking % has been decided, and its decision cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and (old.status::text, new.status::text) not in (
       ('approved', 'flagged_for_review'),
       ('approved', 'cancelled'),
       ('flagged_for_review', 'cancelled'),
       ('flagged_for_review', 'approved'),
       ('approved', 'released')
     ) then
    raise exception 'booking % has been decided, and cannot move from % to %',
      old.id, old.status, new.status
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger bookings_decision_final
  before update on bookings
  for each row
  execute function refuse_decided_booking_change();

create or replace function set_booking_flag_reason()
returns trigger
language plpgsql
as $$
begin
  if new.flagged_at is null then
    new.flag_reason := null;
  elsif new.flag_reason is null then
    new.flag_reason := case
      when new.review_block_id is not null then 'venue_block'
      when new.review_reason in ('setup_or_turnaround_changed', 'venue_details_changed')
        then 'venue_edit'
      when new.review_reason = 'safety_review' then 'safety_review'
      else 'event_change'
    end;
  end if;
  return new;
end;
$$;

create trigger bookings_set_flag_reason
  before insert or update of review_block_id, review_reason, flagged_at, flag_reason on bookings
  for each row
  execute function set_booking_flag_reason();

-- Venue holds.

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
revoke execute on function place_venue_hold(uuid, uuid, timestamp with time zone, uuid) from public, anon, authenticated;

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

-- Flagged bookings: the coordinator lists and resolves them; nothing is cancelled
-- automatically. release_venue_booking lets the assigned coordinator give up one approved booking.

create or replace function flagged_bookings_json(p_event_request_id uuid)
returns jsonb
language sql
stable
as $$
  with flagged as (
    select b.*,
           er.event_name,
           er.status::text                      as event_status,
           er.proposed_start                    as event_starts_at,
           er.proposed_end                      as event_ends_at,
           er.assigned_coordinator_id,
           v.name                               as venue_name,
           v.location                           as venue_location,
           vb.reason::text                      as block_reason,
           vb.notes                             as block_notes,
           vb.starts_at                         as block_starts_at,
           vb.ends_at                           as block_ends_at,
           vb.removed_at                        as block_removed_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 v.setup_minutes, v.turnaround_minutes) as occupied
      from bookings b
      join event_requests er    on er.id = b.event_request_id
      join venues v             on v.id  = b.venue_id
      left join venue_blocks vb on vb.id = b.review_block_id
     where b.status = 'flagged_for_review'
       and (p_event_request_id is null or b.event_request_id = p_event_request_id)
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',                      f.id,
               'event_request_id',        f.event_request_id,
               'venue_id',                f.venue_id,
               'starts_at',               f.starts_at,
               'ends_at',                 f.ends_at,
               'occupied_starts_at',      lower(f.occupied),
               'occupied_ends_at',        upper(f.occupied),
               'flagged_at',              f.flagged_at,
               'flagged_by',              f.flagged_by,
               'review_reason',           f.review_reason,
               'event_name',              f.event_name,
               'event_status',            f.event_status,
               'event_starts_at',         f.event_starts_at,
               'event_ends_at',           f.event_ends_at,
               'assigned_coordinator_id', f.assigned_coordinator_id,
               'venue_name',              f.venue_name,
               'venue_location',          f.venue_location,
               'block_id',                f.review_block_id,
               'block_reason',            f.block_reason,
               'block_notes',             f.block_notes,
               'block_starts_at',         f.block_starts_at,
               'block_ends_at',           f.block_ends_at,
               'block_removed_at',        f.block_removed_at,
               'reinstatable',            f.review_reason is distinct from 'safety_review',
               'replacement_requests',    coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',         r.id,
                            'venue_id',   r.venue_id,
                            'venue_name', rv.name,
                            'status',     r.status,
                            'starts_at',  r.starts_at,
                            'ends_at',    r.ends_at,
                            'created_at', r.created_at
                          )
                          order by r.created_at, r.id
                        )
                   from bookings r
                   join venues rv on rv.id = r.venue_id
                  where r.replaces_booking_id = f.id
                    and r.status in ('pending', 'conflicting')
               ), '[]'::jsonb)
             )
             order by f.flagged_at nulls first, f.created_at, f.id
           ),
           '[]'::jsonb
         )
    from flagged f;
$$;
revoke execute on function flagged_bookings_json(uuid) from public, anon, authenticated;

create or replace function list_flagged_bookings(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as 076 checks it. A null caller is refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view flagged bookings'
      using errcode = 'insufficient_privilege';
  end if;

  return flagged_bookings_json(null);
end;
$$;
revoke execute on function list_flagged_bookings(uuid) from public, anon, authenticated;

create or replace function list_event_flagged_bookings(
  p_caller           uuid,
  p_event_request_id uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_coordinator_id uuid;
begin
  -- A null caller is refused before the event is looked up (see 018).
  if p_caller is null then
    raise exception 'only the assigned coordinator can view an event''s flagged bookings'
      using errcode = 'insufficient_privilege';
  end if;

  select er.assigned_coordinator_id
    into v_coordinator_id
    from event_requests er
   where er.id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_coordinator_id is distinct from p_caller then
    raise exception 'only the coordinator assigned to event request % can view its flagged bookings',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  return flagged_bookings_json(p_event_request_id);
end;
$$;
revoke execute on function list_event_flagged_bookings(uuid, uuid) from public, anon, authenticated;

create or replace function reinstate_flagged_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_venue_id    uuid;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_booking     bookings;
  v_conflicts   jsonb;
  v_resolution  booking_resolutions;
begin
  -- 1. Only Venue Staff, as decide_booking_request checks it.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can reinstate a flagged booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. A reason is required; the table's check would refuse it later anyway,
  --    but with a constraint name instead of a sentence.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to reinstate a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 3. Which event and venue, unlocked as in 066; then event, venue, booking.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select retired_at
    into v_retired_at
    from venues
   where id = v_venue_id
     for no key update;

  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 4. The booking is flagged, and not for the safety check.
  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be reinstated',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  if v_booking.review_reason = 'safety_review' then
    raise exception 'booking % was flagged by the safety review, and can only be cancelled or replaced',
      p_booking_id
      using errcode = 'PT409', hint = 'SAFETY_FLAG_NOT_REINSTATABLE';
  end if;

  -- 5. The event is still live and past approval (066, step 7).
  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be booked for an event that is approved, in or through the safety check, or confirmed',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- 6. The booking still covers the event's start to end (064). An event with
  --    no period is covered by nothing.
  if not (v_event.proposed_start is not null and v_event.proposed_end is not null
          and v_booking.starts_at <= v_event.proposed_start
          and v_booking.ends_at >= v_event.proposed_end) then
    raise exception 'booking % no longer covers the event''s period', p_booking_id
      using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
  end if;

  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be booked', v_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 7. The re-check, as 066 asks it. A flagged booking counts as an occupant,
  --    so this one is left out, or it would clash with itself.
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
    from venue_occupancy_conflicts(v_venue_id, v_booking.starts_at, v_booking.ends_at, true,
                                   v_event_id) c
   where not (c.kind = 'booking' and c.id = p_booking_id);

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. The record first, while the booking still carries the flag it copies.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by)
  values (p_booking_id, 'reinstated', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by)
  returning * into v_resolution;

  -- 9. Approved again, with the whole flag cleared (034's pairing), guarded so
  --    it only ever moves a flagged booking.
  update bookings
     set status          = 'approved',
         flagged_at      = null,
         flagged_by      = null,
         review_block_id = null,
         review_reason   = null
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being reinstated', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 10. Tell the event's people, in the same transaction.
  perform notify_flagged_booking_resolved(v_resolution.id, 'venue_staff');

  return jsonb_build_object('outcome', 'reinstated',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;
revoke execute on function reinstate_flagged_booking(uuid, uuid, text) from public, anon, authenticated;

create or replace function cancel_flagged_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_event       event_requests;
  v_booking     bookings;
  v_resolution  booking_resolutions;
begin
  -- 1. A reason is required, checked as 076 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to cancel a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event, unlocked as in 066; then the event, locked.
  select b.event_request_id
    into v_event_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 3. The event's assigned coordinator, or Venue Staff. A null caller is
  --    refused explicitly (see 018).
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null
     or (v_event.assigned_coordinator_id is distinct from p_caller
         and v_role is distinct from 'venue_staff') then
    raise exception 'only the coordinator assigned to event request % or Venue Staff can cancel a flagged booking',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. Lock the booking and read its status as it is now.
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be cancelled',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  -- 5. The record, with the flag as it stood.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by)
  values (p_booking_id, 'cancelled', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by)
  returning * into v_resolution;

  -- 6. Cancelled, guarded so it only ever moves a flagged booking. The flag
  --    stays on the booking, so it still shows why it was flagged.
  update bookings
     set status = 'cancelled'
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being cancelled', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 7. Tell the event's people, in the same transaction, naming which side
  --    resolved it. Venue Staff who are not the coordinator act as staff.
  perform notify_flagged_booking_resolved(
    v_resolution.id,
    case when v_event.assigned_coordinator_id = p_caller then 'event_coordinator' else 'venue_staff' end
  );

  return jsonb_build_object('outcome', 'cancelled',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;
revoke execute on function cancel_flagged_booking(uuid, uuid, text) from public, anon, authenticated;

create or replace function release_venue_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_event_id   uuid;
  v_venue_id   uuid;
  v_venue_name text;
  v_event      event_requests;
  v_booking    bookings;
  v_candidates uuid[];
  v_freed      uuid[];
begin
  -- 1. A reason is required, checked as 077 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to release a venue booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event and venue, unlocked as in 077; then the event, locked.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 3. The event's assigned coordinator only (D1). A null caller is refused
  --    explicitly (see 018).
  if p_caller is null or v_event.assigned_coordinator_id is distinct from p_caller then
    raise exception 'only the coordinator assigned to event request % can release its venue bookings',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. An Approved event only (D2).
  if v_event.status::text <> 'approved' then
    raise exception 'event request % is %, and its venue bookings can be released only while it is approved',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_APPROVED';
  end if;

  -- 5. Lock the venue.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_venue_id
     for no key update;

  -- 6. Lock the booking; an approved one only, each other kind pointed to its
  --    own action (D3).
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'approved' then
    if v_booking.status::text = 'flagged_for_review' then
      raise exception 'booking % is flagged for review; resolve it from Flagged bookings', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    elsif v_booking.status::text in ('pending', 'conflicting') then
      raise exception 'booking % is still a request; withdraw it instead', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    else
      raise exception 'booking % is %, and only an approved booking can be released',
        p_booking_id, v_booking.status
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    end if;
  end if;

  -- 7. Released, guarded so it only ever moves an approved booking.
  update bookings
     set status         = 'released',
         released_by    = p_caller,
         released_at    = now(),
         release_reason = btrim(p_reason)
   where id = p_booking_id
     and status = 'approved'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being released', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 8. Other events' Conflicting requests that overlap it, locked in id order
  --    as 078 step 12 locks them (D8).
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_candidates
    from (
      select b.id
        from bookings b
       where b.id in (select o.id
                        from pending_request_overlaps(v_venue_id, v_booking.starts_at,
                                                      v_booking.ends_at, v_event_id) o)
         and b.status::text = 'conflicting'
       order by b.id
         for update
    ) locked;

  -- 9. Those that nothing occupies now go back to Pending; anything else that
  --    still occupies one keeps it Conflicting.
  select coalesce(array_agg(c.id order by c.id), '{}')
    into v_freed
    from bookings c
   where c.id = any (v_candidates)
     and not exists (
       select 1
         from venue_occupancy_conflicts(c.venue_id, c.starts_at, c.ends_at, true, c.event_request_id)
     );

  update bookings
     set status = 'pending'
   where id = any (v_freed)
     and status::text = 'conflicting';

  -- Each freed request's coordinator, told which release freed it.
  insert into notifications (recipient_id, type, booking_id, payload)
  select er.assigned_coordinator_id,
         'booking_request_conflict_cleared',
         b.id,
         jsonb_build_object(
           'eventRequestId',    b.event_request_id,
           'eventName',         er.event_name,
           'venueId',           b.venue_id,
           'venueName',         v_venue_name,
           'startsAt',          b.starts_at,
           'endsAt',            b.ends_at,
           'releasedBookingId', v_booking.id,
           'releasedEventName', v_event.event_name
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_freed)
     and er.assigned_coordinator_id is not null
   order by b.id;

  -- 10. Every Venue Staff member, as 052 tells every Lead (D9).
  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_released',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_event_id,
           'eventName',      v_event.event_name,
           'venueId',        v_venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at,
           'releasedBy',     p_caller,
           'releasedByName', profile_display_name(p_caller),
           'reason',         v_booking.release_reason
         )
    from profiles p
   where p.role::text = 'venue_staff'
   order by p.id;

  return jsonb_build_object('outcome', 'released',
                            'booking', to_jsonb(v_booking),
                            'returned_to_pending', to_jsonb(v_freed));
end;
$$;
revoke execute on function release_venue_booking(uuid, uuid, text) from public, anon, authenticated;
