-- 075_booking_decisions_after_safety_review.sql
-- Dev's 071 and 074 restated two objects after 066 and 067, dropping the
-- booking-decision changes. This file puts them back on top of the latest
-- definitions, and teaches 064's readiness check about 'conflicting' (065):
--   notifications_type_known   071's list, plus 066's three types
--   cancel_event_request       074, conflicting bookings count as live (as 067)
--   event_readiness            064, conflicting bookings listed, never met
--
-- Run after 074. Re-runnable.

-- ---------------------------------------------------------------------
-- 1. notifications_type_known (071's list, plus 066's decision types)
-- ---------------------------------------------------------------------

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
      'booking_flagged',
      'booking_request_withdrawn',
      'clarification_requested',
      'clarification_replied',
      'clarification_closed',
      'booking_flagged_setup_change',
      'venue_hold_expired',
      'event_cancelled',
      'event_request_awaiting_assignment',
      'event_request_assigned',
      'event_request_coordinator_assigned',
      'safety_review_response',
      'safety_booking_flagged',
      'safety_equipment_review',
      'event_submitted_for_safety_review',
      'booking_request_approved',
      'booking_request_rejected',
      'booking_request_conflicting'
    )
  );


-- ---------------------------------------------------------------------
-- 2. cancel_event_request (074, conflicting bookings tell Venue Staff)
-- ---------------------------------------------------------------------
-- A conflicting request is withdrawn on cancellation (067), so Venue Staff
-- are told about it as they are about a pending one. 074's otherwise word for word.

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
       and b.status in ('pending', 'conflicting', 'approved', 'flagged_for_review')
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

revoke execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) from public, anon, authenticated;
grant execute on function cancel_event_request(
  uuid, uuid, text, event_cancellation_initiator, text
) to service_role;


-- ---------------------------------------------------------------------
-- 3. event_readiness (064, conflicting bookings listed, never met)
-- ---------------------------------------------------------------------
-- 073's submit and gate trigger are not restated: their 'for share' locks skip
-- conflicting rows, but such a row can only become approved, rejected or
-- withdrawn, which can make readiness wrongly "not ready", never wrongly "ready".

create or replace function event_readiness(
  p_event_request_id       uuid,
  p_no_equipment_confirmed boolean default false
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event        event_requests;
  v_items        jsonb := '[]'::jsonb;
  v_booking      record;
  v_equipment    record;
  v_any_booking  boolean := false;
  v_any_request  boolean := false;
  v_covers       boolean;
begin
  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  -- Venue: one line per live booking (051's live set), by start then id.
  for v_booking in
    select b.id, b.status::text as status, b.starts_at, b.ends_at, v.name as venue_name
      from bookings b
      join venues v on v.id = b.venue_id
     where b.event_request_id = p_event_request_id
       and b.status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
     order by b.starts_at, b.id
  loop
    v_any_booking := true;
    v_covers := v_event.proposed_start is not null and v_event.proposed_end is not null
                and v_booking.starts_at <= v_event.proposed_start
                and v_booking.ends_at >= v_event.proposed_end;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key',       'venue',
      'met',       v_booking.status = 'approved' and v_covers,
      'detail',    case
                     when v_booking.status = 'pending'            then 'Awaiting approval'
                     when v_booking.status = 'conflicting'        then 'Conflicting, awaiting a decision'
                     when v_booking.status = 'flagged_for_review' then 'Flagged for review'
                     when not v_covers                            then 'Does not cover the event''s start to end'
                     else 'Approved'
                   end,
      'bookingId', v_booking.id,
      'venueName', v_booking.venue_name
    ));
  end loop;

  if not v_any_booking then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key', 'venue', 'met', false, 'detail', 'No venue booking'));
  end if;

  -- Equipment: one line per request that is not cancelled, in 038's words.
  for v_equipment in
    select r.id, r.status::text as status
      from equipment_requests r
     where r.event_request_id = p_event_request_id
       and r.status::text <> 'cancelled'
     order by r.created_at, r.id
  loop
    v_any_request := true;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key',                'equipment',
      'met',                v_equipment.status = 'arranged',
      'detail',             equipment_request_status_words(v_equipment.status),
      'equipmentRequestId', v_equipment.id
    ));
  end loop;

  if not v_any_request then
    if nullif(btrim(v_event.equipment_requirements), '') is null then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key', 'equipment', 'met', true, 'detail', 'No equipment requested'));
    else
      -- SCRUM-363 AC5: the organiser asked for equipment and nothing was requested.
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key',                   'no_equipment_confirmation',
        'met',                   coalesce(p_no_equipment_confirmed, false),
        'detail',                'Confirm that this event needs no equipment',
        'organiserRequirements', v_event.equipment_requirements
      ));
    end if;
  end if;

  -- A clock check, not a period overlap: written now() < start so SCRUM-484's
  -- single-source scan (venueOccupancySingleSource.test.js) does not read it as one.
  v_items := v_items || jsonb_build_array(jsonb_build_object(
    'key',    'date',
    'met',    v_event.proposed_start is not null and v_event.proposed_end is not null
              and now() < v_event.proposed_start,
    'detail', case
                when v_event.proposed_start is null then 'The event has no start date'
                when v_event.proposed_end is null   then 'The event has no end date'
                when v_event.proposed_start <= now() then 'The event''s start has passed'
                else 'Starts in the future'
              end
  ));

  return jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'ready',          not exists (select 1 from jsonb_array_elements(v_items) i where not (i ->> 'met')::boolean),
    'items',          v_items
  );
end;
$$;

revoke execute on function event_readiness(uuid, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
