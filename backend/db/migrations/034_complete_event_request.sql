-- SCRUM-381: mark a Confirmed event as Completed, in one transaction.
--
-- Moves the status, closes open change requests and records the closing notes.
-- The equipment reservations are released by the existing trigger
-- event_requests_release_equipment_on_completed (baseline 06) when the status
-- changes, in this same transaction, so they are not released a second time here.
-- The venue booking is deliberately kept as a history record, so this does not
-- call release_event_arrangements (which would release it). Registration needs no write: register_for_event refuses any
-- event that is not Confirmed.

-- Outcome stamped on change requests that were still open when the event was
-- completed. The new value is only used at run time, inside the function below.
alter type change_request_decision add value if not exists 'event_completed';

-- The clock the completion rule reads. It is a function only so a test can pin
-- it to a fixed instant and check the end-time boundary exactly; nothing else
-- calls it, and in production it is simply the current time.
create or replace function event_clock()
returns timestamptz
language sql
volatile
as $$ select clock_timestamp() $$;
revoke execute on function event_clock() from public, anon, authenticated;

create or replace function complete_event_request(
  p_event_request_id uuid,
  p_coordinator_id uuid,
  p_closing_notes text default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_completed event_requests;
  v_notes text := nullif(regexp_replace(p_closing_notes, '^\s+|\s+$', '', 'g'), '');
begin
  if p_event_request_id is null or p_coordinator_id is null then
    raise exception 'Event request id and coordinator id are required'
      using errcode = 'null_value_not_allowed';
  end if;

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the coordinator assigned to event request % can mark it as completed',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status::text is distinct from 'confirmed' then
    raise exception 'Event request % has status %, and only a Confirmed event can be marked as completed',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The clock is read after the lock is held, as register_for_event does.
  if v_request.proposed_end is null or event_clock() < v_request.proposed_end then
    raise exception 'Event request % has not ended yet, so it cannot be marked as completed',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'Closing notes can be at most 2000 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  select *
    into v_completed
    from change_event_request_status(
      p_event_request_id,
      'confirmed'::event_request_status,
      'completed'::event_request_status,
      p_coordinator_id,
      'Marked as completed',
      p_coordinator_id
    );

  update event_requests
     set closing_notes = v_notes
   where id = p_event_request_id
  returning * into v_completed;

  update event_change_requests
     set status = 'processed',
         decision = 'event_completed',
         decision_notes = null,
         processed_by = p_coordinator_id
   where event_request_id = p_event_request_id
     and status in ('outstanding', 'in_progress');

  return v_completed;
end;
$$;
revoke execute on function complete_event_request(uuid, uuid, text) from public, anon, authenticated;
