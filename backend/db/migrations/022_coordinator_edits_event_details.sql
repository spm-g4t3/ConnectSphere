-- Migration 022: the assigned coordinator edits an event's information during
-- review and planning (SCRUM-387). One function does the whole save under the
-- row lock, so an edit and its history can never be written apart (D1).
--
-- 1. event_change_history accepts the ordinary fields and equipmentRequirements,
--    records which path wrote each row (source), and becomes append-only (D13).
-- 2. edit_event_request_details: the caller, the status matrix (D3, D4, D9),
--    compare-and-set (D12), the update, one history row per changed field and
--    one notice to the Organiser (D8).
-- 3. notifications_type_known gains event_details_changed (restated from 016).


-- ---------------------------------------------------------------------
-- 1. event_change_history
-- ---------------------------------------------------------------------

-- 'equipment' stays: SCRUM-395 records equipment-line changes under it.
-- equipmentRequirements is the free-text column, edited here.
alter table event_change_history drop constraint if exists event_change_history_field_known;
alter table event_change_history
  add constraint event_change_history_field_known check (field_name = any (array[
    'proposedStart', 'proposedEnd', 'expectedAttendance', 'venueRequirements',
    'accessibilityRequirements', 'equipment',
    'eventName', 'purpose', 'description', 'equipmentRequirements'
  ]));

-- The default keeps SCRUM-395's insert (which names no source) valid unrestated,
-- and is right for every row already written. change_request is SCRUM-402's.
alter table event_change_history
  add column if not exists source text not null default 'significant_change';
alter table event_change_history drop constraint if exists event_change_history_source_known;
alter table event_change_history
  add constraint event_change_history_source_known
  check (source = any (array['significant_change', 'direct_edit', 'change_request']));

-- An audit trail anyone can edit is not one: rows are never changed or deleted.
create or replace function refuse_event_change_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'event change history entries cannot be changed or deleted'
    using errcode = '42501';
end;
$$;
revoke execute on function refuse_event_change_history_mutation() from public, anon, authenticated;

drop trigger if exists event_change_history_immutable on event_change_history;
create trigger event_change_history_immutable
  before update or delete on event_change_history
  for each row
  execute function refuse_event_change_history_mutation();


-- ---------------------------------------------------------------------
-- 2. edit_event_request_details
-- ---------------------------------------------------------------------
-- p_changes and p_expected are camelCase objects of the fields in
-- backend/src/domain/eventDetailField.js, which a test keeps in step with this
-- list (D2). p_expected holds the value the coordinator's form showed for each
-- changed field.

-- A field's value in one comparable form: typed as its column, prose trimmed and
-- blank read as null, JSON null read as SQL null. Both the stored value and the
-- caller's go through it, so 09:00Z and 17:00+08 are the same instant (D12).
-- Stable, not immutable: reading a timestamp depends on the session's time zone.
create or replace function event_detail_value(p_field text, p_value jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  select case
    when p_value is null or p_value = 'null'::jsonb then null
    when p_field in ('proposedStart', 'proposedEnd')
      then to_jsonb((p_value #>> '{}')::timestamptz)
    when p_field = 'expectedAttendance'
      then to_jsonb((p_value #>> '{}')::integer)
    else to_jsonb(nullif(btrim(p_value #>> '{}'), ''))
  end;
$$;
revoke execute on function event_detail_value(text, jsonb) from public, anon, authenticated;

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
         v_reason, 'direct_edit'
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
-- 3. notifications_type_known
-- ---------------------------------------------------------------------
-- The whole list, restated from 016 with the new type.
alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (type = any (array[
    'booking_flagged',
    'booking_request_withdrawn',
    'clarification_requested',
    'clarification_replied',
    'clarification_closed',
    'booking_flagged_setup_change',
    'venue_hold_expired',
    'event_cancelled',
    'event_request_awaiting_assignment',
    'event_request_assigned',
    'event_request_coordinator_assigned',
    'safety_review_response',
    'safety_booking_flagged',
    'safety_equipment_review',
    'event_submitted_for_safety_review',
    'booking_request_approved',
    'booking_request_rejected',
    'booking_request_conflicting',
    'flagged_booking_resolved',
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired',
    'booking_released',
    'booking_request_conflict_cleared',
    'equipment_requested',
    'equipment_request_changed',
    'equipment_request_cancelled',
    'equipment_arranged',
    'equipment_not_fully_arranged',
    'equipment_flagged',
    'registration_schedule_conflict',
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change',
    'booking_flagged_hours_change',
    'event_details_changed'
  ]));
