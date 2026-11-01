-- Migration 055: SCRUM-444 AC3, only the Event Coordinator Lead hands an event
-- over. Week 9 Q&A: a coordinator cannot reassign their own events. This
-- reverses SCRUM-486 AC6, which let the holder hand over too; SCRUM-486 stays
-- Done and SCRUM-444 carries the change.
--
-- reassign_event_request restated whole from baseline/02_event_requests.sql, with
-- the same signature, so no drop. Only the caller check changes; the status
-- list, the new-holder checks, the history and the notices are the baseline's.

create or replace function reassign_event_request(
  p_event_request_id   uuid,
  p_new_coordinator_id uuid,
  p_assigned_by        uuid,
  p_handover_note      text
)
returns event_requests
language plpgsql
as $$
declare
  v_request  event_requests;
  v_outgoing uuid;
  v_is_lead  boolean := false;
begin
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  v_outgoing := v_request.assigned_coordinator_id;

  -- The Lead only (SCRUM-444 AC3): the holder may no longer hand an event over.
  -- A null caller is refused explicitly, as in 018.
  perform 1
     from profiles p
    where p.id = p_assigned_by
      and p.role = 'event_coordinator_lead'
      for share;
  v_is_lead := found;

  if p_assigned_by is null or not v_is_lead then
    raise exception 'only the Event Coordinator Lead can hand over event request %',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A request nobody holds is assigned, not reassigned.
  if v_outgoing is null then
    raise exception 'event request % has no coordinator yet, so it must be assigned, not reassigned',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- AC5's seven, compared as text so safety_review and safety_approved can be
  -- named before SCRUM-488 adds them to the enum (037 does the same).
  if v_request.status::text not in ('submitted', 'under_review', 'pending_clarification',
                                    'approved', 'safety_review', 'safety_approved',
                                    'confirmed') then
    raise exception 'event request % has status %, and cannot be handed over in that status',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform 1
     from profiles p
    where p.id = p_new_coordinator_id
      and p.role = 'event_coordinator'
      for share;

  if not found then
    raise exception 'user % is not an Event Coordinator, so cannot be handed event request %',
      p_new_coordinator_id, p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  if p_new_coordinator_id = v_outgoing then
    raise exception 'event request % is already assigned to that coordinator', p_event_request_id
      using errcode = 'check_violation';
  end if;

  -- 018's update, guarded on the outgoing coordinator read under the lock
  -- rather than on the caller: a Lead is not the holder, and the guard's job
  -- is "nobody moved it in between". The reviewer rule is 018's.
  update event_requests
     set assigned_coordinator_id  = p_new_coordinator_id,
         reviewing_coordinator_id = case
           when decision is null and reviewing_coordinator_id is not null
             then p_new_coordinator_id
           else reviewing_coordinator_id
         end
   where id = p_event_request_id
     and assigned_coordinator_id = v_outgoing
  returning * into v_request;

  if not found then
    raise exception 'event request % changed hands while this handover was being made', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  insert into event_request_assignment_history
    (event_request_id, previous_coordinator_id, new_coordinator_id,
     assigned_by, handover_note)
  values
    (p_event_request_id, v_outgoing, p_new_coordinator_id,
     p_assigned_by, p_handover_note);

  -- AC10, as for a first assignment, with who held it before (SCRUM-518). The
  -- same two types; previousCoordinatorId is what makes it a handover. The
  -- note to the new coordinator only, never the Organiser (AC9).
  insert into notifications (recipient_id, type, event_request_id, payload)
  values
    (p_new_coordinator_id,
     'event_request_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'assignedById',            p_assigned_by,
       'assignedByName',          profile_display_name(p_assigned_by),
       'previousCoordinatorId',   v_outgoing,
       'previousCoordinatorName', profile_display_name(v_outgoing),
       'note',                    nullif(btrim(p_handover_note), '')
     )),
    (v_request.organiser_id,
     'event_request_coordinator_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'coordinatorId',           p_new_coordinator_id,
       'coordinatorName',         profile_display_name(p_new_coordinator_id),
       'previousCoordinatorId',   v_outgoing,
       'previousCoordinatorName', profile_display_name(v_outgoing)
     ));

  return v_request;
end;
$$;
