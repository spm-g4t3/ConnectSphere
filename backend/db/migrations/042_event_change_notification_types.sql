-- Migration 042: notices about a confirmed event and its changes.
-- Confirmation and a venue change each get a type of their own, and
-- event_cancelled gains an attendee audience in its payload. The functions that
-- confirm, replace a venue and cancel send them.

-- ---------------------------------------------------------------------
-- 1. Two notification types, added to the live list
-- ---------------------------------------------------------------------
-- Several open branches add types; restating a fixed list would drop whichever
-- ran before this one, so the live list is read back and widened by what it lacks.
do $notify$
declare
  v_def text;
  v_types text[];
  v_missing text[];
  v_check text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'notifications_type_known'
     and conrelid = 'notifications'::regclass;
  if v_def is null then
    raise exception 'notifications_type_known is missing; restore it before 042';
  end if;

  v_types := array(select m[1] from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m);
  v_missing := array(
    select t from unnest(array['event_confirmed', 'event_venue_changed']) as t
     where not (t = any (v_types))
  );
  if cardinality(v_missing) > 0 then
    v_check := format(
      'check (type = any (array[%s]))',
      (select string_agg(quote_literal(t), ', ') from unnest(v_types || v_missing) as t)
    );
    alter table notifications drop constraint notifications_type_known;
    execute 'alter table notifications add constraint notifications_type_known ' || v_check;
  end if;
end;
$notify$;

-- Each is about one event; without it the notice cannot name or link it.
alter table notifications drop constraint if exists notifications_event_confirmed_needs_event;
alter table notifications
  add constraint notifications_event_confirmed_needs_event
  check ((type <> 'event_confirmed') or (event_request_id is not null));

alter table notifications drop constraint if exists notifications_event_venue_changed_needs_event;
alter table notifications
  add constraint notifications_event_venue_changed_needs_event
  check ((type <> 'event_venue_changed') or (event_request_id is not null));

-- ---------------------------------------------------------------------
-- 2. confirm_event_request (restated from baseline 09; tells the Organiser,
--    and registered attendees when the event is confirmed again)
-- ---------------------------------------------------------------------
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
  v_event       event_requests;
  v_readiness   jsonb;
  v_reason      text := 'Event confirmed.';
  v_confirmed   event_requests;
  v_reconfirmed boolean;
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

  -- Read before the status change, which writes this confirmation's own row.
  v_reconfirmed := exists (
    select 1 from event_request_status_history
     where event_request_id = p_event_request_id
       and new_status = 'confirmed'
  );

  v_confirmed := change_event_request_status(
    p_event_request_id     => p_event_request_id,
    p_expected_status      => 'safety_approved',
    p_new_status           => 'confirmed',
    p_changed_by           => p_coordinator_id,
    p_reason               => v_reason,
    p_expected_coordinator => p_coordinator_id
  );

  -- Readiness required every live booking to be approved, so approved is
  -- exactly what the event is booked into.
  insert into notifications (recipient_id, type, event_request_id, payload)
  values (
    v_confirmed.organiser_id,
    'event_confirmed',
    p_event_request_id,
    jsonb_build_object(
      'audience',       'organiser',
      'eventRequestId', p_event_request_id,
      'eventName',      v_confirmed.event_name,
      'startsAt',       v_confirmed.proposed_start,
      'endsAt',         v_confirmed.proposed_end,
      'confirmedAt',    now(),
      'reconfirmed',    v_reconfirmed,
      'venues', coalesce((
        select jsonb_agg(
                 jsonb_build_object('venueName', v.name, 'startsAt', b.starts_at, 'endsAt', b.ends_at)
                 order by b.starts_at, v.name
               )
          from bookings b
          join venues v on v.id = b.venue_id
         where b.event_request_id = p_event_request_id
           and b.status = 'approved'
      ), '[]'::jsonb)
    )
  );

  -- Attendees hear only of a re-confirmation: on a first one nobody can have
  -- registered yet. Anyone the promotion trigger just moved off the waiting
  -- list is registered by now and is told too: registration_promoted says they
  -- have a place, this says what the changed event now is.
  if v_reconfirmed then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select r.attendee_id,
           'event_confirmed',
           p_event_request_id,
           jsonb_build_object(
             'audience',       'attendee',
             'eventRequestId', p_event_request_id,
             'eventName',      v_confirmed.event_name,
             'startsAt',       v_confirmed.proposed_start,
             'endsAt',         v_confirmed.proposed_end,
             'confirmedAt',    now(),
             'reconfirmed',    true,
             'venueNames', coalesce((
               select jsonb_agg(n.name order by n.first_start, n.name)
                 from (
                   select v.name, min(b.starts_at) as first_start
                     from bookings b
                     join venues v on v.id = b.venue_id
                    where b.event_request_id = p_event_request_id
                      and b.status = 'approved'
                    group by v.name
                 ) n
             ), '[]'::jsonb)
           )
      from event_registrations r
     where r.event_request_id = p_event_request_id
       and r.status = 'registered';
  end if;

  return v_confirmed;
end;
$$;
revoke execute on function confirm_event_request(uuid, uuid, boolean, timestamp with time zone) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. notify_flagged_booking_resolved (restated from baseline 05; also tells
--    registered attendees when a replacement moves the event to another venue)
-- ---------------------------------------------------------------------
create or replace function notify_flagged_booking_resolved(
  p_resolution_id    uuid,
  p_resolved_by_role text
)
returns void
language sql
as $$
  insert into notifications (recipient_id, type, booking_id, payload)
  select r.recipient_id,
         'flagged_booking_resolved',
         b.id,
         jsonb_build_object(
           'audience',             r.audience,
           'outcome',              br.outcome,
           'eventRequestId',       b.event_request_id,
           'eventName',            er.event_name,
           'venueId',              b.venue_id,
           'venueName',            v.name,
           'startsAt',             b.starts_at,
           'endsAt',               b.ends_at,
           'reason',               br.reason,
           'resolvedAt',           br.created_at,
           'resolvedByRole',       p_resolved_by_role,
           'replacementBookingId', rb.id,
           'replacementVenueName', rv.name,
           'replacementStartsAt',  rb.starts_at,
           'replacementEndsAt',    rb.ends_at
         )
    from booking_resolutions br
    join bookings b        on b.id = br.booking_id
    join venues v          on v.id = b.venue_id
    join event_requests er on er.id = b.event_request_id
    left join bookings rb  on rb.id = br.replacement_booking_id
    left join venues rv    on rv.id = rb.venue_id
   cross join lateral (
     values ('coordinator', er.assigned_coordinator_id),
            ('organiser',   case when er.status::text = 'confirmed' then er.organiser_id end)
   ) as r (audience, recipient_id)
   where br.id = p_resolution_id
     and r.recipient_id is not null
     and r.recipient_id <> br.resolved_by
   order by r.audience;

  -- Attendees only care where the event is, so a replacement at the same venue
  -- (a new period) tells them nothing. Only a confirmed event has attendees.
  insert into notifications (recipient_id, type, event_request_id, payload)
  select reg.attendee_id,
         'event_venue_changed',
         er.id,
         jsonb_build_object(
           'audience',          'attendee',
           'eventRequestId',    er.id,
           'eventName',         er.event_name,
           'previousVenueName', v.name,
           'venueName',         rv.name
         )
    from booking_resolutions br
    join bookings b              on b.id = br.booking_id
    join venues v                on v.id = b.venue_id
    join event_requests er       on er.id = b.event_request_id
    join bookings rb             on rb.id = br.replacement_booking_id
    join venues rv               on rv.id = rb.venue_id
    join event_registrations reg on reg.event_request_id = er.id
   where br.id = p_resolution_id
     and rb.venue_id <> b.venue_id
     and er.status::text = 'confirmed'
     and reg.status = 'registered'
   order by reg.attendee_id;
$$;
revoke execute on function notify_flagged_booking_resolved(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. cancel_event_request (restated from 013; also tells registered and
--    waitlisted attendees, with the coordinator's message and never the reason)
-- ---------------------------------------------------------------------
create or replace function cancel_event_request(
  p_event_request_id uuid,
  -- The holder, or the Event Coordinator Lead for a submitted request nobody holds.
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
  v_is_lead boolean;
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

  -- A request nobody holds waits for the Lead, so only a Lead may cancel it; a
  -- held event is its holder's to cancel, never the Lead's (SCRUM-539).
  v_is_lead := exists (
    select 1 from profiles where id = p_coordinator_id and role = 'event_coordinator_lead'
  );

  if v_request.status = 'submitted' and v_request.assigned_coordinator_id is null and not v_is_lead then
    raise exception 'event request % is waiting for the Event Coordinator Lead to assign it a coordinator; only the Lead can cancel it',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_is_lead and v_request.assigned_coordinator_id is not null then
    raise exception 'Only the coordinator assigned to event request % can cancel it; the Event Coordinator Lead cancels only requests nobody holds',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A Lead on a cancelled request falls through to the status check's 409.
  if v_request.assigned_coordinator_id is distinct from p_coordinator_id
     and not (v_is_lead and v_request.status in ('submitted', 'cancelled')) then
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
      v_request.assigned_coordinator_id
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

  -- The internal reason stays with the organiser and staff; attendees get only
  -- the message written for them. Cancelling leaves registrations as they were,
  -- so they can be read here, after the release.
  insert into notifications (recipient_id, type, event_request_id, payload)
  select r.attendee_id,
         'event_cancelled',
         p_event_request_id,
         jsonb_build_object(
           'audience', 'attendee',
           'eventRequestId', p_event_request_id,
           'eventName', v_request.event_name,
           'message', v_cancelled.attendee_message,
           'cancelledAt', v_cancelled.cancelled_at
         )
    from event_registrations r
   where r.event_request_id = p_event_request_id
     and r.status in ('registered', 'waitlisted');

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
revoke execute on function cancel_event_request(uuid, uuid, text, event_cancellation_initiator, text) from public, anon, authenticated;
