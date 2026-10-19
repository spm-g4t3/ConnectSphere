-- SCRUM-395: preview and atomically apply a significant event change.

alter table bookings
  add column if not exists flag_reason text;

update bookings
   set flag_reason = case
     when review_block_id is not null then 'venue_block'
     when review_reason in ('setup_or_turnaround_changed', 'venue_details_changed')
       then 'venue_edit'
     when review_reason = 'safety_review' then 'safety_review'
     else 'event_change'
   end
 where flag_reason is null
   and (status::text = 'flagged_for_review' or flagged_at is not null);

alter table bookings drop constraint if exists bookings_flag_reason_known;
alter table bookings
  add constraint bookings_flag_reason_known
  check (flag_reason in ('venue_block', 'venue_edit', 'safety_review', 'event_change'));

alter table bookings drop constraint if exists bookings_review_flag_paired;
alter table bookings
  add constraint bookings_review_flag_paired check (
    (flagged_at is null) = (
      review_block_id is null and review_reason is null and flag_reason is null
    )
  );
alter table bookings drop constraint if exists bookings_flag_reason_requires_block;
alter table bookings
  add constraint bookings_flag_reason_requires_block
  check (flag_reason <> 'venue_block' or review_block_id is not null);

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

drop trigger if exists bookings_set_flag_reason on bookings;
create trigger bookings_set_flag_reason
before insert or update of review_block_id, review_reason, flagged_at, flag_reason
on bookings
for each row execute function set_booking_flag_reason();

create table if not exists event_change_history (
  id               uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete restrict,
  changed_by       uuid not null references auth.users (id) on delete restrict,
  field_name       text not null,
  old_value        jsonb,
  new_value        jsonb,
  reason           text not null,
  changed_at       timestamptz not null default now(),
  constraint event_change_history_field_known check (
    field_name in (
      'proposedStart', 'proposedEnd', 'expectedAttendance',
      'venueRequirements', 'accessibilityRequirements', 'equipment'
    )
  ),
  constraint event_change_history_reason_nonblank check (
    reason = btrim(reason) and length(reason) between 1 and 4000
  )
);

create index if not exists idx_event_change_history_event
  on event_change_history (event_request_id, changed_at desc, id);

alter table event_change_history enable row level security;

create table if not exists safety_review_closures (
  id                          uuid primary key default gen_random_uuid(),
  event_request_id            uuid not null references event_requests (id) on delete restrict,
  safety_review_submission_id uuid not null references safety_review_submissions (id) on delete restrict,
  closed_by                   uuid not null references auth.users (id) on delete restrict,
  reason                      text not null,
  closed_at                   timestamptz not null default now(),
  constraint safety_review_closure_reason_nonblank check (
    reason = btrim(reason) and length(reason) between 1 and 4000
  ),
  constraint safety_review_closure_submission_once unique (safety_review_submission_id)
);

alter table safety_review_closures enable row level security;

-- The standard trigger yields to this transaction, which flags the same
-- reservations itself so a failed flag rolls the whole change back.
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

-- One calculation feeds preview and apply. The returned booking rows carry
-- venue-specific occupied periods so multi-venue arrangements are evaluated
-- independently using SCRUM-484's shared period function.
create or replace function significant_event_change_impact(
  p_event_request_id uuid,
  p_changes          jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public
as $impact$
declare
  v_event event_requests%rowtype;
  v_key text;
  v_start timestamptz;
  v_end timestamptz;
  v_attendance integer;
  v_venue_requirements text;
  v_accessibility_requirements text;
  v_start_changed boolean;
  v_end_changed boolean;
  v_attendance_changed boolean;
  v_venue_requirements_changed boolean;
  v_accessibility_requirements_changed boolean;
  v_equipment_change boolean;
  v_changed_fields jsonb;
  v_bookings jsonb;
  v_reservations jsonb;
  v_pending_requests jsonb;
  v_attendee_count integer;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Significant event changes must be an object'
      using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_changes)
  loop
    if v_key not in (
      'proposedStart', 'proposedEnd', 'expectedAttendance',
      'venueRequirements', 'accessibilityRequirements', 'equipmentChange'
    ) then
      raise exception 'Unsupported significant event field: %', v_key
        using errcode = '22023';
    end if;
  end loop;

  if p_changes = '{}'::jsonb then
    raise exception 'At least one significant event change is required'
      using errcode = '22023';
  end if;

  select * into v_event
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  if p_changes ? 'proposedStart' then
    if jsonb_typeof(p_changes -> 'proposedStart') <> 'string'
       or p_changes ->> 'proposedStart' !~ $timestamp$^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$$timestamp$ then
      raise exception 'proposedStart must be an ISO timestamp'
        using errcode = '22023';
    end if;
    begin
      v_start := (p_changes ->> 'proposedStart')::timestamptz;
    exception when others then
      raise exception 'proposedStart must be an ISO timestamp'
        using errcode = '22023';
    end;
  else
    v_start := v_event.proposed_start;
  end if;

  if p_changes ? 'proposedEnd' then
    if jsonb_typeof(p_changes -> 'proposedEnd') <> 'string'
       or p_changes ->> 'proposedEnd' !~ $timestamp$^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$$timestamp$ then
      raise exception 'proposedEnd must be an ISO timestamp'
        using errcode = '22023';
    end if;
    begin
      v_end := (p_changes ->> 'proposedEnd')::timestamptz;
    exception when others then
      raise exception 'proposedEnd must be an ISO timestamp'
        using errcode = '22023';
    end;
  else
    v_end := v_event.proposed_end;
  end if;

  if p_changes ? 'expectedAttendance' then
    if jsonb_typeof(p_changes -> 'expectedAttendance') <> 'number'
       or (p_changes ->> 'expectedAttendance')::numeric <= 0
       or (p_changes ->> 'expectedAttendance')::numeric > 2147483647
       or trunc((p_changes ->> 'expectedAttendance')::numeric)
            <> (p_changes ->> 'expectedAttendance')::numeric then
      raise exception 'expectedAttendance must be a positive whole number'
        using errcode = '22023';
    end if;
    v_attendance := (p_changes ->> 'expectedAttendance')::integer;
  else
    v_attendance := v_event.expected_attendance;
  end if;

  if p_changes ? 'venueRequirements' then
    if jsonb_typeof(p_changes -> 'venueRequirements') not in ('string', 'null') then
      raise exception 'venueRequirements must be text or null'
        using errcode = '22023';
    end if;
    v_venue_requirements := nullif(btrim(p_changes ->> 'venueRequirements'), '');
  else
    v_venue_requirements := v_event.venue_requirements;
  end if;

  if p_changes ? 'accessibilityRequirements' then
    if jsonb_typeof(p_changes -> 'accessibilityRequirements') not in ('string', 'null') then
      raise exception 'accessibilityRequirements must be text or null'
        using errcode = '22023';
    end if;
    v_accessibility_requirements := nullif(btrim(p_changes ->> 'accessibilityRequirements'), '');
  else
    v_accessibility_requirements := v_event.accessibility_requirements;
  end if;

  if p_changes ? 'equipmentChange' then
    if jsonb_typeof(p_changes -> 'equipmentChange') <> 'boolean' then
      raise exception 'equipmentChange must be true or false'
        using errcode = '22023';
    end if;
    v_equipment_change := (p_changes ->> 'equipmentChange')::boolean;
  else
    v_equipment_change := false;
  end if;

  if nullif(btrim(v_event.event_name), '') is null
     or nullif(btrim(v_event.purpose), '') is null
     or v_start is null or v_end is null or v_attendance is null or v_attendance <= 0 then
    raise exception 'The event does not meet SCRUM-10 submission requirements'
      using errcode = '22023';
  end if;
  if v_start <= now() then
    raise exception 'proposedStart must be in the future'
      using errcode = '22023';
  end if;
  if v_end <= v_start then
    raise exception 'proposedEnd must be later than proposedStart'
      using errcode = '22023';
  end if;

  v_start_changed := v_start is distinct from v_event.proposed_start;
  v_end_changed := v_end is distinct from v_event.proposed_end;
  v_attendance_changed := v_attendance is distinct from v_event.expected_attendance;
  v_venue_requirements_changed :=
    v_venue_requirements is distinct from v_event.venue_requirements;
  v_accessibility_requirements_changed :=
    v_accessibility_requirements is distinct from v_event.accessibility_requirements;

  if not (
    v_start_changed or v_end_changed or v_attendance_changed
    or v_venue_requirements_changed or v_accessibility_requirements_changed
    or v_equipment_change
  ) then
    raise exception 'The significant event change contains no changed values'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', b.id,
             'venueId', b.venue_id,
             'venueName', v.name,
             'venueLocation', v.location,
             'capacity', v.max_capacity,
             'startsAt', b.starts_at,
             'endsAt', b.ends_at,
             'occupiedStartsAt', lower(venue_occupied_period(
               v_start, v_end, v.setup_minutes, v.turnaround_minutes
             )),
             'occupiedEndsAt', upper(venue_occupied_period(
               v_start, v_end, v.setup_minutes, v.turnaround_minutes
             )),
             'alreadyFlagged', b.status::text = 'flagged_for_review'
           ) order by b.starts_at, b.id
         ), '[]'::jsonb)
    into v_bookings
    from bookings b
    join venues v on v.id = b.venue_id
   where b.event_request_id = p_event_request_id
     and b.status::text in ('approved', 'flagged_for_review')
     and (
       v_start_changed or v_end_changed
       or (v_attendance_changed and v_attendance > v.max_capacity)
       or v_venue_requirements_changed
       or v_accessibility_requirements_changed
     );

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', reservation.id,
             'equipmentName', equipment.name,
             'quantity', reservation.quantity,
             'startsAt', reservation.start_at,
             'endsAt', reservation.end_at
           ) order by reservation.start_at, reservation.id
         ), '[]'::jsonb)
    into v_reservations
    from equipment_reservations reservation
    join equipment_types equipment on equipment.id = reservation.equipment_type_id
   where reservation.event_request_id = p_event_request_id
     and (v_start_changed or v_end_changed)
     and reservation.released_at is null
     and not reservation.flagged;

  -- Open requests are listed, never flagged: only a confirmed booking blocks a
  -- venue, so Venue Staff are told and the coordinator decides what to do.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', b.id,
             'venueName', v.name,
             'startsAt', b.starts_at,
             'endsAt', b.ends_at
           ) order by b.starts_at, b.id
         ), '[]'::jsonb)
    into v_pending_requests
    from bookings b
    join venues v on v.id = b.venue_id
   where b.event_request_id = p_event_request_id
     and b.status::text in ('pending', 'conflicting')
     and (v_start_changed or v_end_changed);

  if v_start_changed or v_end_changed then
    select count(*)::integer
      into v_attendee_count
      from event_registrations registration
     where registration.event_request_id = p_event_request_id
       and registration.status = 'registered';
  else
    v_attendee_count := 0;
  end if;

  select coalesce(jsonb_agg(field), '[]'::jsonb)
    into v_changed_fields
    from (
      select field from (values
        ('proposedStart', v_start_changed),
        ('proposedEnd', v_end_changed),
        ('expectedAttendance', v_attendance_changed),
        ('venueRequirements', v_venue_requirements_changed),
        ('accessibilityRequirements', v_accessibility_requirements_changed),
        ('equipment', v_equipment_change)
      ) as changed(field, changed)
      where changed
    ) fields;

  return jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'eventName', v_event.event_name,
    'statusBefore', v_event.status::text,
    'statusAfter', case
      when v_event.status::text in ('confirmed', 'safety_review', 'safety_approved')
        then 'approved'
      else v_event.status::text
    end,
    'changedFields', v_changed_fields,
    'venueBookings', v_bookings,
    'equipmentReservations', v_reservations,
    'pendingBookingRequests', v_pending_requests,
    'registeredAttendeesToNotify', v_attendee_count,
    'equipmentChangeRecorded', v_equipment_change
  );
end;
$impact$;

create or replace function preview_significant_event_change(
  p_event_request_id uuid,
  p_changes          jsonb,
  p_user_id          uuid
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can preview this change'
      using errcode = '42501';
  end if;
  if v_event.status::text not in ('approved', 'confirmed', 'safety_review', 'safety_approved') then
    raise exception 'Event status % does not allow a significant change', v_event.status
      using errcode = 'PT409',
            hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;

  return significant_event_change_impact(p_event_request_id, p_changes);
end;
$$;

create or replace function apply_significant_event_change(
  p_event_request_id uuid,
  p_changes          jsonb,
  p_reason           text,
  p_user_id          uuid,
  p_expected_impact  jsonb default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_updated event_requests%rowtype;
  v_impact jsonb;
  v_booking_ids uuid[];
  v_reservation_ids uuid[];
  v_flagged_booking_ids uuid[];
  v_reservation_count integer;
  v_latest_submission_id uuid;
  v_previous_change_event_id text;
  v_reason text := nullif(btrim(p_reason), '');
begin
  -- 1. Lock the event before checking its owner, lifecycle or arrangements.
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  -- 2. Verify the caller and status under the lock.
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can apply this change'
      using errcode = '42501';
  end if;
  if v_event.status::text not in ('approved', 'confirmed', 'safety_review', 'safety_approved') then
    raise exception 'Event status % does not allow a significant change', v_event.status
      using errcode = 'PT409',
            hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;
  if v_reason is null or length(v_reason) > 4000 then
    raise exception 'A reason of 1 to 4,000 characters is required'
      using errcode = '22023';
  end if;

  -- Determine and lock the exact active arrangements before persisting fields.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;

  perform 1
    from bookings
   where id = any(v_booking_ids)
   order by id
   for update;
  perform 1
    from equipment_reservations
   where id = any(v_reservation_ids)
   order by id
   for update;

  -- Recalculate with the shared routine after acquiring arrangement locks.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;
  if p_expected_impact is not null and v_impact is distinct from p_expected_impact then
    raise exception 'The impact changed; refresh the preview before confirming'
      using errcode = 'PT409',
            hint = 'SIGNIFICANT_CHANGE_IMPACT_CHANGED';
  end if;

  -- 3. Save fields and one history row for each changed field.
  v_previous_change_event_id :=
    current_setting('connectsphere.significant_event_change_event_id', true);
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    p_event_request_id::text,
    true
  );
  update event_requests
     set proposed_start = case when p_changes ? 'proposedStart'
                               then (p_changes ->> 'proposedStart')::timestamptz
                               else proposed_start end,
         proposed_end = case when p_changes ? 'proposedEnd'
                             then (p_changes ->> 'proposedEnd')::timestamptz
                             else proposed_end end,
         expected_attendance = case when p_changes ? 'expectedAttendance'
                                    then (p_changes ->> 'expectedAttendance')::integer
                                    else expected_attendance end,
         venue_requirements = case when p_changes ? 'venueRequirements'
                                   then nullif(btrim(p_changes ->> 'venueRequirements'), '')
                                   else venue_requirements end,
         accessibility_requirements = case when p_changes ? 'accessibilityRequirements'
                                            then nullif(btrim(p_changes ->> 'accessibilityRequirements'), '')
                                            else accessibility_requirements end
   where id = p_event_request_id
   returning * into v_updated;
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    coalesce(v_previous_change_event_id, ''),
    true
  );

  insert into event_change_history (
    event_request_id, changed_by, field_name, old_value, new_value, reason
  )
  select p_event_request_id, p_user_id, field_name, old_value, new_value, v_reason
    from (
      select 'proposedStart'::text as field_name,
             to_jsonb(v_event.proposed_start) as old_value,
             to_jsonb(v_updated.proposed_start) as new_value
      union all
      select 'proposedEnd',
             to_jsonb(v_event.proposed_end),
             to_jsonb(v_updated.proposed_end)
      union all
      select 'expectedAttendance',
             to_jsonb(v_event.expected_attendance),
             to_jsonb(v_updated.expected_attendance)
      union all
      select 'venueRequirements',
             to_jsonb(v_event.venue_requirements),
             to_jsonb(v_updated.venue_requirements)
      union all
      select 'accessibilityRequirements',
             to_jsonb(v_event.accessibility_requirements),
             to_jsonb(v_updated.accessibility_requirements)
    ) changed_fields
   where old_value is distinct from new_value;

  if coalesce((v_impact ->> 'equipmentChangeRecorded')::boolean, false) then
    insert into event_change_history (
      event_request_id, changed_by, field_name, old_value, new_value, reason
    ) values (
      p_event_request_id, p_user_id, 'equipment',
      '{"changeRequested":false}'::jsonb,
      '{"changeRequested":true}'::jsonb,
      v_reason
    );
  end if;

  -- 4. Flag each affected venue booking. Existing flags stay under review;
  -- this event-change category is added without erasing the original cause.
  with flagged as (
    update bookings b
       set status = 'flagged_for_review',
           flag_reason = coalesce(b.flag_reason, 'event_change'),
           review_reason = coalesce(b.review_reason, 'event_changed'),
           flagged_at = coalesce(b.flagged_at, now()),
           flagged_by = coalesce(b.flagged_by, p_user_id)
     where b.id = any(v_booking_ids)
       and b.status::text in ('approved', 'flagged_for_review')
    returning b.id, b.venue_id, b.starts_at, b.ends_at
  )
  select coalesce(array_agg(flagged.id order by flagged.id), '{}')
    into v_flagged_booking_ids
    from flagged;

  if cardinality(v_flagged_booking_ids) <> cardinality(v_booking_ids) then
    raise exception 'A venue booking changed while applying the event change'
      using errcode = '40001';
  end if;

  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_flagged_event_change', flagged.id, p_event_request_id,
         jsonb_build_object(
           'eventName', v_updated.event_name,
           'venueName', venue.name,
           'startsAt', flagged.starts_at,
           'endsAt', flagged.ends_at,
           'reason', v_reason
         )
    from bookings flagged
    join venues venue on venue.id = flagged.venue_id
    cross join profiles staff
   where flagged.id = any(v_flagged_booking_ids)
     and staff.role = 'venue_staff';

  -- Pending requests keep their status; Venue Staff deciding them need the new time.
  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_request_event_change', (item ->> 'id')::uuid, p_event_request_id,
         jsonb_build_object(
           'eventRequestId', p_event_request_id,
           'eventName', v_updated.event_name,
           'venueName', item ->> 'venueName',
           'startsAt', item -> 'startsAt',
           'endsAt', item -> 'endsAt',
           'newStartsAt', v_updated.proposed_start,
           'newEndsAt', v_updated.proposed_end,
           'reason', v_reason
         )
    from jsonb_array_elements(v_impact -> 'pendingBookingRequests') item
    cross join profiles staff
   where staff.role = 'venue_staff';

  -- 5. N15 owns reservation history and equipment-request review state. 054's
  -- own reason, so 097 tells Technical Support and the coordinator once per move.
  v_reservation_count := flag_equipment_reservations(v_reservation_ids, 'The event date or time changed');
  if v_reservation_count <> cardinality(v_reservation_ids) then
    raise exception 'An equipment reservation changed while applying the event change'
      using errcode = '40001';
  end if;

  -- Close this pending submission explicitly; the immutable submission and
  -- safety-officer response history remain untouched.
  if v_event.status::text = 'safety_review' then
    select id into v_latest_submission_id
      from safety_review_submissions
     where event_request_id = p_event_request_id
     order by created_at desc, id desc
     limit 1;

    if v_latest_submission_id is null then
      raise exception 'The pending safety review has no submission to close'
        using errcode = '55000';
    end if;

    insert into safety_review_closures (
      event_request_id, safety_review_submission_id, closed_by, reason
    ) values (
      p_event_request_id, v_latest_submission_id, p_user_id, v_reason
    );
  end if;

  -- 6. Return Confirmed and safety-stage events to Approved through the
  -- existing transition/history function.
  if v_event.status::text in ('confirmed', 'safety_review', 'safety_approved') then
    v_updated := change_event_request_status(
      p_event_request_id,
      v_event.status,
      'approved',
      p_user_id,
      v_reason,
      p_user_id
    );
  end if;

  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_event.organiser_id,
    'event_significant_change',
    p_event_request_id,
    jsonb_build_object(
      'eventRequestId', p_event_request_id,
      'eventName', v_event.event_name,
      'reason', v_reason,
      'changedFields', v_impact -> 'changedFields',
      'statusBefore', v_impact ->> 'statusBefore',
      'statusAfter', v_impact ->> 'statusAfter'
    )
  );

  if coalesce((v_impact ->> 'registeredAttendeesToNotify')::integer, 0) > 0 then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select registration.attendee_id,
           'event_significant_change_attendee',
           p_event_request_id,
           jsonb_build_object(
             'eventRequestId', p_event_request_id,
             'eventName', v_event.event_name,
             'startsAt', v_updated.proposed_start,
             'endsAt', v_updated.proposed_end,
             'reason', v_reason
           )
      from event_registrations registration
     where registration.event_request_id = p_event_request_id
       and registration.status = 'registered';
  end if;

  return jsonb_build_object(
    'event', to_jsonb(v_updated),
    'impact', v_impact,
    'flaggedBookingIds', to_jsonb(v_flagged_booking_ids),
    'flaggedReservationCount', v_reservation_count
  );
end;
$$;

-- Allow a coordinator-initiated significant change to close the pending safety
-- submission without fabricating a Safety Officer response.
create or replace function enforce_event_safety_transitions()
returns trigger
language plpgsql
as $$
declare
  v_submission safety_review_submissions%rowtype;
  v_response_outcome text;
  v_response_created_at timestamptz;
  v_latest_approved timestamptz;
  v_latest_safety_review timestamptz;
  v_readiness jsonb;
  v_change_closure_exists boolean;
begin
  if tg_op = 'INSERT' then
    if new.status::text in ('safety_review', 'safety_approved', 'confirmed') then
      raise exception 'New events must enter through the normal planning lifecycle'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not event_request_status_allows(old.status, new.status) then
    raise exception 'Event % has status %, which cannot change to %',
      old.id, old.status, new.status
      using errcode = '55000';
  end if;

  if new.status::text = 'safety_review' then
    select * into v_submission
      from safety_review_submissions
     where event_request_id = old.id
     order by created_at desc, id desc
     limit 1;

    if not found then
      raise exception 'Submit the event through the safety review submission workflow'
        using errcode = '55000';
    end if;

    select max(created_at) into v_latest_approved
      from event_request_status_history
     where event_request_id = old.id
       and new_status::text = 'approved';

    if v_latest_approved is not null and v_submission.created_at < v_latest_approved then
      raise exception 'A new safety review submission is required after the event returns to Approved'
        using errcode = '55000';
    end if;

    perform 1 from bookings
     where event_request_id = old.id
       and status::text in ('pending', 'approved', 'flagged_for_review')
     order by id
       for share;
    perform 1 from equipment_requests
     where event_request_id = old.id
       and status::text <> 'cancelled'
     order by id
       for share;

    v_readiness := event_readiness(old.id, v_submission.no_equipment_confirmed);
    if not (v_readiness ->> 'ready')::boolean then
      raise exception 'This event is not ready for the safety check.'
        using errcode = 'PT409',
              hint = 'EVENT_NOT_READY',
              detail = (
                select coalesce(jsonb_agg(item), '[]'::jsonb)::text
                  from jsonb_array_elements(v_readiness -> 'items') item
                 where not (item ->> 'met')::boolean
              );
    end if;
  elsif old.status::text = 'safety_review'
        and new.status::text in ('safety_approved', 'approved') then
    select exists (
      select 1
        from safety_review_submissions submission
        join safety_review_closures closure
          on closure.safety_review_submission_id = submission.id
       where submission.event_request_id = old.id
         and submission.id = (
           select latest.id
             from safety_review_submissions latest
            where latest.event_request_id = old.id
            order by latest.created_at desc, latest.id desc
            limit 1
         )
         and new.status::text = 'approved'
    ) into v_change_closure_exists;

    if v_change_closure_exists then
      return new;
    end if;

    select outcome, created_at
      into v_response_outcome, v_response_created_at
      from safety_review_responses
     where event_request_id = old.id
     order by created_at desc, id desc
     limit 1;

    if not found then
      raise exception 'A Safety Officer response is required before leaving Safety review'
        using errcode = '55000';
    end if;

    select max(created_at) into v_latest_safety_review
      from event_request_status_history
     where event_request_id = old.id
       and new_status::text = 'safety_review';

    if v_latest_safety_review is not null and v_response_created_at < v_latest_safety_review then
      raise exception 'A new Safety Officer response is required for this review'
        using errcode = '55000';
    end if;

    if (new.status::text = 'safety_approved' and v_response_outcome <> 'approved')
       or (new.status::text = 'approved' and v_response_outcome not in ('changes_requested', 'rejected')) then
      raise exception 'The response outcome does not match the requested status'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

-- Keep every prior notification type while adding SCRUM-395's audiences.
do $$
declare
  v_def text;
  v_known text[] := '{}';
  v_ours text[] := array[
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change'
  ];
  v_item text;
begin
  select pg_get_constraintdef(c.oid)
    into v_def
    from pg_constraint c
   where c.conrelid = 'notifications'::regclass
     and c.conname = 'notifications_type_known';

  if v_def is not null then
    select coalesce(array_agg(t.m[1] order by t.ord), '{}')
      into v_known
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;

  foreach v_item in array v_ours loop
    if not v_item = any (v_known) then
      v_known := v_known || v_item;
    end if;
  end loop;

  alter table notifications drop constraint if exists notifications_type_known;
  execute format(
    'alter table notifications add constraint notifications_type_known check (type in (%s))',
    (select string_agg(quote_literal(item), ', ' order by ord)
       from unnest(v_known) with ordinality as types(item, ord))
  );
end;
$$;

revoke all on function significant_event_change_impact(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function preview_significant_event_change(uuid, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function apply_significant_event_change(uuid, jsonb, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function significant_event_change_impact(uuid, jsonb) to service_role;
grant execute on function preview_significant_event_change(uuid, jsonb, uuid) to service_role;
grant execute on function apply_significant_event_change(uuid, jsonb, text, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
