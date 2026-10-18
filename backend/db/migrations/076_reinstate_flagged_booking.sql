-- Venue Staff resolve a booking flagged for review by reinstating it: the flag
-- is cleared and the booking is approved again, once it still covers the
-- event's period and nothing else occupies the venue. booking_resolutions
-- records every resolution, so cancelling and replacing can write to it too,
-- and notify_flagged_booking_resolved tells the event's people about each one.


-- ---------------------------------------------------------------------
-- 1. Notification types (extends 075)
-- ---------------------------------------------------------------------
-- 075's list plus flagged_booking_resolved, added to the live constraint as
-- 075 does, so re-running this file never drops a type. A migration that
-- restates the list after this one must still include all of ours.

do $$
declare
  v_def   text;
  v_known text[] := '{}';
  v_ours  text[] := array[
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
    'flagged_booking_resolved'
  ];
  v_item  text;
begin
  select pg_get_constraintdef(c.oid)
    into v_def
    from pg_constraint c
   where c.conrelid = 'notifications'::regclass
     and c.conname = 'notifications_type_known';

  if v_def is not null then
    select coalesce(array_agg(t.m[1] order by t.ord), '{}')
      into v_known
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;

  foreach v_item in array v_ours loop
    if not v_item = any (v_known) then
      v_known := v_known || v_item;
    end if;
  end loop;

  alter table notifications drop constraint if exists notifications_type_known;

  execute format(
    'alter table notifications add constraint notifications_type_known check (type in (%s))',
    (select string_agg(quote_literal(x.item), ', ' order by x.ord)
       from unnest(v_known) with ordinality as x(item, ord))
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 2. A flagged booking may go back to approved (066's trigger)
-- ---------------------------------------------------------------------
-- 066's function with one more allowed move. Reinstating leaves the decision
-- columns as they were, so they stay immutable.

create or replace function refuse_decided_booking_change()
returns trigger
language plpgsql
as $$
begin
  if old.decided_at is null then
    return new;
  end if;

  if (new.decided_by, new.decided_at, new.decision_reason, new.suggested_alternative)
     is distinct from
     (old.decided_by, old.decided_at, old.decision_reason, old.suggested_alternative) then
    raise exception 'booking % has been decided, and its decision cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and (old.status::text, new.status::text) not in (
       ('approved', 'flagged_for_review'),
       ('approved', 'cancelled'),
       ('flagged_for_review', 'cancelled'),
       ('flagged_for_review', 'approved')
     ) then
    raise exception 'booking % has been decided, and cannot move from % to %',
      old.id, old.status, new.status
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_decision_final on bookings;
create trigger bookings_decision_final
  before update on bookings
  for each row execute function refuse_decided_booking_change();


-- ---------------------------------------------------------------------
-- 3. booking_resolutions
-- ---------------------------------------------------------------------
-- One row per resolved flag: the outcome, who, why and when. Reinstating
-- clears the flag from the booking, so the flag being resolved is copied here.
-- Restrict deletes, as 021 does: the record has to outlive a careless delete.

create table if not exists booking_resolutions (
  id                     uuid primary key default gen_random_uuid(),
  booking_id             uuid not null
    references bookings (id) on delete restrict,
  outcome                text not null
    check (outcome in ('reinstated', 'cancelled', 'replaced')),
  reason                 text not null
    check (reason = btrim(reason) and length(reason) between 1 and 1000),
  resolved_by            uuid not null
    references auth.users (id) on delete restrict,

  -- The flag as it stood when resolved. flagged_at is nullable because a
  -- booking flagged before 014 has status flagged_for_review and no flag time.
  review_block_id        uuid references venue_blocks (id) on delete set null,
  review_reason          text,
  flagged_at             timestamptz,
  flagged_by             uuid,

  -- Only a replacement names the booking that replaced this one.
  replacement_booking_id uuid references bookings (id),
  constraint booking_resolutions_replacement_paired check (
    (outcome = 'replaced') = (replacement_booking_id is not null)
  ),

  created_at             timestamptz not null default now()
);

create index if not exists idx_booking_resolutions_booking
  on booking_resolutions (booking_id, created_at);

-- As 021: RLS on with no policies; the API decides who reads it.
alter table booking_resolutions enable row level security;


-- ---------------------------------------------------------------------
-- 4. notify_flagged_booking_resolved
-- ---------------------------------------------------------------------
-- One notice per person told about a resolution, built once for 076, 077 and
-- 078's replacement. The coordinator is told unless they resolved it; the
-- organiser only once the event is confirmed. Nobody is told of their own act.
-- Callers hold the event lock, so the status read here is the one they checked.

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
$$;

-- It writes for whichever caller passes an id, so only the functions reach it.
revoke execute on function notify_flagged_booking_resolved(uuid, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. reinstate_flagged_booking
-- ---------------------------------------------------------------------
-- decide_booking_request's (066) approval path, for a flagged booking: the
-- same caller check, lock order and refusals. The period must still cover the
-- event's, as 064's checklist reads it. A safety flag is resolved by
-- cancelling or replacing, never by reinstating.

create or replace function reinstate_flagged_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_role        text;
  v_event_id    uuid;
  v_venue_id    uuid;
  v_event       event_requests;
  v_retired_at  timestamptz;
  v_booking     bookings;
  v_conflicts   jsonb;
  v_resolution  booking_resolutions;
begin
  -- 1. Only Venue Staff, as decide_booking_request checks it.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can reinstate a flagged booking'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. A reason is required; the table's check would refuse it later anyway,
  --    but with a constraint name instead of a sentence.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to reinstate a flagged booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 3. Which event and venue, unlocked as in 066; then event, venue, booking.
  select b.event_request_id, b.venue_id
    into v_event_id, v_venue_id
    from bookings b
   where b.id = p_booking_id;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select *
    into v_event
    from event_requests
   where id = v_event_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  select retired_at
    into v_retired_at
    from venues
   where id = v_venue_id
     for no key update;

  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  -- 4. The booking is flagged, and not for the safety check.
  if v_booking.status::text <> 'flagged_for_review' then
    raise exception 'booking % is %, and only a flagged booking can be reinstated',
      p_booking_id, v_booking.status
      using errcode = 'PT409', hint = 'BOOKING_NOT_FLAGGED';
  end if;

  if v_booking.review_reason = 'safety_review' then
    raise exception 'booking % was flagged by the safety review, and can only be cancelled or replaced',
      p_booking_id
      using errcode = 'PT409', hint = 'SAFETY_FLAG_NOT_REINSTATABLE';
  end if;

  -- 5. The event is still live and past approval (066, step 7).
  if v_event.status::text not in ('approved', 'safety_review', 'safety_approved', 'confirmed') then
    raise exception 'event request % has status %, and a venue can only be booked for an event that is approved, in or through the safety check, or confirmed',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_BOOKABLE';
  end if;

  -- 6. The booking still covers the event's start to end (064). An event with
  --    no period is covered by nothing.
  if not (v_event.proposed_start is not null and v_event.proposed_end is not null
          and v_booking.starts_at <= v_event.proposed_start
          and v_booking.ends_at >= v_event.proposed_end) then
    raise exception 'booking % no longer covers the event''s period', p_booking_id
      using errcode = 'PT409', hint = 'BOOKING_PERIOD_STALE';
  end if;

  if v_retired_at is not null then
    raise exception 'venue % is retired and cannot be booked', v_venue_id
      using errcode = 'PT409', hint = 'VENUE_RETIRED';
  end if;

  -- 7. The re-check, as 066 asks it. A flagged booking counts as an occupant,
  --    so this one is left out, or it would clash with itself.
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
    from venue_occupancy_conflicts(v_venue_id, v_booking.starts_at, v_booking.ends_at, true,
                                   v_event_id) c
   where not (c.kind = 'booking' and c.id = p_booking_id);

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 8. The record first, while the booking still carries the flag it copies.
  insert into booking_resolutions (booking_id, outcome, reason, resolved_by,
                                   review_block_id, review_reason, flagged_at, flagged_by)
  values (p_booking_id, 'reinstated', btrim(p_reason), p_caller,
          v_booking.review_block_id, v_booking.review_reason,
          v_booking.flagged_at, v_booking.flagged_by)
  returning * into v_resolution;

  -- 9. Approved again, with the whole flag cleared (034's pairing), guarded so
  --    it only ever moves a flagged booking.
  update bookings
     set status          = 'approved',
         flagged_at      = null,
         flagged_by      = null,
         review_block_id = null,
         review_reason   = null
   where id = p_booking_id
     and status = 'flagged_for_review'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being reinstated', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 10. Tell the event's people, in the same transaction.
  perform notify_flagged_booking_resolved(v_resolution.id, 'venue_staff');

  return jsonb_build_object('outcome', 'reinstated',
                            'booking', to_jsonb(v_booking),
                            'resolution', to_jsonb(v_resolution));
end;
$$;

-- As 066: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function reinstate_flagged_booking(uuid, uuid, text)
  from public, anon, authenticated;
