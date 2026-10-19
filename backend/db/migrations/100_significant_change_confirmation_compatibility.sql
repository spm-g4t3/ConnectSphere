-- Preserve confirmed-field locks while applying the significant-change transaction.
-- Requires 096 significant changes and 099 confirmation field protection.

create or replace function apply_significant_event_change(
  p_event_request_id uuid,
  p_changes          jsonb,
  p_reason           text,
  p_user_id          uuid,
  p_expected_impact  jsonb default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests%rowtype;
  v_updated event_requests%rowtype;
  v_impact jsonb;
  v_booking_ids uuid[];
  v_reservation_ids uuid[];
  v_flagged_booking_ids uuid[];
  v_reservation_count integer;
  v_latest_submission_id uuid;
  v_previous_change_event_id text;
  v_reason text := nullif(btrim(p_reason), '');
begin
  -- 1. Lock the event before checking its owner, lifecycle or arrangements.
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;

  -- 2. Verify the caller and status under the lock.
  if p_user_id is null
     or v_event.assigned_coordinator_id is distinct from p_user_id
     or not exists (
       select 1 from profiles
        where id = p_user_id and role = 'event_coordinator'
     ) then
    raise exception 'Only the assigned event coordinator can apply this change'
      using errcode = '42501';
  end if;
  if v_event.status::text not in ('approved', 'confirmed', 'safety_review', 'safety_approved') then
    raise exception 'Event status % does not allow a significant change', v_event.status
      using errcode = 'PT409',
            hint = 'EVENT_STATUS_NOT_ALLOWED';
  end if;
  if v_reason is null or length(v_reason) > 4000 then
    raise exception 'A reason of 1 to 4,000 characters is required'
      using errcode = '22023';
  end if;

  -- Determine and lock the exact active arrangements before persisting fields.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;

  perform 1
    from bookings
   where id = any(v_booking_ids)
   order by id
   for update;
  perform 1
    from equipment_reservations
   where id = any(v_reservation_ids)
   order by id
   for update;

  -- Recalculate with the shared routine after acquiring arrangement locks.
  v_impact := significant_event_change_impact(p_event_request_id, p_changes);
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_booking_ids
    from jsonb_array_elements(v_impact -> 'venueBookings') item;
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}')
    into v_reservation_ids
    from jsonb_array_elements(v_impact -> 'equipmentReservations') item;
  if p_expected_impact is not null and v_impact is distinct from p_expected_impact then
    raise exception 'The impact changed; refresh the preview before confirming'
      using errcode = 'PT409',
            hint = 'SIGNIFICANT_CHANGE_IMPACT_CHANGED';
  end if;

  -- Close a pending review and leave Confirmed before editing locked fields.
  -- Later failures roll back this transition and its history with the change.
  if v_event.status::text = 'safety_review' then
    select id into v_latest_submission_id
      from safety_review_submissions
     where event_request_id = p_event_request_id
     order by created_at desc, id desc
     limit 1;

    if v_latest_submission_id is null then
      raise exception 'The pending safety review has no submission to close'
        using errcode = '55000';
    end if;

    insert into safety_review_closures (
      event_request_id, safety_review_submission_id, closed_by, reason
    ) values (
      p_event_request_id, v_latest_submission_id, p_user_id, v_reason
    );
  end if;

  -- Return Confirmed and safety-stage events to Approved through the
  -- existing transition/history function.
  if v_event.status::text in ('confirmed', 'safety_review', 'safety_approved') then
    v_updated := change_event_request_status(
      p_event_request_id,
      v_event.status,
      'approved',
      p_user_id,
      v_reason,
      p_user_id
    );
  end if;

  -- 3. Save fields and one history row for each changed field.
  v_previous_change_event_id :=
    current_setting('connectsphere.significant_event_change_event_id', true);
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    p_event_request_id::text,
    true
  );
  update event_requests
     set proposed_start = case when p_changes ? 'proposedStart'
                               then (p_changes ->> 'proposedStart')::timestamptz
                               else proposed_start end,
         proposed_end = case when p_changes ? 'proposedEnd'
                             then (p_changes ->> 'proposedEnd')::timestamptz
                             else proposed_end end,
         expected_attendance = case when p_changes ? 'expectedAttendance'
                                    then (p_changes ->> 'expectedAttendance')::integer
                                    else expected_attendance end,
         venue_requirements = case when p_changes ? 'venueRequirements'
                                   then nullif(btrim(p_changes ->> 'venueRequirements'), '')
                                   else venue_requirements end,
         accessibility_requirements = case when p_changes ? 'accessibilityRequirements'
                                            then nullif(btrim(p_changes ->> 'accessibilityRequirements'), '')
                                            else accessibility_requirements end
   where id = p_event_request_id
   returning * into v_updated;
  perform set_config(
    'connectsphere.significant_event_change_event_id',
    coalesce(v_previous_change_event_id, ''),
    true
  );

  insert into event_change_history (
    event_request_id, changed_by, field_name, old_value, new_value, reason
  )
  select p_event_request_id, p_user_id, field_name, old_value, new_value, v_reason
    from (
      select 'proposedStart'::text as field_name,
             to_jsonb(v_event.proposed_start) as old_value,
             to_jsonb(v_updated.proposed_start) as new_value
      union all
      select 'proposedEnd',
             to_jsonb(v_event.proposed_end),
             to_jsonb(v_updated.proposed_end)
      union all
      select 'expectedAttendance',
             to_jsonb(v_event.expected_attendance),
             to_jsonb(v_updated.expected_attendance)
      union all
      select 'venueRequirements',
             to_jsonb(v_event.venue_requirements),
             to_jsonb(v_updated.venue_requirements)
      union all
      select 'accessibilityRequirements',
             to_jsonb(v_event.accessibility_requirements),
             to_jsonb(v_updated.accessibility_requirements)
    ) changed_fields
   where old_value is distinct from new_value;

  if coalesce((v_impact ->> 'equipmentChangeRecorded')::boolean, false) then
    insert into event_change_history (
      event_request_id, changed_by, field_name, old_value, new_value, reason
    ) values (
      p_event_request_id, p_user_id, 'equipment',
      '{"changeRequested":false}'::jsonb,
      '{"changeRequested":true}'::jsonb,
      v_reason
    );
  end if;

  -- 4. Flag each affected venue booking. Existing flags stay under review;
  -- this event-change category is added without erasing the original cause.
  with flagged as (
    update bookings b
       set status = 'flagged_for_review',
           flag_reason = coalesce(b.flag_reason, 'event_change'),
           review_reason = coalesce(b.review_reason, 'event_changed'),
           flagged_at = coalesce(b.flagged_at, now()),
           flagged_by = coalesce(b.flagged_by, p_user_id)
     where b.id = any(v_booking_ids)
       and b.status::text in ('approved', 'flagged_for_review')
    returning b.id, b.venue_id, b.starts_at, b.ends_at
  )
  select coalesce(array_agg(flagged.id order by flagged.id), '{}')
    into v_flagged_booking_ids
    from flagged;

  if cardinality(v_flagged_booking_ids) <> cardinality(v_booking_ids) then
    raise exception 'A venue booking changed while applying the event change'
      using errcode = '40001';
  end if;

  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_flagged_event_change', flagged.id, p_event_request_id,
         jsonb_build_object(
           'eventName', v_updated.event_name,
           'venueName', venue.name,
           'startsAt', flagged.starts_at,
           'endsAt', flagged.ends_at,
           'reason', v_reason
         )
    from bookings flagged
    join venues venue on venue.id = flagged.venue_id
    cross join profiles staff
   where flagged.id = any(v_flagged_booking_ids)
     and staff.role = 'venue_staff';

  -- Pending requests keep their status; Venue Staff deciding them need the new time.
  insert into notifications (recipient_id, type, booking_id, event_request_id, payload)
  select staff.id, 'booking_request_event_change', (item ->> 'id')::uuid, p_event_request_id,
         jsonb_build_object(
           'eventRequestId', p_event_request_id,
           'eventName', v_updated.event_name,
           'venueName', item ->> 'venueName',
           'startsAt', item -> 'startsAt',
           'endsAt', item -> 'endsAt',
           'newStartsAt', v_updated.proposed_start,
           'newEndsAt', v_updated.proposed_end,
           'reason', v_reason
         )
    from jsonb_array_elements(v_impact -> 'pendingBookingRequests') item
    cross join profiles staff
   where staff.role = 'venue_staff';

  -- 5. N15 owns reservation history and equipment-request review state. 054's
  -- own reason, so 097 tells Technical Support and the coordinator once per move.
  v_reservation_count := flag_equipment_reservations(v_reservation_ids, 'The event date or time changed');
  if v_reservation_count <> cardinality(v_reservation_ids) then
    raise exception 'An equipment reservation changed while applying the event change'
      using errcode = '40001';
  end if;


  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_event.organiser_id,
    'event_significant_change',
    p_event_request_id,
    jsonb_build_object(
      'eventRequestId', p_event_request_id,
      'eventName', v_event.event_name,
      'reason', v_reason,
      'changedFields', v_impact -> 'changedFields',
      'statusBefore', v_impact ->> 'statusBefore',
      'statusAfter', v_impact ->> 'statusAfter'
    )
  );

  if coalesce((v_impact ->> 'registeredAttendeesToNotify')::integer, 0) > 0 then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select registration.attendee_id,
           'event_significant_change_attendee',
           p_event_request_id,
           jsonb_build_object(
             'eventRequestId', p_event_request_id,
             'eventName', v_event.event_name,
             'startsAt', v_updated.proposed_start,
             'endsAt', v_updated.proposed_end,
             'reason', v_reason
           )
      from event_registrations registration
     where registration.event_request_id = p_event_request_id
       and registration.status = 'registered';
  end if;

  return jsonb_build_object(
    'event', to_jsonb(v_updated),
    'impact', v_impact,
    'flaggedBookingIds', to_jsonb(v_flagged_booking_ids),
    'flaggedReservationCount', v_reservation_count
  );
end;
$$;

revoke all on function apply_significant_event_change(uuid, jsonb, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function apply_significant_event_change(uuid, jsonb, text, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
