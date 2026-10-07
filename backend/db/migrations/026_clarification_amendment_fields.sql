-- Let a Coordinator scope clarification amendments to explicitly selected
-- event fields. Replies and their allowed field changes remain atomic.
-- Run after migrations 020-023.

alter table event_request_clarification_history
  add column if not exists requested_fields text[] not null default '{}';

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'event_clarification_requested_fields_known'
       and conrelid = 'public.event_request_clarification_history'::regclass
  ) then
    alter table event_request_clarification_history
      add constraint event_clarification_requested_fields_known check (
        requested_fields <@ array[
          'eventName',
          'purpose',
          'description',
          'proposedStart',
          'proposedEnd',
          'expectedAttendance',
          'venueRequirements',
          'accessibilityRequirements',
          'equipmentRequirements'
        ]::text[]
        and (entry_type = 'question' or cardinality(requested_fields) = 0)
      );
  end if;
end;
$$;

create or replace function request_event_clarification_with_fields(
  p_event_request_id     uuid,
  p_changed_by           uuid,
  p_expected_coordinator uuid,
  p_reason               text,
  p_reply_by_date        date,
  p_requested_fields     text[]
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_requested_fields text[];
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'clarification message is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reason)) > 2000 then
    raise exception 'clarification message must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if p_reply_by_date is not null
     and p_reply_by_date <= (now() at time zone 'UTC')::date then
    raise exception 'reply-by date must be in the future'
      using errcode = '22023';
  end if;
  if p_requested_fields is null then
    raise exception 'requested fields must be a list'
      using errcode = '22023';
  end if;
  if exists (
    select field
      from unnest(p_requested_fields) as fields(field)
     where field is null
        or field not in (
       'eventName', 'purpose', 'description', 'proposedStart', 'proposedEnd',
       'expectedAttendance', 'venueRequirements', 'accessibilityRequirements',
       'equipmentRequirements'
     )
  ) then
    raise exception 'one or more clarification amendment fields are invalid'
      using errcode = '22023';
  end if;

  select array_agg(field order by first_position)
    into v_requested_fields
    from (
      select field, min(position) as first_position
        from unnest(p_requested_fields) with ordinality as fields(field, position)
       group by field
    ) deduplicated;
  v_requested_fields := coalesce(v_requested_fields, '{}'::text[]);

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'under_review'::event_request_status,
      'pending_clarification'::event_request_status,
      p_changed_by,
      btrim(p_reason),
      p_expected_coordinator
    );

  update event_requests
     set clarification_reply_by_date = p_reply_by_date
   where id = p_event_request_id
     and status = 'pending_clarification'
  returning * into v_request;

  if not found then
    raise exception 'event request % is no longer pending clarification', p_event_request_id
      using errcode = '40001';
  end if;

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by, reply_by_date, requested_fields)
  values
    (p_event_request_id, 'question', btrim(p_reason), p_changed_by, p_reply_by_date, v_requested_fields);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_requested',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reason),
      'replyByDate', p_reply_by_date,
      'requestedFields', v_requested_fields
    )
  );

  return v_request;
end;
$$;

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

notify pgrst, 'reload schema';
