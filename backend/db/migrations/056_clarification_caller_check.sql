-- Migration 056: the clarification request checks its own caller (42501), so a
-- non-holder is refused here and not only by a later guard. Restated whole from
-- 011 with the same signature; only the read and the check at the top are new.

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
  -- SCRUM-444 AC2: the caller, under the row lock, before the inputs and the
  -- status: the event's holder, still an Event Coordinator. Before this a
  -- non-holder met only change_event_request_status's guard (40001).
  select * into v_request
    from event_requests
   where id = p_event_request_id
     for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;
  if p_changed_by is null
     or v_request.assigned_coordinator_id is distinct from p_changed_by
     or not exists (
       select 1 from profiles
        where id = p_changed_by and role = 'event_coordinator'
     ) then
    raise exception 'only the coordinator assigned to event request % can request a clarification',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'clarification message is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reason)) > 2000 then
    raise exception 'clarification message must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if p_reply_by_date is not null
     and p_reply_by_date <= (now() at time zone 'Asia/Singapore')::date then
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
