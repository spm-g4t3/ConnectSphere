-- SCRUM-561: the assigned coordinator can cancel an event in Safety review or
-- Safety approved. 048's cancel_event_request restated with the status guard
-- read from 063's transition table, and the Safety Officers told when the event
-- was in Safety review. Both that and 064's submit_event_for_safety_review take
-- their recipients from safety_officer_recipients(), so the lists cannot drift.

create or replace function safety_officer_recipients()
returns setof uuid
language sql
stable
as $$
  select p.id from profiles p where p.role = 'safety_officer'
$$;

revoke execute on function safety_officer_recipients() from public, anon, authenticated;
grant execute on function safety_officer_recipients() to service_role;

create or replace function cancel_event_request(
  p_event_request_id uuid,
  p_coordinator_id uuid,
  p_reason text,
  p_initiator event_cancellation_initiator,
  p_attendee_message text default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_question_id uuid;
  v_cancelled event_requests;
  v_has_venue_bookings boolean;
  v_has_equipment boolean;
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

  if not event_request_status_allows(v_request.status, 'cancelled'::event_request_status) then
    raise exception 'Event request % has status %, which cannot be cancelled',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select exists (
    select 1
      from bookings b
     where b.event_request_id = p_event_request_id
       and b.status in ('pending', 'approved', 'flagged_for_review')
  )
    into v_has_venue_bookings;

  select exists (
    select 1
      from equipment_requests r
     where r.event_request_id = p_event_request_id
       and r.status <> 'cancelled'
    union all
    select 1
      from equipment_reservations r
     where r.event_request_id = p_event_request_id
       and r.released_at is null
  )
    into v_has_equipment;

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

  perform release_event_arrangements(
    p_event_request_id,
    'event cancelled',
    p_coordinator_id
  );

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

  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_request.organiser_id,
    'event_cancelled',
    p_event_request_id,
    jsonb_build_object(
      'audience', 'organiser',
      'eventName', v_request.event_name,
      'reason', btrim(p_reason),
      'cancelledAt', v_cancelled.cancelled_at
    )
  );

  if v_has_venue_bookings then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'venue_staff',
             'eventName', v_request.event_name
           )
      from profiles p
     where p.role = 'venue_staff';
  end if;

  if v_has_equipment then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'technical_support_staff',
             'eventName', v_request.event_name
           )
      from profiles p
     where p.role = 'technical_support_staff';
  end if;

  -- Only safety_review: those officers were told it was waiting on them. A
  -- safety_approved event is already answered, and 064 notifies nobody then.
  if v_request.status::text = 'safety_review' then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select r.id,
           'event_cancelled',
           p_event_request_id,
           jsonb_build_object(
             'audience', 'safety_officer',
             'eventName', v_request.event_name,
             'reason', btrim(p_reason),
             'cancelledAt', v_cancelled.cancelled_at
           )
      from safety_officer_recipients() as r(id);
  end if;

  return v_cancelled;
end;
$$;

-- 064's function restated unchanged except that the recipients come from
-- safety_officer_recipients().
create or replace function submit_event_for_safety_review(
  p_event_request_id       uuid,
  p_coordinator_id         uuid,
  p_note                   text default null,
  p_no_equipment_confirmed boolean default false
)
returns event_requests
language plpgsql
as $$
declare
  v_request    event_requests;
  v_note       text := nullif(btrim(p_note), '');
  v_readiness  jsonb;
  v_confirmed  boolean;
begin
  if p_event_request_id is null then
    raise exception 'submit_event_for_safety_review needs an event request' using errcode = 'null_value_not_allowed';
  end if;

  select * into v_request from event_requests where id = p_event_request_id for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  -- A null caller is refused as not the holder, as 052's equipment guard does.
  if p_coordinator_id is null or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the event''s assigned coordinator can submit it for the safety check'
      using errcode = '42501';
  end if;

  if v_request.status::text <> 'approved' then
    raise exception 'This event can be submitted for the safety check only while it is Approved. It is %.',
      case v_request.status::text
        when 'draft'                 then 'a Draft'
        when 'submitted'             then 'Submitted'
        when 'under_review'          then 'Under review'
        when 'pending_clarification' then 'Pending clarification'
        when 'safety_review'         then 'Safety review'
        when 'safety_approved'       then 'Safety approved'
        when 'confirmed'             then 'Confirmed'
        when 'completed'             then 'Completed'
        when 'rejected'              then 'Rejected'
        when 'cancelled'             then 'Cancelled'
        else v_request.status::text
      end
      using errcode = '55000';
  end if;

  if length(v_note) > 2000 then
    raise exception 'The note for the Safety Officer must be 2,000 characters or fewer' using errcode = '22023';
  end if;

  -- Event, then bookings, then equipment: the order SCRUM-363's confirm takes,
  -- so the two never deadlock, and a flag arriving now waits for us.
  perform 1 from bookings
   where event_request_id = p_event_request_id
     and status::text in ('pending', 'approved', 'flagged_for_review')
   order by id
     for share;
  perform 1 from equipment_requests
   where event_request_id = p_event_request_id
     and status::text <> 'cancelled'
   order by id
     for share;

  v_readiness := event_readiness(p_event_request_id, p_no_equipment_confirmed);
  if not (v_readiness ->> 'ready')::boolean then
    raise exception 'This event is not ready for the safety check.'
      using errcode = 'PT409',
            hint    = 'EVENT_NOT_READY',
            detail  = (select coalesce(jsonb_agg(i), '[]'::jsonb)::text
                         from jsonb_array_elements(v_readiness -> 'items') i
                        where not (i ->> 'met')::boolean);
  end if;

  -- 022's function (or 058's, same signature) writes the history row, with the note as its reason.
  v_request := change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'approved',
    p_new_status           => 'safety_review',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_note,
    p_expected_coordinator => p_coordinator_id
  );

  -- True only when the acknowledgement line was there to confirm.
  v_confirmed := exists (
    select 1 from jsonb_array_elements(v_readiness -> 'items') i
     where i ->> 'key' = 'no_equipment_confirmation' and (i ->> 'met')::boolean
  );

  insert into safety_review_submissions (event_request_id, submitted_by, note, no_equipment_confirmed)
  values (p_event_request_id, p_coordinator_id, v_note, v_confirmed);

  insert into notifications (recipient_id, type, event_request_id, payload)
  select r.id,
         'event_submitted_for_safety_review',
         v_request.id,
         jsonb_build_object(
           'eventRequestId',  v_request.id,
           'eventName',       v_request.event_name,
           'coordinatorId',   p_coordinator_id,
           'coordinatorName', profile_display_name(p_coordinator_id),
           'startsAt',        v_request.proposed_start,
           'submittedAt',     now()
         )
    from safety_officer_recipients() as r(id);

  return v_request;
end;
$$;

revoke execute on function submit_event_for_safety_review(uuid, uuid, text, boolean) from public, anon, authenticated;

revoke execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) from public, anon, authenticated;
grant execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) to service_role;

notify pgrst, 'reload schema';
