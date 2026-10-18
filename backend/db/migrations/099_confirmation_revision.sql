-- Replace the old signature so acknowledgement cannot bypass revision checks.
drop function if exists confirm_event_request(uuid, uuid, boolean);

create or replace function confirm_event_request(
  p_event_request_id       uuid,
  p_coordinator_id         uuid,
  p_no_equipment_confirmed boolean default false,
  p_expected_updated_at    timestamptz default null
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

  -- 098 checks the current database clock, after any lock wait above.
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

  -- Acknowledgement belongs to the event revision the coordinator reviewed.
  if p_expected_updated_at is not null
     and v_event.updated_at is distinct from p_expected_updated_at then
    raise exception 'This event has changed. Refresh its checklist before confirming.' using errcode = '55000';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_readiness -> 'items') item
     where item ->> 'key' = 'no_equipment_confirmation' and (item ->> 'met')::boolean
  ) then
    if p_expected_updated_at is null then
      raise exception 'Refresh this event and explicitly acknowledge that no equipment is needed before confirming.'
        using errcode = '55000';
    end if;
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

revoke execute on function confirm_event_request(uuid, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function confirm_event_request(uuid, uuid, boolean, timestamptz) to service_role;

-- Legacy change acceptance must not silently replace confirmed arrangements.
-- Registration settings and operational metadata remain independently editable.
create or replace function enforce_confirmed_event_fields()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' and new.status = 'confirmed'
     and row(new.event_name, new.description, new.purpose, new.proposed_start,
             new.proposed_end, new.expected_attendance, new.venue_requirements,
             new.accessibility_requirements, new.equipment_requirements)
         is distinct from
         row(old.event_name, old.description, old.purpose, old.proposed_start,
             old.proposed_end, old.expected_attendance, old.venue_requirements,
             old.accessibility_requirements, old.equipment_requirements) then
    raise exception 'Confirmed event details are locked. Apply a significant change and complete safety review before confirming again.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists event_requests_confirmed_fields on event_requests;
create trigger event_requests_confirmed_fields
  before update on event_requests
  for each row execute function enforce_confirmed_event_fields();

revoke execute on function enforce_confirmed_event_fields() from public, anon, authenticated;
grant execute on function enforce_confirmed_event_fields() to service_role;

notify pgrst, 'reload schema';
