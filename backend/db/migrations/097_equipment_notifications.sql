-- 097_equipment_notifications.sql
-- SCRUM-176 "Notify Users of Equipment Requests and Availability"
--
-- Run in the Supabase SQL Editor, after 089. Safe to run twice: the
-- constraint is rebuilt from whatever it allows now, every function is
-- create or replace, and every trigger is dropped before it is created.
--
-- Notifications are written by triggers on the equipment tables, so they commit
-- or roll back with the change they describe and no existing function is
-- restated (054 and 061 stay as they are). Same rule as 048: the database
-- writes them, the API only reads them.
--
--   equipment_requested           Technical Support: a request's first line (AC1, AC2)
--   equipment_request_changed     Technical Support: a line added, amended or
--                                 removed; and Technical Support plus the
--                                 coordinator: the event's date or time moved (AC5)
--   equipment_request_cancelled   Technical Support: the last line was removed (AC5)
--   equipment_arranged            coordinator: every line is reserved (AC3)
--   equipment_not_fully_arranged  coordinator: the review ended with a line short (AC4)
--   equipment_flagged             coordinator: equipment became unusable under a
--                                 reservation (AC6)
--
-- Cancelling the whole event is not repeated here: 048 already sends
-- event_cancelled to Technical Support.
--
-- Recipients: every profile holding technical_support_staff (the team's choice
-- under requirements section 3), and the event's current assigned coordinator.
-- Nothing here changes a reservation, a status or an event. Changes flag and
-- notify; the people decide.


-- ---------------------------------------------------------------------
-- 1. notifications_type_known
-- ---------------------------------------------------------------------
-- The newest migration that sets this list carries every type, as 089 does, so
-- one file shows what the database can send. It is added to the live
-- constraint, not set over it, so types another open branch has already run on
-- the shared database are kept too. A migration after this one must include
-- these.

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
    'equipment_flagged'
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
-- 2. Shared pieces
-- ---------------------------------------------------------------------

-- The lines a notification talks about: type, quantity asked for, units held
-- and the reviewer's outcome. Named lines are shown even if removed; with no
-- names, the request's live lines.
create or replace function equipment_notification_lines(
  p_equipment_request_id uuid,
  p_line_ids             uuid[] default null
)
returns jsonb
language sql
stable
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'equipmentType', t.name,
               'quantity',      l.quantity,
               'reserved',      equipment_line_reserved(l.id),
               'outcome',       l.outcome
             )
             order by t.name
           ),
           '[]'::jsonb
         )
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.equipment_request_id = p_equipment_request_id
     and ((p_line_ids is null and l.removed_at is null)
          or l.id = any (p_line_ids));
$$;

-- Writes one notification per recipient. p_once drops a notification that an
-- identical one in this same transaction already sent, for changes that touch
-- several rows at once (retiring a type flags every reservation of it).
create or replace function notify_equipment_audiences(
  p_event_request_id uuid,
  p_type             text,
  p_technical_support boolean,
  p_coordinator      boolean,
  p_payload          jsonb,
  p_once             boolean default false
)
returns void
language plpgsql
as $$
declare
  v_name        text;
  v_coordinator uuid;
  v_base        jsonb;
begin
  select event_name, assigned_coordinator_id
    into v_name, v_coordinator
    from event_requests
   where id = p_event_request_id;

  if not found then
    return;
  end if;

  v_base := jsonb_build_object('eventRequestId', p_event_request_id, 'eventName', v_name)
            || coalesce(p_payload, '{}'::jsonb);

  if p_technical_support then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select p.id,
           p_type,
           p_event_request_id,
           v_base || jsonb_build_object('audience', 'technical_support_staff')
      from profiles p
     where p.role::text = 'technical_support_staff'
       and (not p_once
            or not exists (
                 select 1
                   from notifications n
                  where n.recipient_id = p.id
                    and n.type = p_type
                    and n.event_request_id = p_event_request_id
                    and n.created_at = now()
                    and n.payload = v_base || jsonb_build_object('audience', 'technical_support_staff')));
  end if;

  if p_coordinator and v_coordinator is not null then
    insert into notifications (recipient_id, type, event_request_id, payload)
    select v_coordinator,
           p_type,
           p_event_request_id,
           v_base || jsonb_build_object('audience', 'event_coordinator')
     where not p_once
        or not exists (
             select 1
               from notifications n
              where n.recipient_id = v_coordinator
                and n.type = p_type
                and n.event_request_id = p_event_request_id
                and n.created_at = now()
                and n.payload = v_base || jsonb_build_object('audience', 'event_coordinator'));
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. A line is added (AC1, AC2, AC5)
-- ---------------------------------------------------------------------
-- The first live line of a request is the request; any later one is a change.
-- A request cancelled earlier is not reused (add_equipment_line starts a new
-- one), so its first line counts as a request again.

create or replace function equipment_notify_line_added()
returns trigger
language plpgsql
as $$
declare
  v_event  uuid;
  v_others integer;
begin
  select event_request_id into v_event
    from equipment_requests
   where id = new.equipment_request_id;

  select count(*) into v_others
    from equipment_lines
   where equipment_request_id = new.equipment_request_id
     and removed_at is null
     and id <> new.id;

  perform notify_equipment_audiences(
    v_event,
    case when v_others = 0 then 'equipment_requested' else 'equipment_request_changed' end,
    true,
    false,
    jsonb_build_object('lines', equipment_notification_lines(new.equipment_request_id, array[new.id]))
      || case when v_others = 0 then '{}'::jsonb else jsonb_build_object('change', 'added') end
  );
  return null;
end;
$$;

drop trigger if exists equipment_lines_notify_added on equipment_lines;
create trigger equipment_lines_notify_added
  after insert on equipment_lines
  for each row
  execute function equipment_notify_line_added();


-- ---------------------------------------------------------------------
-- 4. A line is amended or removed (AC5)
-- ---------------------------------------------------------------------
-- Only a change to what the coordinator asked for. A reviewer setting an
-- outcome touches other columns and does not fire this. Removing the last line
-- cancels the request, and that is told once, as a cancellation.

create or replace function equipment_notify_line_changed()
returns trigger
language plpgsql
as $$
declare
  v_event  uuid;
  v_others integer;
begin
  select event_request_id into v_event
    from equipment_requests
   where id = new.equipment_request_id;

  if new.removed_at is not null then
    select count(*) into v_others
      from equipment_lines
     where equipment_request_id = new.equipment_request_id
       and removed_at is null
       and id <> new.id;

    if v_others = 0 then
      perform notify_equipment_audiences(
        v_event, 'equipment_request_cancelled', true, false,
        jsonb_build_object(
          'lines', equipment_notification_lines(new.equipment_request_id, array[new.id]),
          'reason', 'The last line was removed'
        )
      );
    else
      perform notify_equipment_audiences(
        v_event, 'equipment_request_changed', true, false,
        jsonb_build_object(
          'change', 'removed',
          'lines', equipment_notification_lines(new.equipment_request_id, array[new.id])
        )
      );
    end if;
    return null;
  end if;

  perform notify_equipment_audiences(
    v_event, 'equipment_request_changed', true, false,
    jsonb_build_object(
      'change', 'amended',
      'previousQuantity', old.quantity,
      'notesChanged', new.technical_notes is distinct from old.technical_notes,
      'lines', equipment_notification_lines(new.equipment_request_id, array[new.id])
    )
  );
  return null;
end;
$$;

drop trigger if exists equipment_lines_notify_changed on equipment_lines;
create trigger equipment_lines_notify_changed
  after update of quantity, technical_notes, removed_at on equipment_lines
  for each row
  when (old.removed_at is null
        and (new.removed_at is not null
             or new.quantity is distinct from old.quantity
             or new.technical_notes is distinct from old.technical_notes))
  execute function equipment_notify_line_changed();


-- ---------------------------------------------------------------------
-- 5. The request is arranged, or cannot be fully arranged (AC3, AC4)
-- ---------------------------------------------------------------------

create or replace function equipment_notify_request_outcome()
returns trigger
language plpgsql
as $$
begin
  perform notify_equipment_audiences(
    new.event_request_id,
    case new.status::text
      when 'arranged' then 'equipment_arranged'
      else 'equipment_not_fully_arranged'
    end,
    false,
    true,
    jsonb_build_object('lines', equipment_notification_lines(new.id))
  );
  return null;
end;
$$;

drop trigger if exists equipment_requests_notify_outcome on equipment_requests;
create trigger equipment_requests_notify_outcome
  after update of status on equipment_requests
  for each row
  when (new.status::text in ('arranged', 'cannot_be_fully_arranged')
        and new.status is distinct from old.status)
  execute function equipment_notify_request_outcome();


-- ---------------------------------------------------------------------
-- 6. The event's date or time moves (AC5)
-- ---------------------------------------------------------------------
-- Watched on the event itself, not on the flags it causes: 054 only flags
-- reservations that are held, so a request still waiting for review, or a second
-- move before the first flag is resolved, would otherwise go unannounced.
-- Technical Support and the coordinator are told once per move, for any event
-- with a live equipment request, whether or not anything was reserved.

create or replace function equipment_notify_event_period_changed()
returns trigger
language plpgsql
as $$
begin
  if exists (
       select 1
         from equipment_requests r
        where r.event_request_id = new.id
          and r.status <> 'cancelled'
     ) then
    perform notify_equipment_audiences(
      new.id, 'equipment_request_changed', true, true,
      jsonb_build_object('change', 'event_period', 'startsAt', new.proposed_start, 'endsAt', new.proposed_end),
      true
    );
  end if;
  return null;
end;
$$;

drop trigger if exists event_requests_notify_equipment_period_changed on event_requests;
create trigger event_requests_notify_equipment_period_changed
  after update of proposed_start, proposed_end on event_requests
  for each row
  when (new.proposed_start is distinct from old.proposed_start
        or new.proposed_end is distinct from old.proposed_end)
  execute function equipment_notify_event_period_changed();


-- ---------------------------------------------------------------------
-- 7. A reservation is flagged (AC5, AC6)
-- ---------------------------------------------------------------------
-- Every flag is one history row of action 'flagged' (054), so this watches that
-- table instead of each cause. By reason:
--   the line was amended    skipped: the line trigger above already told
--                           Technical Support, and the coordinator made it
--   the date or time moved  skipped: section 6 tells both of them, flags or not
--   anything else           the coordinator: equipment became unusable. An
--                           unrecognised reason lands here, so it is reported
--                           rather than lost.

create or replace function equipment_notify_reservation_flagged()
returns trigger
language plpgsql
as $$
declare
  v_type text;
begin
  if new.reason in ('The line quantity or notes were changed', 'The event date or time changed') then
    return null;
  end if;

  select t.name into v_type
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.id = new.equipment_line_id;

  perform notify_equipment_audiences(
    new.event_request_id, 'equipment_flagged', false, true,
    jsonb_build_object('reason', new.reason, 'equipmentType', v_type),
    true
  );
  return null;
end;
$$;

drop trigger if exists equipment_reservation_events_notify_flagged on equipment_reservation_events;
create trigger equipment_reservation_events_notify_flagged
  after insert on equipment_reservation_events
  for each row
  when (new.action = 'flagged')
  execute function equipment_notify_reservation_flagged();
