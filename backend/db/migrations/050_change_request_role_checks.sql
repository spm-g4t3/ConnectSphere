-- Migration 050: SCRUM-402, the caller's role checked inside the change request
-- functions (AGENTS.md:16; review on #95). The routes gate the role with
-- requireRole, and these functions checked only that the caller holds or owns the
-- event. Decline and the preview never reach 387's or 395's role check, so the
-- gate was the only check on those paths. Same signatures; nothing else restated.
-- Re-runnable.

-- ---------------------------------------------------------------------
-- 1. change_request_gate, restated from 036
-- ---------------------------------------------------------------------
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

  -- The caller before the status, so a stranger learns nothing (387's D15): the
  -- holder, still an Event Coordinator. Decline and the preview reach neither 387
  -- nor 395, so this is the only role check on those paths.
  if p_user_id is null
     or event_row.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
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

-- ---------------------------------------------------------------------
-- 2. create_change_request_group, restated from 039
-- ---------------------------------------------------------------------
-- 039's definition, with the role refused (42501) before the owner check. The
-- owner check keeps 22023, so its 400 is unchanged.
create or replace function create_change_request_group(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_changes          jsonb,
  p_note             text default null
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
  v_note text := nullif(btrim(p_note), '');
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_organiser_id is null or not exists (
    select 1 from profiles where id = p_organiser_id and role = 'event_organiser'
  ) then
    raise exception 'Only an Event Organiser may request a change to an event'
      using errcode = '42501';
  end if;
  if p_organiser_id is null or v_event.organiser_id is distinct from p_organiser_id then
    raise exception 'Only the event organiser may request a change to this event'
      using errcode = '22023';
  end if;
  if v_event.status = 'draft' then
    raise exception 'Cannot request a change to a draft event; submit it first'
      using errcode = '22023';
  end if;
  -- SCRUM-347: a rejected event is revised by reopening it, not by change requests,
  -- which rejection closes and nobody could process after a reopen.
  if v_event.status = 'rejected' then
    raise exception 'Cannot request a change to a rejected event; revise and resubmit it instead'
      using errcode = '22023';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 9 then
    raise exception 'A change request names 1 to 9 changes'
      using errcode = '22023';
  end if;
  if length(v_note) > 2000 then
    raise exception 'The note must be 2,000 characters or fewer'
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
      (event_request_id, requested_by, change_field, requested_change, request_group_id, organiser_note)
    values (
      p_event_request_id, p_organiser_id,
      (v_item ->> 'changeField')::event_change_field,
      btrim(v_item ->> 'requestedChange'),
      v_group,
      v_note
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
revoke execute on function create_change_request_group(uuid, uuid, jsonb, text) from public, anon, authenticated;
