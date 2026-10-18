-- 089_release_venue_booking.sql
-- SCRUM-492: the assigned coordinator of an Approved event releases one of its
-- approved venue bookings. Only that booking changes; other events' requests
-- it alone made Conflicting go back to Pending; Venue Staff are told.
-- Decisions and their alternatives: docs/test-cases/SCRUM-492.md.
--
-- Run after 088, as a separate execution (088's enum value must commit first).
-- Safe to re-run: the type list is merged with the live one, columns are
-- guarded, constraints and the trigger are dropped then added, functions are
-- create or replace.
--
-- SQLSTATEs, mapped by translateError:
--   release_venue_booking
--     22023  no reason, or only whitespace                                400
--     23514  a reason over 1000 characters                                400
--     P0002  no such booking                                              404
--     42501  the caller is null, or not the event's assigned coordinator  403
--     PT409  EVENT_NOT_APPROVED, BOOKING_NOT_APPROVED                     409
--     40001  the guarded update matched no row (see 031)                  409
--   bookings_decision_final (trigger)
--     42501  a change to a released booking                               403
--
-- After running it in Supabase, read-only:
--   select enum_range(null::booking_status);
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_type_known';


-- ---------------------------------------------------------------------
-- 1. Notification types (extends 076)
-- ---------------------------------------------------------------------
-- 076's list plus this file's two, added to the live constraint as 076 does,
-- so types other branches added on the live database are kept.

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
    'flagged_booking_resolved',
    'booking_released',
    'booking_request_conflict_cleared'
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
-- 2. The release, recorded on the booking (D5)
-- ---------------------------------------------------------------------
-- The status is compared as text: 088's value is not in a fresh build's enum
-- until 088 commits, and the live enum's order differs (062).

alter table bookings
  add column if not exists released_by    uuid references auth.users (id) on delete restrict,
  add column if not exists released_at    timestamptz,
  add column if not exists release_reason text;

alter table bookings drop constraint if exists bookings_release_paired;
alter table bookings
  add constraint bookings_release_paired check (
    (released_by is null and released_at is null and release_reason is null)
    or (released_by is not null and released_at is not null and release_reason is not null)
  );

alter table bookings drop constraint if exists bookings_release_matches_status;
alter table bookings
  add constraint bookings_release_matches_status check (
    (status::text = 'released') = (released_at is not null)
  );

alter table bookings drop constraint if exists bookings_release_reason_length;
alter table bookings
  add constraint bookings_release_reason_length check (
    release_reason is null
    or (release_reason = btrim(release_reason) and length(release_reason) between 1 and 1000)
  );


-- ---------------------------------------------------------------------
-- 3. A release is final (076's trigger, D6)
-- ---------------------------------------------------------------------
-- 076's function with one more allowed move and a rule before its early
-- return: an approved booking need not be decided (approvals older than 066),
-- and a release is final whether it was or not.

create or replace function refuse_decided_booking_change()
returns trigger
language plpgsql
as $$
begin
  if old.released_at is not null
     and ((new.released_by, new.released_at, new.release_reason)
            is distinct from (old.released_by, old.released_at, old.release_reason)
          or new.status is distinct from old.status) then
    raise exception 'booking % has been released, and a release cannot be changed or undone', old.id
      using errcode = '42501';
  end if;

  -- A release only ever comes from approved, decided or not.
  if new.status::text = 'released'
     and old.status::text is distinct from 'released'
     and old.status::text <> 'approved' then
    raise exception 'booking % is %, and only an approved booking can be released',
      old.id, old.status
      using errcode = '42501';
  end if;

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
       ('flagged_for_review', 'approved'),
       ('approved', 'released')
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
-- 4. release_venue_booking
-- ---------------------------------------------------------------------
-- 077's order and reason rules. The venue is locked as decide_booking_request
-- (078 step 5) locks it, because step 9 changes other events' requests there
-- and an approval must not race that check.

create or replace function release_venue_booking(
  p_booking_id uuid,
  p_caller     uuid,
  p_reason     text
)
returns jsonb
language plpgsql
as $$
declare
  v_event_id   uuid;
  v_venue_id   uuid;
  v_venue_name text;
  v_event      event_requests;
  v_booking    bookings;
  v_candidates uuid[];
  v_freed      uuid[];
begin
  -- 1. A reason is required, checked as 077 checks it.
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required to release a venue booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception 'the reason must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- 2. Which event and venue, unlocked as in 077; then the event, locked.
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

  -- 3. The event's assigned coordinator only (D1). A null caller is refused
  --    explicitly (see 018).
  if p_caller is null or v_event.assigned_coordinator_id is distinct from p_caller then
    raise exception 'only the coordinator assigned to event request % can release its venue bookings',
      v_event_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. An Approved event only (D2).
  if v_event.status::text <> 'approved' then
    raise exception 'event request % is %, and its venue bookings can be released only while it is approved',
      v_event_id, v_event.status
      using errcode = 'PT409', hint = 'EVENT_NOT_APPROVED';
  end if;

  -- 5. Lock the venue.
  select v.name
    into v_venue_name
    from venues v
   where v.id = v_venue_id
     for no key update;

  -- 6. Lock the booking; an approved one only, each other kind pointed to its
  --    own action (D3).
  select *
    into v_booking
    from bookings
   where id = p_booking_id
     for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if v_booking.status::text <> 'approved' then
    if v_booking.status::text = 'flagged_for_review' then
      raise exception 'booking % is flagged for review; resolve it from Flagged bookings', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    elsif v_booking.status::text in ('pending', 'conflicting') then
      raise exception 'booking % is still a request; withdraw it instead', p_booking_id
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    else
      raise exception 'booking % is %, and only an approved booking can be released',
        p_booking_id, v_booking.status
        using errcode = 'PT409', hint = 'BOOKING_NOT_APPROVED';
    end if;
  end if;

  -- 7. Released, guarded so it only ever moves an approved booking.
  update bookings
     set status         = 'released',
         released_by    = p_caller,
         released_at    = now(),
         release_reason = btrim(p_reason)
   where id = p_booking_id
     and status = 'approved'
  returning * into v_booking;

  if not found then
    raise exception 'booking % changed while it was being released', p_booking_id
      using errcode = 'serialization_failure';
  end if;

  -- 8. Other events' Conflicting requests that overlap it, locked in id order
  --    as 078 step 12 locks them (D8).
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_candidates
    from (
      select b.id
        from bookings b
       where b.id in (select o.id
                        from pending_request_overlaps(v_venue_id, v_booking.starts_at,
                                                      v_booking.ends_at, v_event_id) o)
         and b.status::text = 'conflicting'
       order by b.id
         for update
    ) locked;

  -- 9. Those that nothing occupies now go back to Pending; anything else that
  --    still occupies one keeps it Conflicting.
  select coalesce(array_agg(c.id order by c.id), '{}')
    into v_freed
    from bookings c
   where c.id = any (v_candidates)
     and not exists (
       select 1
         from venue_occupancy_conflicts(c.venue_id, c.starts_at, c.ends_at, true, c.event_request_id)
     );

  update bookings
     set status = 'pending'
   where id = any (v_freed)
     and status::text = 'conflicting';

  -- Each freed request's coordinator, told which release freed it.
  insert into notifications (recipient_id, type, booking_id, payload)
  select er.assigned_coordinator_id,
         'booking_request_conflict_cleared',
         b.id,
         jsonb_build_object(
           'eventRequestId',    b.event_request_id,
           'eventName',         er.event_name,
           'venueId',           b.venue_id,
           'venueName',         v_venue_name,
           'startsAt',          b.starts_at,
           'endsAt',            b.ends_at,
           'releasedBookingId', v_booking.id,
           'releasedEventName', v_event.event_name
         )
    from bookings b
    join event_requests er on er.id = b.event_request_id
   where b.id = any (v_freed)
     and er.assigned_coordinator_id is not null
   order by b.id;

  -- 10. Every Venue Staff member, as 052 tells every Lead (D9).
  insert into notifications (recipient_id, type, booking_id, payload)
  select p.id,
         'booking_released',
         v_booking.id,
         jsonb_build_object(
           'eventRequestId', v_event_id,
           'eventName',      v_event.event_name,
           'venueId',        v_venue_id,
           'venueName',      v_venue_name,
           'startsAt',       v_booking.starts_at,
           'endsAt',         v_booking.ends_at,
           'releasedBy',     p_caller,
           'releasedByName', profile_display_name(p_caller),
           'reason',         v_booking.release_reason
         )
    from profiles p
   where p.role::text = 'venue_staff'
   order by p.id;

  return jsonb_build_object('outcome', 'released',
                            'booking', to_jsonb(v_booking),
                            'returned_to_pending', to_jsonb(v_freed));
end;
$$;

-- As 077: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function release_venue_booking(uuid, uuid, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
