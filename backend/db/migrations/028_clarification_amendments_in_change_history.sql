-- Migration 028: the Organiser's clarification amendments are recorded in the
-- change history (SCRUM-387 AC7, PR #84's second review). Every path that writes
-- an event's fields writes its own history rows (D17): SCRUM-395's significant
-- change, SCRUM-387's direct edit, and now the clarification reply. Change
-- requests are SCRUM-402's.
--
-- 1. event_change_history_source_known gains clarification_amendment.
-- 2. reply_to_event_clarification_with_amendments, restated whole from
--    baseline/02_event_requests.sql. The only additions are v_before and the
--    history insert after the update; the validation, the status change, the
--    clarification history entry, the coordinator's notice and the return value
--    are unchanged. Restate this function from 028 from now on, not the baseline.
--
-- Re-runnable. create or replace keeps the function's grants, and 011 left it
-- revoked from the client roles, so no grant is restated here.


-- ---------------------------------------------------------------------
-- 1. event_change_history.source
-- ---------------------------------------------------------------------
alter table event_change_history drop constraint if exists event_change_history_source_known;
alter table event_change_history
  add constraint event_change_history_source_known
  check (source = any (array['significant_change', 'direct_edit', 'change_request', 'clarification_amendment']));


-- ---------------------------------------------------------------------
-- 2. reply_to_event_clarification_with_amendments
-- ---------------------------------------------------------------------
create or replace function reply_to_event_clarification_with_amendments(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_reply            text,
  p_updates          jsonb
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_question event_request_clarification_history;
  v_updates jsonb := coalesce(p_updates, '{}'::jsonb);
  v_before event_requests;
begin
  if p_reply is null or btrim(p_reply) = '' then
    raise exception 'clarification reply is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reply)) > 2000 then
    raise exception 'clarification reply must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_updates) <> 'object' then
    raise exception 'clarification amendments must be an object'
      using errcode = '22023';
  end if;

  select * into v_request
    from event_requests
   where id = p_event_request_id
   for update;
  if not found or v_request.organiser_id <> p_organiser_id then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending_clarification' then
    raise exception 'event request has status %, not pending_clarification', v_request.status
      using errcode = '55000';
  end if;

  select question.* into v_question
    from event_request_clarification_history question
   where question.event_request_id = p_event_request_id
     and question.entry_type = 'question'
     and not exists (
       select 1
         from event_request_clarification_history closed
        where closed.event_request_id = question.event_request_id
          and closed.entry_type in ('reply', 'closure')
          and (closed.created_at, closed.id) > (question.created_at, question.id)
     )
   order by question.created_at desc, question.id desc
   limit 1;

  if not found then
    raise exception 'no open clarification question was found'
      using errcode = '55000';
  end if;

  if exists (
    select key
      from jsonb_object_keys(v_updates) as update_keys(key)
     where not (key = any(v_question.requested_fields))
  ) then
    raise exception 'an amendment includes a field the Coordinator did not request'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key in (
       'eventName', 'purpose', 'description', 'venueRequirements',
       'accessibilityRequirements', 'equipmentRequirements'
     )
       and jsonb_typeof(value) not in ('string', 'null')
  ) or exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key in ('proposedStart', 'proposedEnd')
       and jsonb_typeof(value) not in ('string', 'null')
  ) or exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key = 'expectedAttendance'
       and jsonb_typeof(value) not in ('number', 'null')
  ) then
    raise exception 'amendment values have an invalid type'
      using errcode = '22023';
  end if;

  if v_updates ? 'eventName'
     and nullif(btrim(v_updates ->> 'eventName'), '') is null then
    raise exception 'eventName cannot be blank'
      using errcode = '22023';
  end if;

  -- SCRUM-387 AC7: the row as it was, before returning reassigns v_request.
  v_before := v_request;

  update event_requests
     set event_name = case when v_updates ? 'eventName'
       then btrim(v_updates ->> 'eventName') else event_name end,
         purpose = case when v_updates ? 'purpose'
       then nullif(btrim(v_updates ->> 'purpose'), '') else purpose end,
         description = case when v_updates ? 'description'
       then nullif(btrim(v_updates ->> 'description'), '') else description end,
         proposed_start = case when v_updates ? 'proposedStart'
       then (v_updates ->> 'proposedStart')::timestamptz else proposed_start end,
         proposed_end = case when v_updates ? 'proposedEnd'
       then (v_updates ->> 'proposedEnd')::timestamptz else proposed_end end,
         expected_attendance = case when v_updates ? 'expectedAttendance'
       then (v_updates ->> 'expectedAttendance')::integer else expected_attendance end,
         venue_requirements = case when v_updates ? 'venueRequirements'
       then nullif(btrim(v_updates ->> 'venueRequirements'), '') else venue_requirements end,
         accessibility_requirements = case when v_updates ? 'accessibilityRequirements'
       then nullif(btrim(v_updates ->> 'accessibilityRequirements'), '') else accessibility_requirements end,
         equipment_requirements = case when v_updates ? 'equipmentRequirements'
       then nullif(btrim(v_updates ->> 'equipmentRequirements'), '') else equipment_requirements end
   where id = p_event_request_id
     and status = 'pending_clarification'
  returning * into v_request;

  -- SCRUM-387 AC7: one history row per amended field whose stored value
  -- changed, typed as 022 writes them (to_jsonb of the column, null for an
  -- empty side), the Organiser as the editor and the reply as the reason.
  insert into event_change_history (
    event_request_id, changed_by, field_name, old_value, new_value, reason, source
  )
  select p_event_request_id, p_organiser_id, amended.field,
         nullif(to_jsonb(v_before) -> amended.column_name, 'null'::jsonb),
         nullif(to_jsonb(v_request) -> amended.column_name, 'null'::jsonb),
         btrim(p_reply), 'clarification_amendment'
    from (values
      ('eventName', 'event_name'),
      ('purpose', 'purpose'),
      ('description', 'description'),
      ('proposedStart', 'proposed_start'),
      ('proposedEnd', 'proposed_end'),
      ('expectedAttendance', 'expected_attendance'),
      ('venueRequirements', 'venue_requirements'),
      ('accessibilityRequirements', 'accessibility_requirements'),
      ('equipmentRequirements', 'equipment_requirements')
    ) as amended(field, column_name)
   where v_updates ? amended.field
     and (to_jsonb(v_before) -> amended.column_name)
         is distinct from (to_jsonb(v_request) -> amended.column_name);

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'pending_clarification'::event_request_status,
      'under_review'::event_request_status,
      p_organiser_id,
      null::text,
      null::uuid
    );

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by)
  values (p_event_request_id, 'reply', btrim(p_reply), p_organiser_id);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.assigned_coordinator_id,
    'clarification_replied',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reply),
      'amendedFields', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
                          from jsonb_object_keys(v_updates) as update_keys(key))
    )
  );

  return v_request;
end;
$$;
