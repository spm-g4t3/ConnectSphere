-- Migration 032: tell the organiser and the coordinator how an event request is progressing.
-- Four new notification types. Field names mirror booking_request_approved/rejected and
-- venue_hold_expired, so the frontend reads them the same way.
--
-- Payloads:
-- - event_request_approved / event_request_rejected (to the organiser):
--   { eventRequestId, eventName, decidedAt, decidedById, decidedByName, reason }
--   reason is the decision note: optional on approval, always set on rejection
--   (decide_event_request requires it). A rejection is not final; the organiser may
--   change the request and resubmit it.
-- - venue_hold_placed (to the assigned coordinator):
--   { eventRequestId, eventName, venueId, venueName, expiresAt, placedById, placedByName }
-- - venue_hold_expiring (to the assigned coordinator):
--   { eventRequestId, eventName, venueId, venueName, expiresAt }, the shape of venue_hold_expired.
--
-- decide_event_request and place_venue_hold write the first three; the API's hold
-- job calls process_venue_hold_reminders for the fourth.
--
-- Re-runnable.

-- The whole list, restated from 024_reject_approved_event.sql with the new types.
alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (type = any (array[
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
    'booking_request_conflicting',
    'flagged_booking_resolved',
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired',
    'booking_released',
    'booking_request_conflict_cleared',
    'equipment_requested',
    'equipment_request_changed',
    'equipment_request_cancelled',
    'equipment_arranged',
    'equipment_not_fully_arranged',
    'equipment_flagged',
    'registration_schedule_conflict',
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change',
    'booking_flagged_hours_change',
    'event_details_changed',
    'event_rejected',
    'event_request_approved',
    'event_request_rejected',
    'venue_hold_placed',
    'venue_hold_expiring'
  ]));

alter table notifications drop constraint if exists notifications_event_decision_needs_event;
alter table notifications
  add constraint notifications_event_decision_needs_event
  check ((type <> all (array['event_request_approved', 'event_request_rejected'])) or (event_request_id is not null));

alter table notifications drop constraint if exists notifications_hold_notice_needs_hold;
alter table notifications
  add constraint notifications_hold_notice_needs_hold
  check ((type <> all (array['venue_hold_placed', 'venue_hold_expiring'])) or (venue_hold_id is not null));

-- A hold gets one expiry reminder, however often the reminder job runs.
create unique index if not exists notifications_one_reminder_per_hold
  on notifications (venue_hold_id) where (type = 'venue_hold_expiring');

-- decide_event_request, as in the baseline, plus the organiser's notice.
create or replace function decide_event_request(
  p_event_request_id uuid,
  p_decision         event_request_decision,
  p_decision_note    text,
  p_decided_by       uuid,
  p_decided_at       timestamptz
)
returns event_requests
language plpgsql
as $$
declare
  v_request    event_requests;
  v_new_status event_request_status;
  v_note       text := nullif(btrim(p_decision_note), '');
begin
  if p_decision is null or p_decided_at is null then
    raise exception 'decide_event_request needs the decision and the time it was made'
      using errcode = 'null_value_not_allowed';
  end if;

  -- The decision names the status it leads to: approved or rejected.
  v_new_status := p_decision::text::event_request_status;

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- SCRUM-486 AC8, the same check as start_event_review's and for the same
  -- reason. A request cannot be under review without a coordinator (052's
  -- constraint still requires one past submitted), but this function checks
  -- the caller before the status, so a decision attempted on an unassigned
  -- submitted request would otherwise be answered by the caller check, as 42501
  -- "only the coordinator assigned ... can decide it". Reachable by a direct
  -- call to the decision route; not unreachable, so guarded.
  if v_request.status = 'submitted' and v_request.assigned_coordinator_id is null then
    raise exception 'event request % is waiting for the Event Coordinator Lead to assign it a coordinator, so it cannot be decided yet',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Only the assigned coordinator decides. A null caller is refused
  -- explicitly, for the reason start_event_review gives.
  if p_decided_by is null
     or v_request.assigned_coordinator_id is distinct from p_decided_by then
    raise exception 'only the coordinator assigned to event request % can decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- AC2 and AC3: a decision is made only on a request under review. This is
  -- what refuses a request awaiting clarification, one not yet under review,
  -- and one already decided, each with its current status named.
  if v_request.status <> 'under_review' then
    raise exception 'event request % has status %, and only a request under review can be decided',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- See (a) in this function's header in baseline/02_event_requests.sql.
  if not event_request_status_allows(v_request.status, v_new_status) then
    raise exception 'event request % has status %, which cannot change to %',
      p_event_request_id, v_request.status, v_new_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- And only the reviewer. A recorded reviewer who is someone else is refused,
  -- never overwritten; an empty one is filled in below. See (b) in this
  -- function's header in baseline/02_event_requests.sql.
  --
  -- After the status check, not before it. A decided event keeps the reviewer
  -- who decided it, even after a handover (018), so on an approved event this
  -- check would refuse the new coordinator for the wrong reason. The status is
  -- the true reason a decided event cannot be decided again.
  if v_request.reviewing_coordinator_id is not null
     and v_request.reviewing_coordinator_id <> p_decided_by then
    raise exception 'event request % is under review by another coordinator, who must decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A rejection must say why. Checked here so the coordinator gets this
  -- sentence rather than 025's constraint name.
  if p_decision = 'rejected' and v_note is null then
    raise exception 'a reason is required to reject event request %', p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- AC6: an event whose proposed start has passed cannot be approved. Measured
  -- at p_decided_at, the service's clock (see the comment above the function).
  -- A start exactly at the decision time counts as passed: the event would
  -- already be under way. A missing start is refused too, rather than approved
  -- unchecked: submission requires one, so a missing start means a row made
  -- outside the application, and approving it would approve an event whose
  -- date nobody could confirm. A rejection is allowed whatever the date.
  if p_decision = 'approved'
     and (v_request.proposed_start is null or v_request.proposed_start <= p_decided_at) then
    raise exception 'event request % cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The status and the whole decision in one statement, for the reason in the
  -- header: 025's constraints are checked against the row after the statement,
  -- and any split would leave a row one of them refuses. The reviewer is
  -- filled in here, in the same statement, so decided_by_is_reviewer sees the
  -- two equal.
  update event_requests
     set status                   = v_new_status,
         decision                 = p_decision,
         decision_note            = v_note,
         decided_by               = p_decided_by,
         decided_at               = p_decided_at,
         reviewing_coordinator_id = coalesce(reviewing_coordinator_id, p_decided_by)
   where id = p_event_request_id
     and status = 'under_review'
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while it was being decided', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The same row shape change_event_request_status writes. The note is the
  -- reason: for a rejection it is why the request was rejected, which is
  -- exactly what the status history's reason records.
  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'under_review', v_new_status, p_decided_by, v_note);

  -- The organiser hears the outcome. After every refusal, so a refused decision
  -- notifies nobody, as in assign_event_request.
  insert into notifications (recipient_id, type, event_request_id, payload)
  values
    (v_request.organiser_id,
     'event_request_' || p_decision::text,
     v_request.id,
     jsonb_build_object(
       'eventRequestId', v_request.id,
       'eventName',      v_request.event_name,
       'decidedAt',      p_decided_at,
       'decidedById',    p_decided_by,
       'decidedByName',  profile_display_name(p_decided_by),
       'reason',         v_note
     ));

  return v_request;
end;
$$;
revoke execute on function decide_event_request(uuid, event_request_decision, text, uuid, timestamp with time zone) from public, anon, authenticated;

-- place_venue_hold, as in the baseline, plus the coordinator's notice.
create or replace function place_venue_hold(
  p_event_request_id uuid,
  p_venue_id         uuid,
  p_expires_at       timestamptz,
  p_placed_by        uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_existing_id uuid;
  v_conflicts   jsonb;
  v_hold        venue_holds;
begin
  -- 1. AC1: only Venue Staff. A null placer is refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_placed_by;

  if p_placed_by is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can place a hold on a venue'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. Lock the event, "for share".
  select *
    into v_event
    from event_requests
   where id = p_event_request_id
     for share;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Lock the venue, "for no key update".
  select retired_at
    into v_retired_at
    from venues
   where id = p_venue_id
     for no key update;

  if not found then
    raise exception 'venue % not found', p_venue_id using errcode = 'no_data_found';
  end if;

  -- 4. AC2: only an Approved event, with dates.
  if v_event.status <> 'approved' then
    raise exception 'event request % has status %, and a venue can only be held for an approved event',
      p_event_request_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_APPROVED';
  end if;

  if v_event.proposed_start is null or v_event.proposed_end is null then
    raise exception 'event request % has no proposed start and end', p_event_request_id
      using errcode = 'PT409', hint = 'EVENT_DATES_MISSING';
  end if;

  -- 5. AC2: an expiry is required, and must be in the future.
  if p_expires_at is null then
    raise exception 'a hold needs an expiry'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_expires_at <= now() then
    raise exception 'a hold must expire in the future'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 6. AC4: only an active venue.
  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be held', p_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 7. Record any lapsed holds first.
  perform process_venue_hold_expiry();

  -- 8. AC3: one active hold per event at each venue.
  select vh.id
    into v_existing_id
    from venue_holds vh
   where vh.event_request_id = p_event_request_id
     and vh.venue_id = p_venue_id
     and vh.status = 'active'
   limit 1;

  if v_existing_id is not null then
    raise exception 'event request % already holds venue %', p_event_request_id, p_venue_id
      using errcode = 'PT409', hint = 'HOLD_EXISTS', detail = v_existing_id::text;
  end if;

  -- 9. AC4: the event's occupied period against everything else at the venue.
  select coalesce(
           jsonb_agg(
             occupancy_conflict_json(
               c.kind, c.id, c.event_request_id, c.event_name, c.reason,
               c.starts_at, c.ends_at, c.occupied_starts_at, c.occupied_ends_at,
               c.setup_minutes, c.turnaround_minutes
             )
             order by array_position(array['block', 'booking', 'hold'], c.kind), c.starts_at, c.id
           ),
           '[]'::jsonb
         )
    into v_conflicts
    from venue_occupancy_conflicts(p_venue_id, v_event.proposed_start, v_event.proposed_end, true,
                                   p_event_request_id) c;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 10. Insert. placed_at is the database clock; a hold is active by construction.
  insert into venue_holds (event_request_id, venue_id, placed_by, expires_at, status)
  values (p_event_request_id, p_venue_id, p_placed_by, p_expires_at, 'active')
  returning * into v_hold;

  -- The coordinator hears a hold was placed. A conflict returned above, so it
  -- notifies nobody. Only venue_hold_id, as process_venue_hold_expiry fills it.
  insert into notifications (recipient_id, type, venue_hold_id, payload)
  select v_event.assigned_coordinator_id,
         'venue_hold_placed',
         v_hold.id,
         jsonb_build_object(
           'eventRequestId', v_event.id,
           'eventName',      v_event.event_name,
           'venueId',        v.id,
           'venueName',      v.name,
           'expiresAt',      v_hold.expires_at,
           'placedById',     p_placed_by,
           'placedByName',   profile_display_name(p_placed_by)
         )
    from venues v
   where v.id = p_venue_id
     and v_event.assigned_coordinator_id is not null;

  return jsonb_build_object('outcome', 'placed', 'hold', to_jsonb(v_hold));
end;
$$;
revoke execute on function place_venue_hold(uuid, uuid, timestamp with time zone, uuid) from public, anon, authenticated;

-- Warn the coordinator once about each active hold that expires within the lead
-- time. The scheduler passes the lead time, so how early the warning comes is
-- configured in the API, not here. Returns how many notices it wrote.
create or replace function process_venue_hold_reminders(p_lead_time interval)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  if p_lead_time is null or p_lead_time < interval '0' then
    raise exception 'a hold reminder needs a lead time of zero or more'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A hold already past its expiry is left to process_venue_hold_expiry.
  with reminded as (
    insert into notifications (recipient_id, type, venue_hold_id, payload)
    select er.assigned_coordinator_id,
           'venue_hold_expiring',
           vh.id,
           jsonb_build_object(
             'eventRequestId', vh.event_request_id,
             'eventName',      er.event_name,
             'venueId',        vh.venue_id,
             'venueName',      v.name,
             'expiresAt',      vh.expires_at
           )
      from venue_holds vh
      join event_requests er on er.id = vh.event_request_id
      join venues v          on v.id  = vh.venue_id
     where vh.status = 'active'
       and vh.expires_at > now()
       and vh.expires_at <= now() + p_lead_time
       and er.assigned_coordinator_id is not null
    on conflict (venue_hold_id) where type = 'venue_hold_expiring' do nothing
    returning 1
  )
  select count(*)::integer
    into v_count
    from reminded;

  return v_count;
end;
$$;
revoke execute on function process_venue_hold_reminders(interval) from public, anon, authenticated;
