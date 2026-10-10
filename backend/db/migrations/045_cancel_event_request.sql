-- 045_cancel_event_request.sql
-- SCRUM-374: cancel an event and release its arrangements atomically.
--
-- Run after 022_event_status_transitions.sql,
-- 030_event_clarification_reply_by.sql, 042_event_cancellation_fields.sql
-- and 043_release_event_arrangements.sql.
--
-- This implementation covers statuses and tables present in this repository.
-- Week 7 safety statuses/reviews, registrations and their closure remain
-- pending until their status/schema changes are available.
--
-- The API must call this function, not issue separate writes: a PostgreSQL
-- function executes as one statement and any raised error rolls every step
-- back, including change_event_request_status() and release_event_arrangements().

create or replace function cancel_event_request(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_reason           text,
  p_initiator        event_cancellation_initiator,
  p_attendee_message text default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request       event_requests;
  v_question_id   uuid;
  v_cancelled     event_requests;
begin
  if p_event_request_id is null or p_coordinator_id is null then
    raise exception 'Event request id and coordinator id are required'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Cancellation reason is required and cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_initiator is null then
    raise exception 'Cancellation initiator is required'
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
    raise exception 'Only the coordinator assigned to event request % can cancel it',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status::text not in (
    'submitted',
    'under_review',
    'pending_clarification',
    'approved',
    'confirmed'
  ) then
    raise exception 'Event request % has status %, which cannot be cancelled',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select *
    into v_cancelled
    from change_event_request_status(
      p_event_request_id,
      v_request.status,
      'cancelled'::event_request_status,
      p_coordinator_id,
      btrim(p_reason),
      p_coordinator_id
    );

  update event_requests
     set cancellation_reason = btrim(p_reason),
         cancellation_initiator = p_initiator,
         cancelled_by = p_coordinator_id,
         cancelled_at = now(),
         attendee_message = nullif(btrim(p_attendee_message), '')
   where id = p_event_request_id
  returning * into v_cancelled;

  perform release_event_arrangements(p_event_request_id, 'event cancelled');

  update event_change_requests
     set status = 'processed',
         decision = 'event_cancelled',
         decision_notes = null,
         processed_by = p_coordinator_id
   where event_request_id = p_event_request_id
     and status in ('outstanding', 'in_progress');

  select question.id
    into v_question_id
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

  if v_question_id is not null then
    insert into event_request_clarification_history
      (event_request_id, entry_type, message, created_by)
    values
      (p_event_request_id, 'closure', 'Event cancelled', p_coordinator_id);
  end if;

  -- Registrations and safety reviews are not modeled in this repository;
  -- their closure is intentionally deferred rather than guessed.
  return v_cancelled;
end;
$$;

revoke execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) from public, anon, authenticated;
grant execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) to service_role;

notify pgrst, 'reload schema';
