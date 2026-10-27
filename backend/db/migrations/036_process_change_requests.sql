-- Migration 036: the Event Coordinator processes the Organiser's change requests
-- (SCRUM-402). 035 added the cancellation value first; this file uses it only as
-- text.
--
-- 1. Request groups: one Organiser submission is one group of rows, one per field,
--    accepted or declined as a whole (D2). request_group_id is the first row's id.
-- 2. event_change_history links each row to the change request that caused it.
--    The source and the link default to two transaction settings 402 sets, so
--    395's insert is labelled without 395 being restated (D3).
-- 3. edit_event_request_details, restated from 022, its latest definition. The
--    only change: its history rows take their source from that setting, falling
--    back to direct_edit (D4). Restate it from 036 from now on.
-- 4. The mapping from a change field to 387's detail fields, and each field's class.
-- 5. create_change_request_group: the Organiser's submission, under the event lock.
-- 6. change_request_group_plan and preview_change_request: what accepting would do.
-- 7. process_change_request, restated in place from the baseline with a new
--    p_expected_impact (D1): it gates, routes by status (D5 to D7), records and
--    notifies in one transaction. Restate it from 036 from now on.
-- 8. Two notification types, added to whatever list is live rather than by
--    restating a fixed list: three open branches restate it whole, and whichever
--    ran last would drop the others' types.
--
-- Not restated: apply_significant_event_change, cancel_event_request and
-- reply_to_event_clarification_with_amendments. Decision values are never
-- compared against a fixed list: another branch adds one.
--
-- Re-runnable throughout.


-- ---------------------------------------------------------------------
-- 1. Request groups
-- ---------------------------------------------------------------------
alter table event_change_requests add column if not exists request_group_id uuid;
update event_change_requests set request_group_id = id where request_group_id is null;
alter table event_change_requests alter column request_group_id set not null;

-- A row inserted without a group, as every insert before 036 was, is its own.
create or replace function set_change_request_group()
returns trigger
language plpgsql
as $$
begin
  if new.request_group_id is null then
    new.request_group_id := new.id;
  end if;
  return new;
end;
$$;
revoke execute on function set_change_request_group() from public, anon, authenticated;

drop trigger if exists event_change_requests_set_group on event_change_requests;
create trigger event_change_requests_set_group
  before insert on event_change_requests
  for each row
  execute function set_change_request_group();

create index if not exists idx_event_change_requests_group on event_change_requests (request_group_id);


-- ---------------------------------------------------------------------
-- 2. event_change_history.change_request_id, and the defaults (D3)
-- ---------------------------------------------------------------------
alter table event_change_history add column if not exists change_request_id uuid;
alter table event_change_history drop constraint if exists event_change_history_change_request_id_fkey;
alter table event_change_history
  add constraint event_change_history_change_request_id_fkey
  foreign key (change_request_id) references event_change_requests(id) on delete restrict;

-- set_config(..., true) is transaction-local; outside 402's function both are
-- unset, so the defaults are what they were before (null, significant_change).
alter table event_change_history
  alter column change_request_id
  set default nullif(current_setting('connectsphere.change_request_id', true), '')::uuid;
alter table event_change_history
  alter column source
  set default coalesce(nullif(current_setting('connectsphere.change_history_source', true), ''), 'significant_change');

-- A change request's row always names it, and no other row names one.
alter table event_change_history drop constraint if exists event_change_history_change_request_link;
alter table event_change_history
  add constraint event_change_history_change_request_link
  check ((source = 'change_request') = (change_request_id is not null));


-- ---------------------------------------------------------------------
-- 3. edit_event_request_details (restated from 022; one change, D4)
-- ---------------------------------------------------------------------
create or replace function edit_event_request_details(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_changes          jsonb,
  p_expected         jsonb,
  p_reason           text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  c_columns constant jsonb := jsonb_build_object(
    'eventName', 'event_name',
    'purpose', 'purpose',
    'description', 'description',
    'proposedStart', 'proposed_start',
    'proposedEnd', 'proposed_end',
    'expectedAttendance', 'expected_attendance',
    'venueRequirements', 'venue_requirements',
    'accessibilityRequirements', 'accessibility_requirements',
    'equipmentRequirements', 'equipment_requirements'
  );
  c_significant constant text[] := array[
    'proposedStart', 'proposedEnd', 'expectedAttendance',
    'venueRequirements', 'accessibilityRequirements', 'equipmentRequirements'
  ];
  v_event    event_requests%rowtype;
  v_updated  event_requests%rowtype;
  v_stored   jsonb;
  v_reason   text := nullif(btrim(p_reason), '');
  v_field    text;
  v_stale    text[] := '{}';
  v_changed  text[] := '{}';
  v_significant boolean;
  v_new      jsonb := '{}'::jsonb;
  v_holds    jsonb;
  v_held     text[];
  v_start    timestamptz;
  v_end      timestamptz;
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  -- The caller before the status, so a stranger learns nothing about the event.
  -- `is distinct from` refuses a null caller rather than letting it through.
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can edit this event''s information'
      using errcode = '42501';
  end if;

  -- One reason per save, copied onto every history row (D5).
  if v_reason is null or length(v_reason) > 4000 then
    raise exception 'A reason of 1 to 4,000 characters is required'
      using errcode = '22023';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'Name at least one field to change'
      using errcode = '22023';
  end if;
  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    raise exception 'Send the value shown for each field being changed'
      using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(p_changes) loop
    if not c_columns ? v_field then
      raise exception 'Field % cannot be edited here', v_field
        using errcode = '22023';
    end if;
    if not p_expected ? v_field then
      raise exception 'Send the value shown for %', v_field
        using errcode = '22023';
    end if;
  end loop;

  -- The status matrix (D3, D9): any field in review, ordinary fields in planning,
  -- nothing once Confirmed, and nothing in any other status.
  if v_event.status::text = 'confirmed' then
    raise exception 'A confirmed event cannot be edited here. Change it through the significant change process, which returns it to Approved.'
      using errcode = 'PT409', hint = 'EVENT_CONFIRMED';
  end if;
  if v_event.status::text not in ('under_review', 'pending_clarification', 'approved', 'safety_review', 'safety_approved') then
    raise exception 'An event that is % cannot be edited', replace(v_event.status::text, '_', ' ')
      using errcode = 'PT409', hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;

  -- Compare-and-set (D12): every field must still hold what the form showed.
  v_stored := to_jsonb(v_event);
  for v_field in select jsonb_object_keys(p_changes) loop
    if event_detail_value(v_field, v_stored -> (c_columns ->> v_field))
       is distinct from event_detail_value(v_field, p_expected -> v_field) then
      v_stale := v_stale || v_field;
    end if;
  end loop;
  if cardinality(v_stale) > 0 then
    raise exception 'Changed since you opened the form: %. Reopen the event to see the current values.',
      array_to_string(v_stale, ', ')
      using errcode = 'PT409', hint = 'EVENT_CHANGED_SINCE_OPENED';
  end if;

  -- Only a field whose value actually changes counts, here and in the history.
  for v_field in select jsonb_object_keys(p_changes) order by 1 loop
    if event_detail_value(v_field, v_stored -> (c_columns ->> v_field))
       is distinct from event_detail_value(v_field, p_changes -> v_field) then
      v_changed := v_changed || v_field;
      v_new := v_new || jsonb_build_object(v_field, event_detail_value(v_field, p_changes -> v_field));
    end if;
  end loop;
  if cardinality(v_changed) = 0 then
    raise exception 'No changes: every value sent is the one already stored'
      using errcode = '22023';
  end if;
  if v_new ? 'eventName' and v_new ->> 'eventName' is null then
    raise exception 'eventName cannot be blank'
      using errcode = '22023';
  end if;

  -- `= any`, not the array `&&`: SCRUM-484's invariant reserves `&&` for the
  -- occupied-period rule.
  v_significant := exists (select 1 from unnest(v_changed) as f(name) where f.name = any (c_significant));

  if v_event.status::text in ('approved', 'safety_review', 'safety_approved') and v_significant then
    raise exception 'The date, time, attendance, requirements and equipment of an event in planning are changed through the significant change process, not edited here.'
      using errcode = 'PT409', hint = 'SIGNIFICANT_CHANGE_REQUIRED';
  end if;

  -- D4: a request reopened under SCRUM-355 keeps its arrangements, and a
  -- significant edit would leave them on the old details. "Still held" is what
  -- event_cancellation_impact_preview (013) counts.
  if v_significant then
    select jsonb_build_object(
      'venue bookings', (select count(*) from bookings b
                          where b.event_request_id = p_event_request_id
                            and b.status in ('approved', 'flagged_for_review')),
      'venue booking requests', (select count(*) from bookings b
                                  where b.event_request_id = p_event_request_id
                                    and b.status in ('pending', 'conflicting')),
      'venue holds', (select count(*) from venue_holds h
                       where h.event_request_id = p_event_request_id
                         and h.status = 'active'),
      'equipment requests', (select count(*) from equipment_requests r
                              where r.event_request_id = p_event_request_id
                                and r.status <> 'cancelled'),
      'equipment reservations', (select count(*) from equipment_reservations r
                                  where r.event_request_id = p_event_request_id
                                    and r.released_at is null)
    ) into v_holds;
    select coalesce(array_agg(format('%s %s', value, key) order by key), '{}')
      into v_held
      from jsonb_each_text(v_holds)
     where value::integer > 0;
    if cardinality(v_held) > 0 then
      raise exception 'This request still holds % from before it was rejected. Release or withdraw them before changing its date, time, attendance or requirements.',
        array_to_string(v_held, ', ')
        using errcode = 'PT409', hint = 'EVENT_HOLDS_ARRANGEMENTS';
    end if;
  end if;

  -- The period as it will be, against whichever end was not sent.
  v_start := case when v_new ? 'proposedStart' then (v_new ->> 'proposedStart')::timestamptz else v_event.proposed_start end;
  v_end   := case when v_new ? 'proposedEnd' then (v_new ->> 'proposedEnd')::timestamptz else v_event.proposed_end end;
  if v_start is not null and v_end is not null and v_end <= v_start then
    raise exception 'proposedEnd must be later than the proposed start'
      using errcode = '22023';
  end if;

  update event_requests
     set event_name = case when v_new ? 'eventName' then v_new ->> 'eventName' else event_name end,
         purpose = case when v_new ? 'purpose' then v_new ->> 'purpose' else purpose end,
         description = case when v_new ? 'description' then v_new ->> 'description' else description end,
         proposed_start = case when v_new ? 'proposedStart' then (v_new ->> 'proposedStart')::timestamptz else proposed_start end,
         proposed_end = case when v_new ? 'proposedEnd' then (v_new ->> 'proposedEnd')::timestamptz else proposed_end end,
         expected_attendance = case when v_new ? 'expectedAttendance' then (v_new ->> 'expectedAttendance')::integer else expected_attendance end,
         venue_requirements = case when v_new ? 'venueRequirements' then v_new ->> 'venueRequirements' else venue_requirements end,
         accessibility_requirements = case when v_new ? 'accessibilityRequirements' then v_new ->> 'accessibilityRequirements' else accessibility_requirements end,
         equipment_requirements = case when v_new ? 'equipmentRequirements' then v_new ->> 'equipmentRequirements' else equipment_requirements end
   where id = p_event_request_id
   returning * into v_updated;

  -- One row per changed field, typed as 395 writes them (to_jsonb of the column).
  insert into event_change_history (
    event_request_id, changed_by, field_name, old_value, new_value, reason, source
  )
  select p_event_request_id, p_user_id, field,
         nullif(v_stored -> (c_columns ->> field), 'null'::jsonb),
         nullif(to_jsonb(v_updated) -> (c_columns ->> field), 'null'::jsonb),
         v_reason, coalesce(nullif(current_setting('connectsphere.change_history_source', true), ''), 'direct_edit')
    from unnest(v_changed) as field;

  -- One notice per save (D8). Safety Officers are not told (D10).
  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_event.organiser_id,
    'event_details_changed',
    p_event_request_id,
    jsonb_build_object(
      'eventRequestId', p_event_request_id,
      'eventName', v_updated.event_name,
      'reason', v_reason,
      'changedFields', to_jsonb(v_changed),
      'status', v_updated.status
    )
  );

  return jsonb_build_object('event', to_jsonb(v_updated), 'changedFields', to_jsonb(v_changed));
end;
$$;
revoke execute on function edit_event_request_details(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. A change field's target and class
-- ---------------------------------------------------------------------
-- The detail field and column each change field writes; other and cancellation
-- write none. Mirrored by DETAIL_FIELD_BY_CHANGE_FIELD in
-- backend/src/domain/eventChangeField.js, and a test reads this list. A venue
-- request is a change to the venue requirements (D6).
create or replace function change_request_targets()
returns table (change_field text, detail_field text, column_name text)
language sql
immutable
set search_path = public
as $$
  select * from (values
    ('event_name', 'eventName', 'event_name'),
    ('description', 'description', 'description'),
    ('purpose', 'purpose', 'purpose'),
    ('proposed_start', 'proposedStart', 'proposed_start'),
    ('proposed_end', 'proposedEnd', 'proposed_end'),
    ('expected_attendance', 'expectedAttendance', 'expected_attendance'),
    ('venue', 'venueRequirements', 'venue_requirements'),
    ('equipment', 'equipmentRequirements', 'equipment_requirements')
  ) as t (change_field, detail_field, column_name);
$$;
revoke execute on function change_request_targets() from public, anon, authenticated;

-- ordinary: 387 applies it in any editable status. significant: 395 in planning.
create or replace function change_request_field_class(p_change_field text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_change_field in ('event_name', 'description', 'purpose') then 'ordinary'
    when p_change_field in ('proposed_start', 'proposed_end', 'expected_attendance', 'venue') then 'significant'
    when p_change_field = 'equipment' then 'equipment'
    when p_change_field = 'cancellation' then 'cancellation'
    else 'other'
  end;
$$;
revoke execute on function change_request_field_class(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. create_change_request_group
-- ---------------------------------------------------------------------
-- p_changes: [{ changeField, requestedChange }, ...]. SCRUM-11's status rule is
-- kept as it was: any event but a draft.
create or replace function create_change_request_group(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_changes          jsonb
)
returns setof event_change_requests
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests;
  v_item jsonb;
  v_field text;
  v_group uuid;
  v_row event_change_requests;
  v_fields text[] := '{}';
  v_significant text[] := '{}';
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_organiser_id is null or v_event.organiser_id is distinct from p_organiser_id then
    raise exception 'Only the event organiser may request a change to this event'
      using errcode = '22023';
  end if;
  if v_event.status = 'draft' then
    raise exception 'Cannot request a change to a draft event; submit it first'
      using errcode = '22023';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 9 then
    raise exception 'A change request names 1 to 9 changes'
      using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_changes) loop
    v_field := v_item ->> 'changeField';
    if v_field is null or not (v_field = any (enum_range(null::event_change_field)::text[])) then
      raise exception 'Unknown change field: %', coalesce(v_field, 'none')
        using errcode = '22023';
    end if;
    if v_field = any (v_fields) then
      raise exception 'Each field can be changed once per request: %', v_field
        using errcode = '22023';
    end if;
    if nullif(btrim(v_item ->> 'requestedChange'), '') is null then
      raise exception 'requestedChange cannot be blank for %', v_field
        using errcode = '22023';
    end if;
    v_fields := v_fields || v_field;
  end loop;
  -- D8: what accepting a cancellation together with a field change means is undefined.
  if 'cancellation' = any (v_fields) and cardinality(v_fields) > 1 then
    raise exception 'A cancellation request cannot be combined with other changes'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_changes) loop
    insert into event_change_requests
      (event_request_id, requested_by, change_field, requested_change, request_group_id)
    values (
      p_event_request_id, p_organiser_id,
      (v_item ->> 'changeField')::event_change_field,
      btrim(v_item ->> 'requestedChange'),
      v_group
    )
    returning * into v_row;
    v_group := coalesce(v_group, v_row.request_group_id);
    if change_request_field_class(v_row.change_field::text) in ('significant', 'equipment') then
      v_significant := v_significant || v_row.change_field::text;
    end if;
    return next v_row;
  end loop;

  -- AC12 (W1 §6): the holder hears of a significant change; with nobody assigned
  -- the Lead's queue already shows the request.
  if cardinality(v_significant) > 0 and v_event.assigned_coordinator_id is not null then
    insert into notifications (recipient_id, type, event_request_id, payload)
    values (
      v_event.assigned_coordinator_id,
      'change_request_significant_submitted',
      p_event_request_id,
      jsonb_build_object(
        'eventRequestId', p_event_request_id,
        'eventName', v_event.event_name,
        'changeRequestId', v_group,
        'changeFields', to_jsonb(v_fields)
      )
    );
  end if;
  return;
end;
$$;
revoke execute on function create_change_request_group(uuid, uuid, jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. What accepting a group would do
-- ---------------------------------------------------------------------
-- Each row's text converted to the value 387 or 395 takes, and SCRUM-10's rules on
-- the period it would leave. A value equal to the stored one is not a change.
-- Returns { rows, faults, ordinary, significant, equipmentChange, cancellation }.
create or replace function change_request_group_plan(p_group_id uuid, p_event event_requests)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_row event_change_requests;
  v_stored jsonb := to_jsonb(p_event);
  v_in_review boolean := p_event.status::text in ('under_review', 'pending_clarification');
  v_rows jsonb := '[]'::jsonb;
  v_faults jsonb := '[]'::jsonb;
  v_ordinary jsonb := '{}'::jsonb;
  v_significant jsonb := '{}'::jsonb;
  v_equipment boolean := false;
  v_cancellation text;
  v_class text;
  v_field text;
  v_column text;
  v_text text;
  v_value jsonb;
  v_current jsonb;
  v_changed boolean;
  v_start timestamptz;
  v_end timestamptz;
begin
  for v_row in
    select * from event_change_requests
     where request_group_id = p_group_id
     -- One submission shares created_at; then the form's order, the enum's.
     order by created_at, change_field, id
  loop
    v_class := change_request_field_class(v_row.change_field::text);
    select t.detail_field, t.column_name into v_field, v_column
      from change_request_targets() t where t.change_field = v_row.change_field::text;
    v_text := btrim(v_row.requested_change);
    v_value := null;
    v_changed := false;

    if v_field in ('proposedStart', 'proposedEnd') then
      begin
        v_value := to_jsonb(v_text::timestamptz);
      exception when others then
        v_faults := v_faults || jsonb_build_object('field', v_field, 'message', 'must be a valid date and time');
      end;
    elsif v_field = 'expectedAttendance' then
      if v_text ~ '^[0-9]{1,9}$' and v_text::integer > 0 then
        v_value := to_jsonb(v_text::integer);
      else
        v_faults := v_faults || jsonb_build_object('field', v_field, 'message', 'must be a positive whole number');
      end if;
    elsif v_field is not null then
      v_value := to_jsonb(v_text);
    end if;

    v_current := case when v_column is null then null else v_stored -> v_column end;
    if v_value is not null then
      v_changed := event_detail_value(v_field, v_current) is distinct from event_detail_value(v_field, v_value);
    end if;

    if v_class = 'ordinary' and v_changed then
      v_ordinary := v_ordinary || jsonb_build_object(v_field, v_value);
    elsif v_class = 'significant' and v_changed then
      v_significant := v_significant || jsonb_build_object(v_field, v_value);
    elsif v_class = 'equipment' and v_in_review and v_changed then
      -- In review 387 takes any field, so the text goes to the requirements (D6).
      v_significant := v_significant || jsonb_build_object(v_field, v_value);
    elsif v_class = 'equipment' and not v_in_review then
      -- In planning the lines are edited; 395 records that a change was asked for.
      v_equipment := true;
      v_changed := true;
    elsif v_class = 'cancellation' then
      v_cancellation := v_text;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'id', v_row.id,
      'changeField', v_row.change_field,
      'class', v_class,
      'field', v_field,
      'currentValue', v_current,
      'requestedValue', coalesce(v_value, to_jsonb(v_text)),
      'changed', v_changed
    );
  end loop;

  -- SCRUM-10's rules on the period the accept would leave.
  if v_significant ? 'proposedStart' or v_significant ? 'proposedEnd' then
    v_start := coalesce((v_significant ->> 'proposedStart')::timestamptz, p_event.proposed_start);
    v_end := coalesce((v_significant ->> 'proposedEnd')::timestamptz, p_event.proposed_end);
    if v_significant ? 'proposedStart' and v_start <= now() then
      v_faults := v_faults || jsonb_build_object('field', 'proposedStart', 'message', 'must be in the future');
    end if;
    if v_start is not null and v_end is not null and v_end <= v_start then
      v_faults := v_faults || jsonb_build_object('field', 'proposedEnd', 'message', 'must be later than the proposed start');
    end if;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'faults', v_faults,
    'ordinary', v_ordinary,
    'significant', v_significant,
    'equipmentChange', v_equipment,
    'cancellation', v_cancellation
  );
end;
$$;
revoke execute on function change_request_group_plan(uuid, event_requests) from public, anon, authenticated;

-- The caller, the status and the group, under the event lock; shared by the
-- preview and the decision so they refuse alike. Returns the group id.
create or replace function change_request_gate(
  p_change_request_id uuid,
  p_user_id           uuid,
  out event_row       event_requests,
  out group_id        uuid
)
language plpgsql
set search_path = public
as $$
begin
  select er.* into event_row
    from event_change_requests cr
    join event_requests er on er.id = cr.event_request_id
   where cr.id = p_change_request_id
     for update of er;
  if not found then
    raise exception 'change request % not found', p_change_request_id
      using errcode = 'P0002';
  end if;

  -- The caller before the status, so a stranger learns nothing (387's D15). The
  -- holder, as before 036; 387 and 395 check the role again on every path that
  -- applies a field.
  if p_user_id is null or event_row.assigned_coordinator_id is distinct from p_user_id then
    raise exception 'only the coordinator assigned to event request % can decide its change requests', event_row.id
      using errcode = '42501';
  end if;

  if event_row.status = 'submitted' then
    raise exception 'Start the review of this event before processing its change requests'
      using errcode = 'PT409', hint = 'REVIEW_NOT_STARTED';
  end if;
  if event_row.status::text not in (
    'under_review', 'pending_clarification', 'approved', 'safety_review', 'safety_approved', 'confirmed'
  ) then
    raise exception 'Change requests for an event that is % cannot be processed', replace(event_row.status::text, '_', ' ')
      using errcode = 'PT409', hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;

  select cr.request_group_id into group_id from event_change_requests cr where cr.id = p_change_request_id;
  perform 1 from event_change_requests where request_group_id = group_id order by id for update;
  if exists (select 1 from event_change_requests where request_group_id = group_id and status = 'processed') then
    raise exception 'change request % has already been processed', p_change_request_id
      using errcode = 'PT409', hint = 'CHANGE_REQUEST_ALREADY_PROCESSED';
  end if;
end;
$$;
revoke execute on function change_request_gate(uuid, uuid) from public, anon, authenticated;

-- AC4: the classes, the current and requested values, the faults, whether the
-- event would return to Approved, and 395's impact for a significant part. Changes
-- nothing.
create or replace function preview_change_request(p_change_request_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_gate record;
  v_event event_requests;
  v_plan jsonb;
  v_significant jsonb;
  v_planning boolean;
  v_reverts boolean;
  v_impact jsonb;
begin
  select * into v_gate from change_request_gate(p_change_request_id, p_user_id);
  v_event := v_gate.event_row;
  v_plan := change_request_group_plan(v_gate.group_id, v_event);
  v_planning := v_event.status::text in ('approved', 'safety_review', 'safety_approved', 'confirmed');
  v_significant := case when v_planning
    then (v_plan -> 'significant')
         || case when (v_plan ->> 'equipmentChange')::boolean then '{"equipmentChange": true}'::jsonb else '{}'::jsonb end
    else '{}'::jsonb end;

  v_reverts := v_plan ->> 'cancellation' is null and (
    (v_event.status::text in ('safety_review', 'safety_approved') and v_significant <> '{}'::jsonb)
    or (v_event.status = 'confirmed'
        and (v_significant <> '{}'::jsonb or v_plan -> 'ordinary' <> '{}'::jsonb))
  );
  if v_significant <> '{}'::jsonb and jsonb_array_length(v_plan -> 'faults') = 0 then
    v_impact := significant_event_change_impact(v_event.id, v_significant);
  end if;

  return jsonb_build_object(
    'changeRequestId', v_gate.group_id,
    'eventRequestId', v_event.id,
    'status', v_event.status,
    'rows', v_plan -> 'rows',
    'invalid', v_plan -> 'faults',
    'revertsEvent', v_reverts,
    'impact', v_impact
  );
end;
$$;
revoke execute on function preview_change_request(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. process_change_request (restated in place, D1)
-- ---------------------------------------------------------------------
drop function if exists process_change_request(uuid, change_request_decision, text, uuid);

create or replace function process_change_request(
  p_change_request_id uuid,
  p_decision          change_request_decision,
  p_decision_notes    text default null,
  p_processed_by      uuid default null,
  p_expected_impact   jsonb default null
)
returns event_change_requests
language plpgsql
set search_path = public
as $$
declare
  v_gate record;
  v_event event_requests;
  v_group uuid;
  v_notes text := nullif(btrim(p_decision_notes), '');
  v_plan jsonb;
  v_reason text;
  v_ordinary jsonb;
  v_significant jsonb;
  v_stored jsonb;
  v_fields jsonb;
  v_result event_change_requests;
begin
  select * into v_gate from change_request_gate(p_change_request_id, p_processed_by);
  v_event := v_gate.event_row;
  v_group := v_gate.group_id;
  v_stored := to_jsonb(v_event);

  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'The note must be 2,000 characters or fewer'
      using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(change_field order by created_at, change_field, id), '[]'::jsonb) into v_fields
    from event_change_requests where request_group_id = v_group;

  if p_decision::text = 'rejected' then
    if v_notes is null then
      raise exception 'A reason is required to decline a change request'
        using errcode = '22023';
    end if;
    update event_change_requests
       set status = 'processed', decision = p_decision, decision_notes = v_notes, processed_by = p_processed_by
     where request_group_id = v_group
       and status in ('outstanding', 'in_progress');
    if not found then
      raise exception 'change request % was processed while it was being decided', p_change_request_id
        using errcode = '40001';
    end if;
  elsif p_decision::text = 'approved' then
    v_plan := change_request_group_plan(v_group, v_event);
    if jsonb_array_length(v_plan -> 'faults') > 0 then
      raise exception 'This change request cannot be applied: %',
        (select string_agg(concat(fault ->> 'field', ' ', fault ->> 'message'), '; ')
           from jsonb_array_elements(v_plan -> 'faults') fault)
        using errcode = '22023';
    end if;

    -- Marked before the cancel, which closes every open request of the event
    -- as event_cancelled and would otherwise close this one too.
    update event_change_requests
       set status = 'processed', decision = p_decision, decision_notes = v_notes, processed_by = p_processed_by
     where request_group_id = v_group
       and status in ('outstanding', 'in_progress');
    if not found then
      raise exception 'change request % was processed while it was being decided', p_change_request_id
        using errcode = '40001';
    end if;

    -- D3: every history row written below names this request.
    perform set_config('connectsphere.change_history_source', 'change_request', true);
    perform set_config('connectsphere.change_request_id', v_group::text, true);
    v_reason := coalesce(v_notes, 'Organiser change request accepted.');
    v_ordinary := v_plan -> 'ordinary';
    v_significant := v_plan -> 'significant';

    if v_plan ->> 'cancellation' is not null then
      -- AC7: the reason is the coordinator's, or else the Organiser's own note.
      perform cancel_event_request(
        v_event.id, p_processed_by, coalesce(v_notes, v_plan ->> 'cancellation'), 'organiser_request'
      );
    elsif v_event.status::text in ('under_review', 'pending_clarification') then
      -- Nothing is arranged yet: 387 takes every field, with its own checks (D4 there).
      if v_ordinary || v_significant <> '{}'::jsonb then
        perform edit_event_request_details(
          v_event.id, p_processed_by, v_ordinary || v_significant,
          (select jsonb_object_agg(key, v_stored -> (select t.column_name from change_request_targets() t where t.detail_field = key))
             from jsonb_object_keys(v_ordinary || v_significant) key),
          v_reason
        );
      end if;
    else
      -- Planning, the safety statuses and Confirmed: the significant part through
      -- 395 first, which may return the event to Approved, then the ordinary part
      -- through 387, which accepts Approved (D6, D7).
      v_significant := v_significant
        || case when (v_plan ->> 'equipmentChange')::boolean then '{"equipmentChange": true}'::jsonb else '{}'::jsonb end;
      if v_significant <> '{}'::jsonb then
        perform apply_significant_event_change(v_event.id, v_significant, v_reason, p_processed_by, p_expected_impact);
      elsif v_event.status = 'confirmed' and v_ordinary <> '{}'::jsonb then
        perform change_event_request_status(v_event.id, 'confirmed', 'approved', p_processed_by, v_reason, p_processed_by);
      end if;
      if v_ordinary <> '{}'::jsonb then
        perform edit_event_request_details(
          v_event.id, p_processed_by, v_ordinary,
          (select jsonb_object_agg(key, v_stored -> (select t.column_name from change_request_targets() t where t.detail_field = key))
             from jsonb_object_keys(v_ordinary) key),
          v_reason
        );
      end if;
    end if;

    -- Transaction-local already; cleared so a later insert in the same
    -- transaction is not labelled as this request's.
    perform set_config('connectsphere.change_history_source', '', true);
    perform set_config('connectsphere.change_request_id', '', true);
  else
    -- Any other outcome (event_cancelled, and values other stories add) is
    -- recorded as given, applying nothing, as before 036.
    update event_change_requests
       set status = 'processed', decision = p_decision, decision_notes = v_notes, processed_by = p_processed_by
     where request_group_id = v_group
       and status in ('outstanding', 'in_progress');
    if not found then
      raise exception 'change request % was processed while it was being decided', p_change_request_id
        using errcode = '40001';
    end if;
    select * into v_result from event_change_requests where id = p_change_request_id;
    return v_result;
  end if;

  -- AC11: the Organiser hears the outcome from the function that decided it (D9).
  insert into notifications (recipient_id, type, event_request_id, payload)
  select er.organiser_id, 'change_request_decided', er.id,
         jsonb_build_object(
           'eventRequestId', er.id,
           'eventName', er.event_name,
           'changeRequestId', v_group,
           'decision', p_decision,
           'notes', v_notes,
           'changeFields', v_fields
         )
    from event_requests er
   where er.id = v_event.id;

  select * into v_result from event_change_requests where id = p_change_request_id;
  return v_result;
end;
$$;
revoke execute on function process_change_request(uuid, change_request_decision, text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Two notification types, added to the live list
-- ---------------------------------------------------------------------
-- The live constraint is read back and widened only by what it lacks, so a type
-- another branch added stays. The check text is built in a variable.
do $notify$
declare
  v_def text;
  v_types text[];
  v_missing text[];
  v_check text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'notifications_type_known'
     and conrelid = 'notifications'::regclass;
  if v_def is null then
    raise exception 'notifications_type_known is missing; restore it before 036';
  end if;

  v_types := array(select m[1] from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m);
  v_missing := array(
    select t from unnest(array['change_request_decided', 'change_request_significant_submitted']) as t
     where not (t = any (v_types))
  );
  if cardinality(v_missing) > 0 then
    v_check := format(
      'check (type = any (array[%s]))',
      (select string_agg(quote_literal(t), ', ') from unnest(v_types || v_missing) as t)
    );
    alter table notifications drop constraint notifications_type_known;
    execute 'alter table notifications add constraint notifications_type_known ' || v_check;
  end if;
end;
$notify$;
