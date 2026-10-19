-- Lock only the significant fields on a confirmed event (requirements §3).
-- Ordinary edits (name, description, purpose) still arrive through an approved
-- change request; 019 applies them without leaving Confirmed, so 099's wider
-- lock left them no path. Significant fields change only through 100, which
-- returns the event to Approved first. Equipment is reviewed through equipment
-- requests, not this column, which only a clarification amendment writes.
create or replace function enforce_confirmed_event_fields()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' and new.status = 'confirmed'
     and row(new.proposed_start, new.proposed_end, new.expected_attendance,
             new.venue_requirements, new.accessibility_requirements)
         is distinct from
         row(old.proposed_start, old.proposed_end, old.expected_attendance,
             old.venue_requirements, old.accessibility_requirements) then
    raise exception 'Confirmed event details are locked. Apply a significant change and complete safety review before confirming again.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke execute on function enforce_confirmed_event_fields() from public, anon, authenticated;
grant execute on function enforce_confirmed_event_fields() to service_role;

-- An approved date or attendance change on a confirmed event is a significant
-- change: it returns the event to Approved and flags its arrangements through
-- 100, rather than editing locked fields in place. Otherwise as in 019.
create or replace function process_change_request(
  p_change_request_id uuid,
  p_decision           change_request_decision,
  p_decision_notes     text default null,
  p_processed_by       uuid default null
)
returns event_change_requests
language plpgsql
as $$
declare
  v_request              event_change_requests;
  v_event_request_id     uuid;
  v_assigned_coordinator uuid;
  v_event_status         text;
  v_change               jsonb;
begin
  select er.id, er.assigned_coordinator_id, er.status::text
    into v_event_request_id, v_assigned_coordinator, v_event_status
    from event_change_requests cr
    join event_requests er on er.id = cr.event_request_id
   where cr.id = p_change_request_id
     for update of er;

  if not found then
    raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
  end if;

  if p_processed_by is null or v_assigned_coordinator is distinct from p_processed_by then
    raise exception 'only the coordinator assigned to event request % can decide its change requests', v_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  update event_change_requests
  set
    status         = 'processed',
    decision       = p_decision,
    decision_notes = p_decision_notes,
    processed_by   = p_processed_by
  where id = p_change_request_id
    and status <> 'processed'
  returning * into v_request;

  if not found then
    if exists (select 1 from event_change_requests where id = p_change_request_id) then
      raise exception 'change request % has already been processed', p_change_request_id;
    else
      raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_decision = 'approved' then
    -- 100 validates ISO timestamps and JSON numbers; the request stores text.
    v_change := case v_request.change_field::text
      when 'proposed_start' then jsonb_build_object('proposedStart',
        to_char(v_request.requested_change::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      when 'proposed_end' then jsonb_build_object('proposedEnd',
        to_char(v_request.requested_change::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      when 'expected_attendance' then jsonb_build_object('expectedAttendance', v_request.requested_change::integer)
    end;

    if v_change is not null and v_event_status = 'confirmed' then
      perform apply_significant_event_change(
        v_request.event_request_id,
        v_change,
        coalesce(left(nullif(btrim(p_decision_notes), ''), 4000), 'Change request approved.'),
        p_processed_by
      );
    elsif v_request.change_field = 'event_name' then update event_requests set event_name = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'description' then update event_requests set description = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'purpose' then update event_requests set purpose = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_start' then update event_requests set proposed_start = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_end' then update event_requests set proposed_end = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'expected_attendance' then update event_requests set expected_attendance = v_request.requested_change::integer where id = v_request.event_request_id;
    end if;
    -- venue, equipment, other: nothing to apply, as in 006.
  end if;

  return v_request;
end;
$$;

notify pgrst, 'reload schema';
