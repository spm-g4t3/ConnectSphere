create or replace function confirm_event_request(
  p_event_request_id       uuid,
  p_coordinator_id         uuid,
  p_no_equipment_confirmed boolean default false
)
returns event_requests
language plpgsql
as $$
declare
  v_event      event_requests;
  v_readiness  jsonb;
  v_reason     text := 'Event confirmed.';
begin
  if p_event_request_id is null then
    raise exception 'An event request is required' using errcode = '22023';
  end if;

  select * into v_event from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  if p_coordinator_id is null
     or v_event.assigned_coordinator_id is distinct from p_coordinator_id
     or not exists (
       select 1 from profiles where id = p_coordinator_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the event''s assigned Event Coordinator can confirm it' using errcode = '42501';
  end if;

  if v_event.status <> 'safety_approved' then
    raise exception 'This event can be confirmed only while it is Safety approved. Its current status is %.',
      v_event.status using errcode = '55000';
  end if;

  -- Match safety submission's order: event, bookings by id, then equipment by id.
  -- Include conflicting requests so a concurrent venue decision also waits.
  perform 1 from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
   order by id
     for share;
  perform 1 from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled'
   order by id
     for share;

  -- 085 checks the current database clock, after any lock wait above.
  v_readiness := event_readiness(p_event_request_id, coalesce(p_no_equipment_confirmed, false));
  if not (v_readiness ->> 'ready')::boolean then
    raise exception 'This event is not ready for confirmation.'
      using errcode = 'PT409', hint = 'EVENT_NOT_READY',
            detail = (
              select coalesce(jsonb_agg(item), '[]'::jsonb)::text
                from jsonb_array_elements(v_readiness -> 'items') item
               where not (item ->> 'met')::boolean
            );
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_readiness -> 'items') item
     where item ->> 'key' = 'no_equipment_confirmation' and (item ->> 'met')::boolean
  ) then
    v_reason := 'Event confirmed. Coordinator acknowledged that no equipment is needed.';
  end if;

  return change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'safety_approved',
    p_new_status           => 'confirmed',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_reason,
    p_expected_coordinator => p_coordinator_id
  );
end;
$$;

revoke execute on function confirm_event_request(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function confirm_event_request(uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';
