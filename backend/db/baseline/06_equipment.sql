-- Baseline 06: equipment types, requests, lines, reservations and their histories, with
-- the equipment functions and triggers, including three triggers on event_requests.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

create table equipment_types (
  id uuid not null default gen_random_uuid(),
  name text not null,
  description text,
  category text,
  location text,
  total_quantity integer not null default 0,
  damaged_quantity integer not null default 0,
  under_maintenance_quantity integer not null default 0,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_modified_by uuid,
  last_change_note text,
  constraint equipment_types_pkey primary key (id),
  constraint equipment_types_last_modified_by_fkey foreign key (last_modified_by) references auth.users(id),
  constraint equipment_types_damaged_not_negative check (damaged_quantity >= 0),
  constraint equipment_types_maintenance_not_negative check (under_maintenance_quantity >= 0),
  constraint equipment_types_name_not_blank check (length(trim(name)) > 0),
  constraint equipment_types_total_not_negative check (total_quantity >= 0),
  constraint equipment_types_unusable_within_total check ((damaged_quantity + under_maintenance_quantity) <= total_quantity)
);
-- The name is unique, ignoring capitalisation and surrounding spaces.
create unique index equipment_types_name_unique on equipment_types (lower(trim(both from name)));
alter table equipment_types enable row level security;

create trigger equipment_types_set_updated_at
  before update on equipment_types
  for each row
  execute function set_updated_at();

create table equipment_type_history (
  id bigint generated always as identity,
  equipment_type_id uuid not null,
  field_name text not null,
  old_value text,
  new_value text,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  constraint equipment_type_history_pkey primary key (id),
  constraint equipment_type_history_changed_by_fkey foreign key (changed_by) references auth.users(id),
  constraint equipment_type_history_equipment_type_id_fkey foreign key (equipment_type_id) references equipment_types(id) on delete restrict
);
create index equipment_type_history_type_idx on equipment_type_history (equipment_type_id, changed_at desc, id desc);
alter table equipment_type_history enable row level security;

-- An event's equipment request, reviewed by technical support staff.
create table equipment_requests (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  status equipment_request_status not null default 'pending_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewer_id uuid,
  review_started_at timestamptz,
  constraint equipment_requests_pkey primary key (id),
  constraint equipment_requests_event_request_id_fkey foreign key (event_request_id) references event_requests(id),
  constraint equipment_requests_reviewer_id_fkey foreign key (reviewer_id) references auth.users(id),
  constraint equipment_requests_reviewer_matches_status check (((status = 'under_review'::equipment_request_status) and (reviewer_id is not null) and (review_started_at is not null)) or ((status <> 'under_review'::equipment_request_status) and (reviewer_id is null) and (review_started_at is null)))
);
create index equipment_requests_event_idx on equipment_requests (event_request_id);
alter table equipment_requests enable row level security;

create trigger equipment_requests_set_updated_at
  before update on equipment_requests
  for each row
  execute function set_updated_at();

create table equipment_lines (
  id uuid not null default gen_random_uuid(),
  equipment_request_id uuid not null,
  equipment_type_id uuid not null,
  quantity integer not null,
  technical_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid,
  outcome text,
  outcome_note text,
  outcome_by uuid,
  outcome_at timestamptz,
  constraint equipment_lines_pkey primary key (id),
  constraint equipment_lines_equipment_request_id_fkey foreign key (equipment_request_id) references equipment_requests(id),
  constraint equipment_lines_equipment_type_id_fkey foreign key (equipment_type_id) references equipment_types(id),
  constraint equipment_lines_outcome_by_fkey foreign key (outcome_by) references auth.users(id),
  constraint equipment_lines_removed_by_fkey foreign key (removed_by) references auth.users(id),
  constraint equipment_lines_outcome_consistent check (((outcome is null) and (outcome_note is null) and (outcome_by is null) and (outcome_at is null)) or ((outcome = 'cannot_be_provided'::text) and (outcome_note is not null) and (length(btrim(outcome_note)) > 0) and (outcome_by is not null) and (outcome_at is not null))),
  constraint equipment_lines_quantity_positive check (quantity > 0),
  constraint equipment_lines_removed_consistent check ((removed_at is not null) or (removed_by is null))
);
-- One live line per equipment type in a request; a removed line keeps its row.
create unique index equipment_lines_one_per_type on equipment_lines (equipment_request_id, equipment_type_id) where (removed_at is null);
alter table equipment_lines enable row level security;

create trigger equipment_lines_set_updated_at
  before update on equipment_lines
  for each row
  execute function set_updated_at();

-- A reservation holds a quantity of one type for the event period; it is released, never deleted.
create table equipment_reservations (
  id uuid not null default gen_random_uuid(),
  equipment_type_id uuid not null,
  event_request_id uuid not null,
  equipment_line_id uuid not null,
  quantity integer not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  flagged boolean not null default false,
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  flag_reason text,
  flagged_at timestamptz,
  constraint equipment_reservations_pkey primary key (id),
  constraint equipment_reservations_equipment_line_id_fkey foreign key (equipment_line_id) references equipment_lines(id),
  constraint equipment_reservations_equipment_type_id_fkey foreign key (equipment_type_id) references equipment_types(id),
  constraint equipment_reservations_event_request_id_fkey foreign key (event_request_id) references event_requests(id),
  constraint equipment_reservations_released_by_fkey foreign key (released_by) references auth.users(id),
  constraint equipment_reservations_period_valid check (end_at > start_at),
  constraint equipment_reservations_quantity_positive check (quantity > 0),
  constraint equipment_reservations_release_consistent check ((released_at is not null) or ((released_by is null) and (release_reason is null)))
);
create index equipment_reservations_event_idx on equipment_reservations (event_request_id);
create index equipment_reservations_type_period_idx on equipment_reservations (equipment_type_id, start_at, end_at) where (released_at is null);
alter table equipment_reservations enable row level security;

create trigger equipment_reservations_set_updated_at
  before update on equipment_reservations
  for each row
  execute function set_updated_at();

create table equipment_review_history (
  id bigint generated always as identity,
  equipment_request_id uuid not null,
  equipment_line_id uuid,
  action text not null,
  user_id uuid,
  from_user_id uuid,
  note text,
  created_at timestamptz not null default now(),
  constraint equipment_review_history_pkey primary key (id),
  constraint equipment_review_history_equipment_line_id_fkey foreign key (equipment_line_id) references equipment_lines(id),
  constraint equipment_review_history_equipment_request_id_fkey foreign key (equipment_request_id) references equipment_requests(id),
  constraint equipment_review_history_from_user_id_fkey foreign key (from_user_id) references auth.users(id),
  constraint equipment_review_history_user_id_fkey foreign key (user_id) references auth.users(id),
  constraint equipment_review_history_action_known check (action = any (array['started'::text, 'taken_over'::text, 'line_marked'::text, 'line_unmarked'::text, 'completed'::text, 'arranged'::text, 'interrupted'::text, 'line_reset'::text]))
);
create index equipment_review_history_request_idx on equipment_review_history (equipment_request_id, created_at desc, id desc);
alter table equipment_review_history enable row level security;

-- Append-only log of what happened to each reservation.
create table equipment_reservation_events (
  id bigint generated always as identity,
  equipment_reservation_id uuid not null,
  event_request_id uuid not null,
  equipment_line_id uuid,
  action text not null,
  user_id uuid,
  reason text,
  quantity_before integer,
  quantity_after integer,
  start_before timestamptz,
  end_before timestamptz,
  start_after timestamptz,
  end_after timestamptz,
  created_at timestamptz not null default now(),
  constraint equipment_reservation_events_pkey primary key (id),
  constraint equipment_reservation_events_equipment_line_id_fkey foreign key (equipment_line_id) references equipment_lines(id),
  constraint equipment_reservation_events_equipment_reservation_id_fkey foreign key (equipment_reservation_id) references equipment_reservations(id),
  constraint equipment_reservation_events_event_request_id_fkey foreign key (event_request_id) references event_requests(id),
  constraint equipment_reservation_events_user_id_fkey foreign key (user_id) references auth.users(id),
  constraint equipment_reservation_events_action_known check (action = any (array['reserved'::text, 'increased'::text, 'reduced'::text, 'released'::text, 'moved'::text, 'flagged'::text, 'kept'::text]))
);
create index equipment_reservation_events_event_idx on equipment_reservation_events (event_request_id, id);
create index equipment_reservation_events_reservation_idx on equipment_reservation_events (equipment_reservation_id, id);
alter table equipment_reservation_events enable row level security;

-- Equipment types and availability.

create or replace function record_equipment_type_history()
returns trigger
language plpgsql
as $$
declare
  changed record;
begin
  if tg_op = 'INSERT' then
    insert into equipment_type_history (equipment_type_id, field_name, old_value, new_value, changed_by)
    values (new.id, 'created', null, new.name, new.last_modified_by);
    return new;
  end if;

  for changed in
    select field_name, old_value, new_value
    from (values
      ('name',                       old.name,                              new.name),
      ('description',                old.description,                       new.description),
      ('category',                   old.category,                          new.category),
      ('location',                   old.location,                          new.location),
      ('total_quantity',             old.total_quantity::text,              new.total_quantity::text),
      ('damaged_quantity',           old.damaged_quantity::text,            new.damaged_quantity::text),
      ('under_maintenance_quantity', old.under_maintenance_quantity::text,  new.under_maintenance_quantity::text),
      ('retired_at',                 old.retired_at::text,                  new.retired_at::text)
    ) as fields (field_name, old_value, new_value)
    where old_value is distinct from new_value
  loop
    insert into equipment_type_history
      (equipment_type_id, field_name, old_value, new_value, note, changed_by)
    values (
      new.id,
      changed.field_name,
      changed.old_value,
      changed.new_value,
      case
        when changed.field_name in ('damaged_quantity', 'under_maintenance_quantity')
          then new.last_change_note
      end,
      new.last_modified_by
    );
  end loop;

  return new;
end;
$$;

create trigger equipment_types_record_history
  after insert or update on equipment_types
  for each row
  execute function record_equipment_type_history();

create or replace function equipment_availability(
  p_equipment_type_id uuid,
  p_start_at          timestamptz,
  p_end_at            timestamptz,
  p_event_request_id  uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_type         equipment_types%rowtype;
  v_reserved     integer;
  v_reservations jsonb;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'The period must end after it starts'
      using errcode = '22023';
  end if;

  select * into v_type from equipment_types where id = p_equipment_type_id;

  if not found then
    return jsonb_build_object('found', false, 'retired', false);
  end if;

  if v_type.retired_at is not null then
    return jsonb_build_object('found', true, 'retired', true);
  end if;

  select
    coalesce(sum(r.quantity), 0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',               r.id,
          'event_request_id', r.event_request_id,
          'event_name',       e.event_name,
          'quantity',         r.quantity,
          'start_at',         r.start_at,
          'end_at',           r.end_at,
          'flagged',          r.flagged
        )
        order by r.start_at, r.id
      ),
      '[]'::jsonb
    )
  into v_reserved, v_reservations
  from equipment_reservations r
  join event_requests e on e.id = r.event_request_id
  where r.equipment_type_id = p_equipment_type_id
    and r.released_at is null
    and r.start_at < p_end_at
    and r.end_at > p_start_at
    and (p_event_request_id is null or r.event_request_id <> p_event_request_id);

  return jsonb_build_object(
    'found',             true,
    'retired',           false,
    'total',             v_type.total_quantity,
    'damaged',           v_type.damaged_quantity,
    'under_maintenance', v_type.under_maintenance_quantity,
    'reserved',          v_reserved,
    'available',         v_type.total_quantity
                           - v_type.damaged_quantity
                           - v_type.under_maintenance_quantity
                           - v_reserved,
    'reservations',      v_reservations
  );
end;
$$;

-- Shared sql helpers, checked when created, so each follows what it reads.

create or replace function equipment_request_status_words(p_status text)
returns text
language sql
immutable
as $$
  select case p_status
           when 'pending_review'           then 'Pending review'
           when 'under_review'             then 'Under review'
           when 'arranged'                 then 'Arranged'
           when 'cannot_be_fully_arranged' then 'Cannot be fully arranged'
           when 'cancelled'                then 'Cancelled'
           else p_status
         end;
$$;

create or replace function equipment_event_status_words(p_status text)
returns text
language sql
immutable
as $$
  select case p_status
           when 'draft'                 then 'a Draft'
           when 'submitted'             then 'Submitted'
           when 'under_review'          then 'Under review'
           when 'pending_clarification' then 'Pending clarification'
           when 'approved'              then 'Approved'
           when 'confirmed'             then 'Confirmed'
           when 'safety_review'         then 'in Safety review'
           when 'safety_approved'       then 'Safety approved'
           when 'rejected'              then 'Rejected'
           when 'cancelled'             then 'Cancelled'
           when 'completed'             then 'Completed'
           else p_status
         end;
$$;

create or replace function equipment_reservable_event_statuses()
returns text[]
language sql
immutable
as $$
  select array['approved', 'safety_review', 'safety_approved', 'confirmed']::text[];
$$;

create or replace function equipment_line_reserved(p_line_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(quantity), 0)::integer
    from equipment_reservations
   where equipment_line_id = p_line_id
     and released_at is null;
$$;

create or replace function equipment_notification_lines(
  p_equipment_request_id uuid,
  p_line_ids             uuid[] default null
)
returns jsonb
language sql
stable
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'equipmentType', t.name,
               'quantity',      l.quantity,
               'reserved',      equipment_line_reserved(l.id),
               'outcome',       l.outcome
             )
             order by t.name
           ),
           '[]'::jsonb
         )
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.equipment_request_id = p_equipment_request_id
     and ((p_line_ids is null and l.removed_at is null)
          or l.id = any (p_line_ids));
$$;

-- The coordinator's request lines.

create or replace function assert_equipment_editable(
  p_event_request_id uuid,
  p_coordinator_id   uuid
)
returns void
language plpgsql
as $$
declare
  v_assigned uuid;
  v_status   text;
begin
  select assigned_coordinator_id, status::text
    into v_assigned, v_status
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  -- A null caller is refused explicitly. `is distinct from` alone would find
  -- a null caller and an event with no coordinator not distinct, and let the
  -- caller through, as 018's header explains.
  if p_coordinator_id is null or v_assigned is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned coordinator can change its equipment'
      using errcode = '42501';
  end if;

  if v_status = 'approved' then
    return;
  end if;

  if v_status in ('confirmed', 'safety_review', 'safety_approved') then
    raise exception
      'Equipment on this event can only be changed as a significant change'
      using errcode = '55000';
  end if;

  raise exception
    'Equipment can only be changed while the event is Approved. This event is %.',
    case v_status
      when 'draft'                 then 'a Draft'
      when 'submitted'             then 'Submitted'
      when 'under_review'          then 'Under review'
      when 'pending_clarification' then 'Pending clarification'
      when 'rejected'              then 'Rejected'
      when 'cancelled'             then 'Cancelled'
      when 'completed'             then 'Completed'
      else v_status
    end
    using errcode = '55000';
end;
$$;

create or replace function add_equipment_line(
  p_event_request_id  uuid,
  p_coordinator_id    uuid,
  p_equipment_type_id uuid,
  p_quantity          integer,
  p_technical_notes   text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_type    equipment_types%rowtype;
  v_request equipment_requests%rowtype;
begin
  perform assert_equipment_editable(p_event_request_id, p_coordinator_id);

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  select * into v_type from equipment_types where id = p_equipment_type_id;

  if not found then
    raise exception 'That equipment type does not exist' using errcode = '22023';
  end if;

  if v_type.retired_at is not null then
    raise exception 'That equipment type is retired and cannot be chosen'
      using errcode = '22023';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
     and status <> 'cancelled'
   order by created_at desc, id desc
   limit 1
     for update;

  if not found then
    insert into equipment_requests (event_request_id)
    values (p_event_request_id)
    returning * into v_request;
  end if;

  if exists (
    select 1
      from equipment_lines
     where equipment_request_id = v_request.id
       and equipment_type_id = p_equipment_type_id
       and removed_at is null
  ) then
    raise exception 'That equipment type is already on this event'
      using errcode = '23505';
  end if;

  insert into equipment_lines (equipment_request_id, equipment_type_id, quantity, technical_notes)
  values (v_request.id, p_equipment_type_id, p_quantity, nullif(btrim(p_technical_notes), ''));

  update equipment_requests
     set status = 'pending_review'
   where id = v_request.id
     and status <> 'pending_review';

  return equipment_for_event(p_event_request_id);
end;
$$;

create or replace function amend_equipment_line(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_line_id          uuid,
  p_quantity         integer default null,
  p_technical_notes  text    default null,
  p_change_notes     boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_line      equipment_lines%rowtype;
  v_quantity  integer;
  v_notes     text;
begin
  perform assert_equipment_editable(p_event_request_id, p_coordinator_id);

  select l.* into v_line
    from equipment_lines l
    join equipment_requests r on r.id = l.equipment_request_id
   where l.id = p_line_id
     and r.event_request_id = p_event_request_id
     and r.status <> 'cancelled'
     and l.removed_at is null
     for update of l;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  if p_quantity is null and not p_change_notes then
    raise exception 'Nothing to change: give a quantity, technical notes, or both'
      using errcode = '22023';
  end if;

  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  v_quantity := coalesce(p_quantity, v_line.quantity);
  v_notes := case
               when p_change_notes then nullif(btrim(p_technical_notes), '')
               else v_line.technical_notes
             end;

  if v_quantity = v_line.quantity and v_notes is not distinct from v_line.technical_notes then
    return equipment_for_event(p_event_request_id);
  end if;

  update equipment_lines
     set quantity = v_quantity,
         technical_notes = v_notes
   where id = v_line.id;

  update equipment_reservations
     set flagged = true
   where equipment_line_id = v_line.id
     and released_at is null
     and flagged = false;

  update equipment_requests
     set status = 'pending_review'
   where id = v_line.equipment_request_id
     and status <> 'pending_review';

  return equipment_for_event(p_event_request_id);
end;
$$;

create or replace function remove_equipment_line(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_line_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_line   equipment_lines%rowtype;
  v_others integer;
  v_reason text;
begin
  perform assert_equipment_editable(p_event_request_id, p_coordinator_id);

  select l.* into v_line
    from equipment_lines l
    join equipment_requests r on r.id = l.equipment_request_id
   where l.id = p_line_id
     and r.event_request_id = p_event_request_id
     and r.status <> 'cancelled'
     and l.removed_at is null
     for update of l;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  select count(*) into v_others
    from equipment_lines
   where equipment_request_id = v_line.equipment_request_id
     and removed_at is null
     and id <> v_line.id;

  v_reason := case when v_others = 0 then 'request cancelled' else 'line removed' end;

  update equipment_lines
     set removed_at = now(),
         removed_by = p_coordinator_id
   where id = v_line.id;

  perform release_equipment_reservations(p_event_request_id, v_line.id, v_reason, null);

  update equipment_requests
     set status = case when v_others = 0 then 'cancelled'::equipment_request_status
                       else 'pending_review'::equipment_request_status end
   where id = v_line.equipment_request_id
     and status <> case when v_others = 0 then 'cancelled'::equipment_request_status
                        else 'pending_review'::equipment_request_status end;

  return equipment_for_event(p_event_request_id);
end;
$$;

-- Review by technical support staff.

create or replace function lock_equipment_request(p_event_request_id uuid)
returns equipment_requests
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  perform 1
     from event_requests
    where id = p_event_request_id
      for update;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
     and status <> 'cancelled'
   order by created_at desc, id desc
   limit 1
     for update;

  if not found then
    raise exception 'This event has no equipment request to review'
      using errcode = 'P0002';
  end if;

  return v_request;
end;
$$;

create or replace function assert_current_reviewer(
  p_request equipment_requests,
  p_user_id uuid
)
returns void
language plpgsql
as $$
begin
  if p_request.status <> 'under_review' then
    raise exception
      'This can only be done while the request is Under review. This request is %.',
      equipment_request_status_words(p_request.status::text)
      using errcode = '55000';
  end if;

  if p_user_id is null or p_request.reviewer_id is distinct from p_user_id then
    raise exception 'Only the current reviewer can do this'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function start_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'Only Technical Support Staff can review equipment requests'
      using errcode = '42501';
  end if;

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status = 'under_review' then
    raise exception
      'This equipment request is already Under review. Take over the review instead.'
      using errcode = '55000';
  end if;

  if v_request.status not in ('pending_review', 'cannot_be_fully_arranged') then
    raise exception
      'A review can only start when the request is Pending review or Cannot be fully arranged. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  update equipment_requests
     set status = 'under_review',
         reviewer_id = p_user_id,
         review_started_at = now()
   where id = v_request.id
     and status in ('pending_review', 'cannot_be_fully_arranged');

  if not found then
    raise exception 'The equipment request changed while the review was being started'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'started', p_user_id);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function take_over_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'Only Technical Support Staff can review equipment requests'
      using errcode = '42501';
  end if;

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status <> 'under_review' then
    raise exception
      'A review can only be taken over while the request is Under review. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  if v_request.reviewer_id = p_user_id then
    raise exception 'You are already reviewing this request'
      using errcode = '55000';
  end if;

  update equipment_requests
     set reviewer_id = p_user_id
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being taken over'
      using errcode = '40001';
  end if;

  insert into equipment_review_history
    (equipment_request_id, action, user_id, from_user_id)
  values (v_request.id, 'taken_over', p_user_id, v_request.reviewer_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function mark_equipment_line_unavailable(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid,
  p_note             text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_note    text := nullif(btrim(p_note), '');
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  if v_note is null then
    raise exception 'A note is required: say what is missing'
      using errcode = '22023';
  end if;

  if equipment_line_reserved(v_line.id) >= v_line.quantity then
    raise exception 'This line is already fully reserved, so it can be provided'
      using errcode = '55000';
  end if;

  update equipment_lines
     set outcome = 'cannot_be_provided',
         outcome_note = v_note,
         outcome_by = p_user_id,
         outcome_at = now()
   where id = v_line.id;

  insert into equipment_review_history
    (equipment_request_id, equipment_line_id, action, user_id, note)
  values (v_request.id, v_line.id, 'line_marked', p_user_id, v_note);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function clear_equipment_line_outcome(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_line    equipment_lines%rowtype;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  if v_line.outcome is null then
    return equipment_review_for_event(p_event_request_id);
  end if;

  update equipment_lines
     set outcome = null,
         outcome_note = null,
         outcome_by = null,
         outcome_at = null
   where id = v_line.id;

  insert into equipment_review_history
    (equipment_request_id, equipment_line_id, action, user_id)
  values (v_request.id, v_line.id, 'line_unmarked', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function complete_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_short   integer;
  v_missing text[];
  v_flagged integer;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select count(*) into v_flagged
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where l.equipment_request_id = v_request.id
     and r.released_at is null
     and r.flagged;

  if v_flagged > 0 then
    raise exception
      'Decide on each flagged reservation before completing the review. Still to decide: %.',
      v_flagged
      using errcode = '55000';
  end if;

  select count(*),
         coalesce(array_agg(t.name order by t.name) filter (where l.outcome is null), '{}')
    into v_short, v_missing
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.equipment_request_id = v_request.id
     and l.removed_at is null
     and equipment_line_reserved(l.id) < l.quantity;

  if v_short = 0 then
    raise exception
      'Every line is fully reserved, so there is nothing to complete. Reserve the last line to arrange the request.'
      using errcode = '55000';
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'Add a note to each line that cannot be provided. Missing a note: %',
      array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  update equipment_lines l
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where l.equipment_request_id = v_request.id
     and l.outcome is not null
     and (l.removed_at is not null or equipment_line_reserved(l.id) >= l.quantity);

  update equipment_requests
     set status = 'cannot_be_fully_arranged'
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being completed'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'completed', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function equipment_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_request equipment_requests%rowtype;
begin
  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id',         v_request.id,
      'status',     v_request.status,
      'created_at', v_request.created_at,
      'updated_at', v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'created_at',        l.created_at,
                   'updated_at',        l.updated_at
                 )
                 order by t.name, l.id
               )
          from equipment_lines l
          join equipment_types t on t.id = l.equipment_type_id
         where l.equipment_request_id = v_request.id
           and l.removed_at is null
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function equipment_review_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event   event_requests%rowtype;
  v_request equipment_requests%rowtype;
  v_has_period boolean;
begin
  select * into v_event from event_requests where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  -- Order is not checked here: event_requests already refuses an end that is not
  -- after the start (001, event_requests_dates_ordered).
  v_has_period := v_event.proposed_start is not null
              and v_event.proposed_end is not null;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id',                      v_event.id,
      'name',                    v_event.event_name,
      'proposed_start',          v_event.proposed_start,
      'proposed_end',            v_event.proposed_end,
      'assigned_coordinator_id', v_event.assigned_coordinator_id
    ),
    'request', jsonb_build_object(
      'id',                v_request.id,
      'status',            v_request.status,
      'reviewer_id',       v_request.reviewer_id,
      'review_started_at', v_request.review_started_at,
      'created_at',        v_request.created_at,
      'updated_at',        v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'outcome_by',        l.outcome_by,
                   'outcome_at',        l.outcome_at,
                   'reservations',      coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',          r.id,
                                'quantity',    r.quantity,
                                'start_at',    r.start_at,
                                'end_at',      r.end_at,
                                'flagged',     r.flagged,
                                'flag_reason', r.flag_reason,
                                'flagged_at',  r.flagged_at,
                                'can_keep',    r.flagged
                                               and equipment_reservation_keep_problem(r, v_event, l) is null
                              )
                              order by r.start_at, r.id
                            )
                       from equipment_reservations r
                      where r.equipment_line_id = l.id
                        and r.released_at is null
                   ), '[]'::jsonb),
                   'availability',      case when v_has_period then
                                          equipment_availability(
                                            l.equipment_type_id,
                                            v_event.proposed_start,
                                            v_event.proposed_end,
                                            v_event.id)
                                        end
                 )
                 order by t.name, l.id
               )
          from equipment_lines l
          join equipment_types t on t.id = l.equipment_type_id
         where l.equipment_request_id = v_request.id
           and l.removed_at is null
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function equipment_request_queue(
  p_caller       uuid,
  p_status       text    default null,
  p_include_past boolean default false,
  p_limit        integer default 200
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_status equipment_request_status;
  v_limit  integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  -- Statuses where the event, and so its equipment request, is still going ahead.
  -- Not equipment_reservable_event_statuses(): that is who may reserve, a separate rule.
  v_live_event_statuses constant text[] := array['approved', 'safety_review', 'safety_approved', 'confirmed'];
  v_result jsonb;
begin
  if p_caller is null
     or not exists (select 1 from profiles where id = p_caller and role::text = 'technical_support_staff') then
    raise exception 'Only technical support staff can see the equipment request queue'
      using errcode = '42501';
  end if;

  if p_status is not null then
    begin
      v_status := p_status::equipment_request_status;
    exception when invalid_text_representation then
      raise exception 'Unknown status %', p_status using errcode = '22023';
    end;
  end if;

  with picked as (
    select distinct on (r.event_request_id) r.*
      from equipment_requests r
      join event_requests e on e.id = r.event_request_id
     where p_include_past
        or e.proposed_end is null
        or e.proposed_end >= now()
        or e.status::text = any (v_live_event_statuses)
     order by r.event_request_id, (r.status = 'cancelled'), r.created_at desc, r.id desc
  ),
  base as (
    select p.id as request_id,
           p.event_request_id,
           p.status,
           e.proposed_start,
           e.status::text as event_status,
           not (e.proposed_end is null or e.proposed_end >= now()) as ended,
           exists (
             select 1
               from equipment_reservations res
               join equipment_lines l on l.id = res.equipment_line_id
              where l.equipment_request_id = p.id
                and res.released_at is null
                and res.flagged
           ) as has_flag
      from picked p
      join event_requests e on e.id = p.event_request_id
  ),
  needs_all as (
    select b.*
      from base b
     where (b.status = 'pending_review' or b.has_flag)
       and b.event_status = any (v_live_event_statuses)
  ),
  needs as (
    select n.*
      from needs_all n
     order by n.proposed_start asc nulls last, n.event_request_id
     limit v_limit
  ),
  reqs_all as (
    select b.*
      from base b
     where (p_include_past or not b.ended)
       and (v_status is null or b.status = v_status)
  ),
  reqs as (
    select r.*
      from reqs_all r
     order by r.proposed_start asc nulls last, r.event_request_id
     limit v_limit
  ),
  wanted as (
    select request_id from needs
    union
    select request_id from reqs
  ),
  queue_rows as (
    select
      p.id                                         as request_id,
      e.id                                         as event_request_id,
      e.event_name,
      e.proposed_start,
      e.proposed_end,
      venues.venues,
      e.assigned_coordinator_id                    as coordinator_id,
      coordinator.full_name                        as coordinator_name,
      coalesce((
        select sum(l.quantity)
          from equipment_lines l
         where l.equipment_request_id = p.id
           and l.removed_at is null
      ), 0)::int                                   as item_count,
      p.status::text                               as status,
      p.reviewer_id,
      reviewer.full_name                           as reviewer_name,
      coalesce(flagged.flagged_count, 0)::int      as flagged_count,
      coalesce(flagged.flag_reasons, '[]'::jsonb)  as flag_reasons
    from wanted w
    join equipment_requests p on p.id = w.request_id
    join event_requests e on e.id = p.event_request_id
    left join profiles coordinator on coordinator.id = e.assigned_coordinator_id
    left join profiles reviewer    on reviewer.id    = p.reviewer_id
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)
                                order by x.first_start, x.id), '[]'::jsonb) as venues
        from (
          select v.id, v.name, min(b.starts_at) as first_start
            from bookings b
            join venues v on v.id = b.venue_id
           where b.event_request_id = e.id
             and b.status::text in ('approved', 'flagged_for_review')
           group by v.id, v.name
        ) x
    ) venues on true
    left join lateral (
      select count(*)                                       as flagged_count,
             coalesce(jsonb_agg(distinct res.flag_reason)
                      filter (where res.flag_reason is not null), '[]'::jsonb)
                                                            as flag_reasons
        from equipment_reservations res
        join equipment_lines l on l.id = res.equipment_line_id
       where l.equipment_request_id = p.id
         and res.released_at is null
         and res.flagged
    ) flagged on true
  )
  select jsonb_build_object(
           'needs_action', coalesce((
             select jsonb_agg(to_jsonb(r) - 'request_id' order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where r.request_id in (select request_id from needs)
           ), '[]'::jsonb),
           'needs_action_total', (select count(*) from needs_all),
           'needs_action_truncated', (select count(*) from needs_all) > v_limit,
           'requests', coalesce((
             select jsonb_agg(to_jsonb(r) - 'request_id' order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where r.request_id in (select request_id from reqs)
           ), '[]'::jsonb),
           'requests_total', (select count(*) from reqs_all),
           'requests_truncated', (select count(*) from reqs_all) > v_limit
         )
    into v_result;

  return v_result;
end;
$$;
revoke execute on function equipment_request_queue(uuid, text, boolean, integer) from public, anon, authenticated;

create or replace function equipment_request_review_fields()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'under_review' then
    if old.status = 'under_review' and new.status in ('pending_review', 'cancelled') then
      insert into equipment_review_history
        (equipment_request_id, action, user_id, from_user_id, note)
      values (
        new.id, 'interrupted', null, old.reviewer_id,
        case new.status
          when 'cancelled' then 'The request was cancelled during the review'
          else coalesce(nullif(current_setting('equipment.interrupt_reason', true), ''),
                        'The lines were changed during the review')
        end
      );
    end if;
    new.reviewer_id := null;
    new.review_started_at := null;
  end if;
  return new;
end;
$$;

create trigger equipment_requests_review_fields
  before update on equipment_requests
  for each row
  execute function equipment_request_review_fields();

create or replace function equipment_line_reset_outcome()
returns trigger
language plpgsql
as $$
begin
  if old.outcome is not null
     and (new.quantity is distinct from old.quantity
          or new.technical_notes is distinct from old.technical_notes) then
    insert into equipment_review_history
      (equipment_request_id, equipment_line_id, action, user_id, from_user_id, note)
    values
      (old.equipment_request_id, old.id, 'line_reset', null, old.outcome_by,
       'The line was changed, so its outcome was cleared');
    new.outcome := null;
    new.outcome_note := null;
    new.outcome_by := null;
    new.outcome_at := null;
  end if;
  return new;
end;
$$;

create trigger equipment_lines_reset_outcome
  before update on equipment_lines
  for each row
  execute function equipment_line_reset_outcome();

-- Reservations.

create or replace function assert_event_allows_reservations(p_event_request_id uuid)
returns void
language plpgsql
as $$
declare
  v_status  text;
  v_labels  text[];
  v_allowed text;
begin
  select status::text into v_status
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  if not (v_status = any (equipment_reservable_event_statuses())) then
    -- 'safety_review' -> 'Safety review', in the list's order.
    select array_agg(upper(left(w, 1)) || substr(w, 2) order by n)
      into v_labels
      from (select replace(s, '_', ' ') as w, n
              from unnest(equipment_reservable_event_statuses()) with ordinality as t(s, n)) x;

    v_allowed := case
      when cardinality(v_labels) = 1 then v_labels[1]
      else array_to_string(v_labels[1:cardinality(v_labels) - 1], ', ') || ' or ' || v_labels[cardinality(v_labels)]
    end;

    raise exception
      'Equipment can only be reserved while the event is %. This event is %.',
      v_allowed, equipment_event_status_words(v_status)
      using errcode = '55000';
  end if;
end;
$$;

create or replace function lock_equipment_type_of_line(p_line_id uuid)
returns void
language plpgsql
as $$
declare
  v_type_id uuid;
begin
  select equipment_type_id into v_type_id from equipment_lines where id = p_line_id;
  if found then
    perform 1 from equipment_types where id = v_type_id for update;
  end if;
end;
$$;

create or replace function lock_equipment_type_of_reservation(p_reservation_id uuid)
returns void
language plpgsql
as $$
declare
  v_type_id uuid;
begin
  select equipment_type_id into v_type_id
    from equipment_reservations
   where id = p_reservation_id;
  if found then
    perform 1 from equipment_types where id = v_type_id for update;
  end if;
end;
$$;

create or replace function lock_equipment_reservation(
  p_request        equipment_requests,
  p_reservation_id uuid
)
returns equipment_reservations
language plpgsql
as $$
declare
  v_line_id uuid;
  v_res     equipment_reservations%rowtype;
begin
  select r.equipment_line_id
    into v_line_id
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where r.id = p_reservation_id
     and l.equipment_request_id = p_request.id;

  if not found then
    raise exception 'Reservation not found' using errcode = 'P0002';
  end if;

  perform 1 from equipment_lines where id = v_line_id for update;

  select * into v_res
    from equipment_reservations
   where id = p_reservation_id
     for update;

  if v_res.released_at is not null then
    raise exception 'This reservation has already been released'
      using errcode = '55000';
  end if;

  return v_res;
end;
$$;

create or replace function require_reservation_reason(p_reason text)
returns text
language plpgsql
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_reason is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;

create or replace function reserve_equipment(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid,
  p_quantity         integer
)
returns jsonb
language plpgsql
as $$
declare
  v_request      equipment_requests%rowtype;
  v_line         equipment_lines%rowtype;
  v_event        event_requests%rowtype;
  v_availability jsonb;
  v_unreserved   integer;
  v_available    integer;
  v_id           uuid;
  v_existing     equipment_reservations%rowtype;
begin
  perform lock_equipment_type_of_line(p_line_id);
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  select * into v_event from event_requests where id = p_event_request_id;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'This event has no start and end yet, so there is no period to reserve for'
      using errcode = '55000';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The quantity must be a whole number greater than zero'
      using errcode = '22023';
  end if;

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  v_unreserved := v_line.quantity - equipment_line_reserved(v_line.id);

  if p_quantity > v_unreserved then
    raise exception
      'Only % more can be reserved on this line (it needs % and % is already reserved)',
      greatest(v_unreserved, 0), v_line.quantity, equipment_line_reserved(v_line.id)
      using errcode = '22023';
  end if;

  v_availability := equipment_availability(
    v_line.equipment_type_id, v_event.proposed_start, v_event.proposed_end, null);

  if not coalesce((v_availability ->> 'found')::boolean, false) then
    raise exception 'Equipment type not found' using errcode = 'P0002';
  end if;

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    raise exception 'This equipment type has been retired and cannot be reserved'
      using errcode = '55000';
  end if;

  v_available := (v_availability ->> 'available')::integer;

  if p_quantity > greatest(v_available, 0) then
    raise exception
      'Only % available for this period, so % cannot be reserved',
      greatest(v_available, 0), p_quantity
      using errcode = '22023';
  end if;

  -- Reserving more of an item that already has a live reservation for this same
  -- period adds to that reservation instead of starting a second one, so the
  -- review shows one row per item. A flagged reservation is never topped up: it
  -- is waiting for a decision and its period may be the old one.
  select * into v_existing
    from equipment_reservations
   where equipment_line_id = v_line.id
     and released_at is null
     and not flagged
     and start_at = v_event.proposed_start
     and end_at   = v_event.proposed_end
   order by created_at, id
   limit 1
     for update;

  if found then
    update equipment_reservations
       set quantity = quantity + p_quantity
     where id = v_existing.id;

    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after,
       start_before, end_before, start_after, end_after)
    values
      (v_existing.id, p_event_request_id, v_line.id, 'increased', p_user_id,
       'Reserved more for the event', v_existing.quantity, v_existing.quantity + p_quantity,
       v_existing.start_at, v_existing.end_at, v_existing.start_at, v_existing.end_at);
  else
    insert into equipment_reservations
      (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
    values
      (v_line.equipment_type_id, p_event_request_id, v_line.id, p_quantity,
       v_event.proposed_start, v_event.proposed_end)
    returning id into v_id;

    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_after, start_after, end_after)
    values
      (v_id, p_event_request_id, v_line.id, 'reserved', p_user_id,
       'Reserved for the event', p_quantity, v_event.proposed_start, v_event.proposed_end);
  end if;

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function reduce_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_quantity         integer,
  p_reason           text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_event   event_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_res     equipment_reservations%rowtype;
  v_reason  text;
  v_before  integer;
begin
  perform lock_equipment_type_of_reservation(p_reservation_id);
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);
  v_reason := require_reservation_reason(p_reason);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);
  v_before := v_res.quantity;

  if p_quantity is null or p_quantity <= 0 or p_quantity >= v_res.quantity then
    raise exception
      'The new quantity must be a whole number above zero and below the % reserved. To give all of it back, release it.',
      v_res.quantity
      using errcode = '22023';
  end if;

  update equipment_reservations
     set quantity = p_quantity
   where id = v_res.id;

  v_res.quantity := p_quantity;

  if v_res.flagged then
    select * into v_event from event_requests where id = p_event_request_id;
    select * into v_line from equipment_lines where id = v_res.equipment_line_id;

    if equipment_reservation_keep_problem(v_res, v_event, v_line) is null then
      update equipment_reservations
         set flagged = false, flag_reason = null, flagged_at = null
       where id = v_res.id;
    end if;
  end if;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'reduced', p_user_id,
     v_reason, v_before, p_quantity, v_res.start_at, v_res.end_at, v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function move_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_request      equipment_requests%rowtype;
  v_event        event_requests%rowtype;
  v_line         equipment_lines%rowtype;
  v_res          equipment_reservations%rowtype;
  v_availability jsonb;
  v_available    integer;
  v_reason       text := coalesce(nullif(btrim(p_reason), ''),
                                  'Moved to the event''s current date and time');
begin
  perform lock_equipment_type_of_reservation(p_reservation_id);
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  if not v_res.flagged then
    raise exception 'Only a flagged reservation can be moved' using errcode = '55000';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  select * into v_line from equipment_lines where id = v_res.equipment_line_id;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'This event has no start and end yet, so there is no period to move to'
      using errcode = '55000';
  end if;

  if v_res.quantity > v_line.quantity then
    raise exception
      'This reservation holds % but the line now needs %. Reduce it first.',
      v_res.quantity, v_line.quantity
      using errcode = '22023';
  end if;

  if equipment_line_reserved(v_line.id) > v_line.quantity then
    raise exception
      'The reservations on this line hold % but the line now needs %. Reduce or release some first.',
      equipment_line_reserved(v_line.id), v_line.quantity
      using errcode = '22023';
  end if;

  v_availability := equipment_availability(
    v_res.equipment_type_id, v_event.proposed_start, v_event.proposed_end, null);

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    raise exception 'This equipment type has been retired and cannot be reserved'
      using errcode = '55000';
  end if;

  v_available := (v_availability ->> 'available')::integer;

  -- The reservation does not compete with itself.
  if exists (
    select 1
      from jsonb_array_elements(v_availability -> 'reservations') x
     where x ->> 'id' = v_res.id::text
  ) then
    v_available := v_available + v_res.quantity;
  end if;

  if v_res.quantity > greatest(v_available, 0) then
    raise exception
      'Only % available for the event''s current period, so % cannot be moved there',
      greatest(v_available, 0), v_res.quantity
      using errcode = '22023';
  end if;

  update equipment_reservations
     set start_at = v_event.proposed_start,
         end_at = v_event.proposed_end,
         flagged = false, flag_reason = null, flagged_at = null
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'moved', p_user_id,
     v_reason, v_res.quantity, v_res.quantity, v_res.start_at, v_res.end_at,
     v_event.proposed_start, v_event.proposed_end);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function keep_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_event   event_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_res     equipment_reservations%rowtype;
  v_problem text;
  v_reason  text := coalesce(nullif(btrim(p_reason), ''), 'Kept as it is');
begin
  perform lock_equipment_type_of_reservation(p_reservation_id);
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  if not v_res.flagged then
    raise exception 'Only a flagged reservation can be kept' using errcode = '55000';
  end if;

  select * into v_event from event_requests where id = p_event_request_id;
  select * into v_line from equipment_lines where id = v_res.equipment_line_id;

  v_problem := equipment_reservation_keep_problem(v_res, v_event, v_line);
  if v_problem is not null then
    raise exception 'This reservation cannot be kept. %', v_problem using errcode = '55000';
  end if;

  update equipment_reservations
     set flagged = false, flag_reason = null, flagged_at = null
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before, start_after, end_after)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'kept', p_user_id,
     v_reason, v_res.quantity, v_res.quantity, v_res.start_at, v_res.end_at,
     v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function release_equipment_reservation(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_reservation_id   uuid,
  p_reason           text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_res     equipment_reservations%rowtype;
  v_reason  text;
begin
  perform lock_equipment_type_of_reservation(p_reservation_id);
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);
  perform assert_event_allows_reservations(p_event_request_id);
  v_reason := require_reservation_reason(p_reason);

  v_res := lock_equipment_reservation(v_request, p_reservation_id);

  update equipment_reservations
     set released_at = now(),
         released_by = p_user_id,
         release_reason = v_reason
   where id = v_res.id;

  insert into equipment_reservation_events
    (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
     reason, quantity_before, quantity_after, start_before, end_before)
  values
    (v_res.id, p_event_request_id, v_res.equipment_line_id, 'released', p_user_id,
     v_reason, v_res.quantity, 0, v_res.start_at, v_res.end_at);

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;

create or replace function release_equipment_reservations(
  p_event_request_id uuid,
  p_line_id          uuid,
  p_reason           text,
  p_user_id          uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  with released as (
    update equipment_reservations
       set released_at = now(),
           released_by = p_user_id,
           release_reason = p_reason
     where event_request_id = p_event_request_id
       and (p_line_id is null or equipment_line_id = p_line_id)
       and released_at is null
    returning id, event_request_id, equipment_line_id, quantity, start_at, end_at
  ), written as (
    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after, start_before, end_before)
    select id, event_request_id, equipment_line_id, 'released', p_user_id,
           p_reason, quantity, 0, start_at, end_at
      from released
    returning 1
  )
  select count(*) into v_count from released;

  return v_count;
end;
$$;

create or replace function arrange_equipment_request_if_complete(
  p_equipment_request_id uuid,
  p_user_id              uuid
)
returns boolean
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_lines   integer;
  v_short   integer;
  v_flagged integer;
begin
  select * into v_request
    from equipment_requests
   where id = p_equipment_request_id
     for update;

  if not found or v_request.status <> 'under_review' then
    return false;
  end if;

  select count(*),
         count(*) filter (where equipment_line_reserved(l.id) < l.quantity)
    into v_lines, v_short
    from equipment_lines l
   where l.equipment_request_id = v_request.id
     and l.removed_at is null;

  if v_lines = 0 or v_short > 0 then
    return false;
  end if;

  select count(*) into v_flagged
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where l.equipment_request_id = v_request.id
     and r.released_at is null
     and r.flagged;

  if v_flagged > 0 then
    return false;
  end if;

  update equipment_lines
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where equipment_request_id = v_request.id
     and outcome is not null;

  update equipment_requests
     set status = 'arranged'
   where id = v_request.id
     and status = 'under_review';

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'arranged', p_user_id);

  return true;
end;
$$;

create or replace function flag_equipment_reservations(
  p_reservation_ids uuid[],
  p_reason          text
)
returns integer
language plpgsql
as $$
declare
  v_count  integer;
  v_events uuid[];
begin
  -- Id order, so two bulk flags that overlap cannot wait on each other.
  perform 1
     from equipment_reservations
    where id = any (p_reservation_ids)
      and released_at is null
      and not flagged
    order by id
      for update;

  with flagged as (
    update equipment_reservations
       set flagged = true,
           flag_reason = p_reason,
           flagged_at = now()
     where id = any (p_reservation_ids)
       and released_at is null
       and not flagged
    returning id, event_request_id, equipment_line_id, quantity, start_at, end_at
  ), written as (
    insert into equipment_reservation_events
      (equipment_reservation_id, event_request_id, equipment_line_id, action, user_id,
       reason, quantity_before, quantity_after, start_before, end_before,
       start_after, end_after)
    select id, event_request_id, equipment_line_id, 'flagged', null,
           p_reason, quantity, quantity, start_at, end_at, start_at, end_at
      from flagged
    returning 1
  )
  select count(*), array_agg(distinct event_request_id)
    into v_count, v_events
    from flagged;

  if v_count > 0 then
    perform 1
       from equipment_requests
      where event_request_id = any (v_events)
        and status not in ('pending_review', 'cancelled')
      order by id
        for update;

    -- Read by equipment_request_review_fields for the history note.
    perform set_config('equipment.interrupt_reason',
      'A reservation was flagged during the review. ' || p_reason || '.', true);

    update equipment_requests
       set status = 'pending_review'
     where event_request_id = any (v_events)
       and status not in ('pending_review', 'cancelled');

    perform set_config('equipment.interrupt_reason', '', true);
  end if;

  return v_count;
end;
$$;

create or replace function equipment_reservation_keep_problem(
  p_reservation equipment_reservations,
  p_event       event_requests,
  p_line        equipment_lines
)
returns text
language plpgsql
as $$
declare
  v_availability jsonb;
begin
  if p_reservation.start_at is distinct from p_event.proposed_start
     or p_reservation.end_at is distinct from p_event.proposed_end then
    return 'Its period no longer matches the event. Move it, reduce it or release it.';
  end if;

  if equipment_line_reserved(p_line.id) > p_line.quantity then
    return 'The reservations on this line hold more than the line now needs. Reduce or release some.';
  end if;

  v_availability := equipment_availability(
    p_reservation.equipment_type_id, p_reservation.start_at, p_reservation.end_at, null);

  if coalesce((v_availability ->> 'retired')::boolean, false) then
    return 'This equipment type has been retired. Release it.';
  end if;

  if (v_availability ->> 'available')::integer < 0 then
    return 'This equipment is over-committed for the period. Reduce it or release it.';
  end if;

  return null;
end;
$$;

create or replace function equipment_reservation_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'The reservation history cannot be changed or deleted'
    using errcode = '55000';
end;
$$;

create trigger equipment_reservation_events_no_change
  before delete or update on equipment_reservation_events
  for each row
  execute function equipment_reservation_events_append_only();

create or replace function equipment_reservations_no_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'A reservation cannot be deleted. Release it instead.'
    using errcode = '55000';
end;
$$;

create trigger equipment_reservations_never_deleted
  before delete on equipment_reservations
  for each row
  execute function equipment_reservations_no_delete();

-- Changes elsewhere flag reservations for review or release them; nothing is cancelled
-- automatically.

create or replace function equipment_flag_on_line_change()
returns trigger
language plpgsql
as $$
begin
  perform flag_equipment_reservations(
    array(
      select id
        from equipment_reservations
       where equipment_line_id = new.id
         and released_at is null
    ),
    'The line quantity or notes were changed'
  );
  return null;
end;
$$;

create trigger equipment_lines_flag_reservations_on_change
  after update of quantity, technical_notes on equipment_lines
  for each row
  when (((new.removed_at is null) and ((new.quantity is distinct from old.quantity) or (new.technical_notes is distinct from old.technical_notes))))
  execute function equipment_flag_on_line_change();

create or replace function equipment_flag_on_type_unusable()
returns trigger
language plpgsql
as $$
declare
  v_ids uuid[];
begin
  if new.retired_at is not null then
    select array_agg(id) into v_ids
      from equipment_reservations
     where equipment_type_id = new.id
       and released_at is null;

    perform flag_equipment_reservations(coalesce(v_ids, '{}'), 'The equipment type was retired');
    return null;
  end if;

  select array_agg(r.id) into v_ids
    from equipment_reservations r
   where r.equipment_type_id = new.id
     and r.released_at is null
     and (equipment_availability(new.id, r.start_at, r.end_at, null) ->> 'available')::integer < 0;

  perform flag_equipment_reservations(coalesce(v_ids, '{}'), 'Fewer units of this equipment are usable');
  return null;
end;
$$;

create trigger equipment_types_flag_reservations_on_unusable
  after update of total_quantity, damaged_quantity, under_maintenance_quantity, retired_at on equipment_types
  for each row
  when ((((new.retired_at is not null) and (old.retired_at is null)) or (((new.total_quantity - new.damaged_quantity) - new.under_maintenance_quantity) < ((old.total_quantity - old.damaged_quantity) - old.under_maintenance_quantity))))
  execute function equipment_flag_on_type_unusable();

create or replace function equipment_flag_on_event_period_change()
returns trigger
language plpgsql
as $$
begin
  if current_setting('connectsphere.significant_event_change_event_id', true)
       = new.id::text then
    return null;
  end if;

  perform flag_equipment_reservations(
    array(
      select id
        from equipment_reservations
       where event_request_id = new.id
         and released_at is null
         and (start_at is distinct from new.proposed_start
              or end_at is distinct from new.proposed_end)
    ),
    'The event date or time changed'
  );
  return null;
end;
$$;

create trigger event_requests_flag_equipment_on_period_change
  after update of proposed_start, proposed_end on event_requests
  for each row
  when (((new.proposed_start is distinct from old.proposed_start) or (new.proposed_end is distinct from old.proposed_end)))
  execute function equipment_flag_on_event_period_change();

create or replace function equipment_release_on_event_completed()
returns trigger
language plpgsql
as $$
begin
  perform release_equipment_reservations(new.id, null, 'event completed', null);
  return null;
end;
$$;

create trigger event_requests_release_equipment_on_completed
  after update of status on event_requests
  for each row
  when ((((new.status)::text = 'completed'::text) and ((old.status)::text is distinct from 'completed'::text)))
  execute function equipment_release_on_event_completed();

create or replace function equipment_release_on_request_cancelled()
returns trigger
language plpgsql
as $$
begin
  perform release_equipment_reservations(new.event_request_id, l.id, 'request cancelled', null)
     from equipment_lines l
    where l.equipment_request_id = new.id;
  return null;
end;
$$;

create trigger equipment_requests_release_on_cancelled
  after update of status on equipment_requests
  for each row
  when (((new.status = 'cancelled'::equipment_request_status) and (old.status <> 'cancelled'::equipment_request_status)))
  execute function equipment_release_on_request_cancelled();

-- Equipment notifications.

create or replace function notify_equipment_audiences(
  p_event_request_id uuid,
  p_type             text,
  p_technical_support boolean,
  p_coordinator      boolean,
  p_payload          jsonb,
  p_once             boolean default false
)
returns void
language plpgsql
as $$
declare
  v_name        text;
  v_coordinator uuid;
  v_base        jsonb;
begin
  select event_name, assigned_coordinator_id
    into v_name, v_coordinator
    from event_requests
   where id = p_event_request_id;

  if not found then
    return;
  end if;

  v_base := jsonb_build_object('eventRequestId', p_event_request_id, 'eventName', v_name)
            || coalesce(p_payload, '{}'::jsonb);

  if p_technical_support then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           p_type,
           p_event_request_id,
           v_base || jsonb_build_object('audience', 'technical_support_staff')
      from profiles p
     where p.role::text = 'technical_support_staff'
       and (not p_once
            or not exists (
                 select 1
                   from notifications n
                  where n.recipient_id = p.id
                    and n.type = p_type
                    and n.event_request_id = p_event_request_id
                    and n.created_at = now()
                    and n.payload = v_base || jsonb_build_object('audience', 'technical_support_staff')));
  end if;

  if p_coordinator and v_coordinator is not null then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select v_coordinator,
           p_type,
           p_event_request_id,
           v_base || jsonb_build_object('audience', 'event_coordinator')
     where not p_once
        or not exists (
             select 1
               from notifications n
              where n.recipient_id = v_coordinator
                and n.type = p_type
                and n.event_request_id = p_event_request_id
                and n.created_at = now()
                and n.payload = v_base || jsonb_build_object('audience', 'event_coordinator'));
  end if;
end;
$$;

create or replace function equipment_notify_line_added()
returns trigger
language plpgsql
as $$
declare
  v_event  uuid;
  v_others integer;
begin
  select event_request_id into v_event
    from equipment_requests
   where id = new.equipment_request_id;

  select count(*) into v_others
    from equipment_lines
   where equipment_request_id = new.equipment_request_id
     and removed_at is null
     and id <> new.id;

  perform notify_equipment_audiences(
    v_event,
    case when v_others = 0 then 'equipment_requested' else 'equipment_request_changed' end,
    true,
    false,
    jsonb_build_object('lines', equipment_notification_lines(new.equipment_request_id, array[new.id]))
      || case when v_others = 0 then '{}'::jsonb else jsonb_build_object('change', 'added') end
  );
  return null;
end;
$$;

create trigger equipment_lines_notify_added
  after insert on equipment_lines
  for each row
  execute function equipment_notify_line_added();

create or replace function equipment_notify_line_changed()
returns trigger
language plpgsql
as $$
declare
  v_event  uuid;
  v_others integer;
begin
  select event_request_id into v_event
    from equipment_requests
   where id = new.equipment_request_id;

  if new.removed_at is not null then
    select count(*) into v_others
      from equipment_lines
     where equipment_request_id = new.equipment_request_id
       and removed_at is null
       and id <> new.id;

    if v_others = 0 then
      perform notify_equipment_audiences(
        v_event, 'equipment_request_cancelled', true, false,
        jsonb_build_object(
          'lines', equipment_notification_lines(new.equipment_request_id, array[new.id]),
          'reason', 'The last line was removed'
        )
      );
    else
      perform notify_equipment_audiences(
        v_event, 'equipment_request_changed', true, false,
        jsonb_build_object(
          'change', 'removed',
          'lines', equipment_notification_lines(new.equipment_request_id, array[new.id])
        )
      );
    end if;
    return null;
  end if;

  perform notify_equipment_audiences(
    v_event, 'equipment_request_changed', true, false,
    jsonb_build_object(
      'change', 'amended',
      'previousQuantity', old.quantity,
      'notesChanged', new.technical_notes is distinct from old.technical_notes,
      'lines', equipment_notification_lines(new.equipment_request_id, array[new.id])
    )
  );
  return null;
end;
$$;

create trigger equipment_lines_notify_changed
  after update of quantity, technical_notes, removed_at on equipment_lines
  for each row
  when (((old.removed_at is null) and ((new.removed_at is not null) or (new.quantity is distinct from old.quantity) or (new.technical_notes is distinct from old.technical_notes))))
  execute function equipment_notify_line_changed();

create or replace function equipment_notify_request_outcome()
returns trigger
language plpgsql
as $$
begin
  perform notify_equipment_audiences(
    new.event_request_id,
    case new.status::text
      when 'arranged' then 'equipment_arranged'
      else 'equipment_not_fully_arranged'
    end,
    false,
    true,
    jsonb_build_object('lines', equipment_notification_lines(new.id))
  );
  return null;
end;
$$;

create trigger equipment_requests_notify_outcome
  after update of status on equipment_requests
  for each row
  when ((((new.status)::text = any (array['arranged'::text, 'cannot_be_fully_arranged'::text])) and (new.status is distinct from old.status)))
  execute function equipment_notify_request_outcome();

create or replace function equipment_notify_reservation_flagged()
returns trigger
language plpgsql
as $$
declare
  v_type text;
begin
  if new.reason in ('The line quantity or notes were changed', 'The event date or time changed') then
    return null;
  end if;

  select t.name into v_type
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.id = new.equipment_line_id;

  perform notify_equipment_audiences(
    new.event_request_id, 'equipment_flagged', false, true,
    jsonb_build_object('reason', new.reason, 'equipmentType', v_type),
    true
  );
  return null;
end;
$$;

create trigger equipment_reservation_events_notify_flagged
  after insert on equipment_reservation_events
  for each row
  when ((new.action = 'flagged'::text))
  execute function equipment_notify_reservation_flagged();

create or replace function equipment_notify_event_period_changed()
returns trigger
language plpgsql
as $$
begin
  if exists (
       select 1
         from equipment_requests r
        where r.event_request_id = new.id
          and r.status <> 'cancelled'
     ) then
    perform notify_equipment_audiences(
      new.id, 'equipment_request_changed', true, true,
      jsonb_build_object('change', 'event_period', 'startsAt', new.proposed_start, 'endsAt', new.proposed_end),
      true
    );
  end if;
  return null;
end;
$$;

create trigger event_requests_notify_equipment_period_changed
  after update of proposed_start, proposed_end on event_requests
  for each row
  when (((new.proposed_start is distinct from old.proposed_start) or (new.proposed_end is distinct from old.proposed_end)))
  execute function equipment_notify_event_period_changed();
