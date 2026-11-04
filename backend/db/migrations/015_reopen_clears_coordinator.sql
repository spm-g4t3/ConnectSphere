-- Migration 015: reopening a rejected request also clears its coordinator (SCRUM-355).
-- 014 left the coordinator on the draft until resubmission, so the draft stayed in
-- their list but answered 404 when opened. The assignment history still names
-- them, which is what lets the Lead assign it back to them (AC4).

create or replace function reopen_event_request(
  p_event_request_id uuid,
  p_caller           uuid
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  perform assert_caller_role(
    p_caller, array['event_organiser'],
    'Only an Event Organiser can reopen an event request'
  );

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  -- Someone else's request is answered as a missing one, as the organiser's reads are.
  if not found or v_request.organiser_id <> p_caller then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  if v_request.status <> 'rejected' then
    raise exception 'This request is %, and only a Rejected request can be reopened for revision',
      equipment_event_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  insert into event_request_decision_history
    (event_request_id, decision, decision_note, decided_by, decided_at,
     superseded_reason, superseded_by)
  values
    (v_request.id, v_request.decision, v_request.decision_note, v_request.decided_by,
     v_request.decided_at, 'reopened_for_revision', p_caller);

  -- Clears submitted_at and the decision fields, and writes the status history row.
  perform change_event_request_status(
    p_event_request_id, 'rejected', 'draft', p_caller, 'Reopened for revision'
  );

  -- A draft is nobody's to review, so the reviewer and the coordinator both go.
  update event_requests
     set reviewing_coordinator_id = null,
         assigned_coordinator_id  = null
   where id = p_event_request_id
  returning * into v_request;

  return v_request;
end;
$$;

revoke execute on function reopen_event_request(uuid, uuid) from public, anon, authenticated;
