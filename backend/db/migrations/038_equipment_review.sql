-- 038_equipment_review.sql
-- SCRUM-291, 292, 294 and 295: review an equipment request
--
-- Part of SCRUM-290 "Review an Equipment Request - Technical Support Staff".
-- Run this once in the Supabase SQL Editor, after 022_equipment_schema.sql,
-- 024_equipment_availability.sql and 037_equipment_request_lines.sql. Safe to
-- re-run: columns and the table are guarded, constraints and triggers are
-- dropped before they are recreated, and every function is create or replace.
--
-- What a review is. Technical Support Staff start a review of an equipment
-- request, reserve equipment for its lines (SCRUM-300, not built yet), mark any
-- line that cannot be provided, and complete the review. The request is
-- Arranged when every line is fully reserved, and Cannot be fully arranged when
-- the reviewer completes the review with a line short.
--
--   start_equipment_review          AC2, AC9   Pending review or Cannot be fully
--                                              arranged -> Under review
--   take_over_equipment_review      AC3, AC9   replaces the reviewer
--   mark_equipment_line_unavailable AC7, AC9   "Cannot be provided", note needed
--   clear_equipment_line_outcome    AC7, AC9   takes that mark off again
--   complete_equipment_review       AC7, AC9   Under review -> Cannot be fully
--                                              arranged
--   arrange_equipment_request_if_complete AC6  Under review -> Arranged, called
--                                              by SCRUM-300's reservation function
--   equipment_review_for_event      AC4        everything the review screen needs
--   equipment_for_event             AC8        037's read, now with reserved
--                                              quantity and "Cannot be provided"
--
-- Same shape as 037 and 029. Every write is one function called through rpc, and
-- it locks in the order 037 set: the event row, then the request row, then line
-- and reservation rows. A refused call changes nothing.
--
-- SQLSTATEs:
--   42501  the caller is not the request's current reviewer, or is null   403
--   55000  the request is not in a status that allows the action          409
--   22023  a missing or blank note, or lines missing one                  400
--   P0002  no such event, no equipment request, or no such line           404
--   40001  a guarded update matched no row (a backstop; the lock makes it
--          unreachable)                                                   409
--
-- Not done here, on purpose:
--   * No role check. The route's technical-support-only gate does that, as
--     coordinatorOnly does for 037. The functions check the stronger thing: the
--     caller is the current reviewer, under the row lock.
--   * No reservations are made. SCRUM-300 does that, and calls
--     arrange_equipment_request_if_complete from inside its own function so the
--     two succeed or fail together (AC6).
--   * No notifications. The coordinator is told by SCRUM-176 (AC10).
--   * No venue or coordinator name in the review read. They are joined in the
--     service from the tables that own them.
--
-- A reservation counts towards a line when it is live (not released), flagged
-- or not. SCRUM-300 decides what a flagged reservation needs before a request
-- can be Arranged; if it needs more than "live", change equipment_line_reserved.


-- ---------------------------------------------------------------------
-- 1. Review fields on the request
-- ---------------------------------------------------------------------

alter table equipment_requests
  add column if not exists reviewer_id        uuid references auth.users(id),
  add column if not exists review_started_at  timestamptz;

-- A reviewer exists exactly while the request is Under review.
alter table equipment_requests
  drop constraint if exists equipment_requests_reviewer_matches_status;
alter table equipment_requests
  add constraint equipment_requests_reviewer_matches_status
  check (
    (status = 'under_review' and reviewer_id is not null and review_started_at is not null)
    or
    (status <> 'under_review' and reviewer_id is null and review_started_at is null)
  );


-- ---------------------------------------------------------------------
-- 2. Outcome fields on the line
-- ---------------------------------------------------------------------

alter table equipment_lines
  add column if not exists outcome       text,
  add column if not exists outcome_note  text,
  add column if not exists outcome_by    uuid references auth.users(id),
  add column if not exists outcome_at    timestamptz;

-- No outcome means no note, marker or time. An outcome needs all of them, and
-- the note cannot be blank (AC7).
alter table equipment_lines
  drop constraint if exists equipment_lines_outcome_consistent;
alter table equipment_lines
  add constraint equipment_lines_outcome_consistent
  check (
    (outcome is null
       and outcome_note is null and outcome_by is null and outcome_at is null)
    or
    (outcome = 'cannot_be_provided'
       and outcome_note is not null and length(btrim(outcome_note)) > 0
       and outcome_by is not null and outcome_at is not null)
  );


-- ---------------------------------------------------------------------
-- 3. Review history
-- ---------------------------------------------------------------------
-- One row per action (AC9). A bigint identity so rows written in one
-- transaction still sort in the order they were written, as in 023.
-- user_id is null when the database acted on its own: a coordinator changed the
-- lines while the request was Under review, so the review ended (037's
-- functions do not know about reviews, so the triggers below record it).

create table if not exists equipment_review_history (
  id                    bigint generated always as identity primary key,
  equipment_request_id  uuid not null references equipment_requests(id),
  equipment_line_id     uuid references equipment_lines(id),
  action                text not null,
  user_id               uuid references auth.users(id),
  from_user_id          uuid references auth.users(id),
  note                  text,
  created_at            timestamptz not null default now(),

  constraint equipment_review_history_action_known
    check (action in (
      'started', 'taken_over', 'line_marked', 'line_unmarked',
      'completed', 'arranged', 'interrupted', 'line_reset'
    ))
);

create index if not exists equipment_review_history_request_idx
  on equipment_review_history (equipment_request_id, created_at desc, id desc);

alter table equipment_review_history enable row level security;


-- ---------------------------------------------------------------------
-- 4. Triggers that keep a review honest
-- ---------------------------------------------------------------------
-- 037's functions send a request back to Pending review, or cancel it, without
-- knowing a review may be open. These keep the data consistent without
-- rewriting them.

-- Whenever the status is not Under review, there is no reviewer. If a review
-- was open and a coordinator's change ended it, say so in the history.
create or replace function equipment_request_review_fields()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'under_review' then
    if old.status = 'under_review' and new.status in ('pending_review', 'cancelled') then
      insert into equipment_review_history
        (equipment_request_id, action, user_id, from_user_id, note)
      values (
        new.id, 'interrupted', null, old.reviewer_id,
        case new.status
          when 'cancelled' then 'The request was cancelled during the review'
          else 'The lines were changed during the review'
        end
      );
    end if;
    new.reviewer_id := null;
    new.review_started_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists equipment_requests_review_fields on equipment_requests;
create trigger equipment_requests_review_fields
  before update on equipment_requests
  for each row execute function equipment_request_review_fields();

-- A line the coordinator changed has to be looked at again, so its outcome
-- goes (037's header asks for this).
create or replace function equipment_line_reset_outcome()
returns trigger
language plpgsql
as $$
begin
  if old.outcome is not null
     and (new.quantity is distinct from old.quantity
          or new.technical_notes is distinct from old.technical_notes) then
    insert into equipment_review_history
      (equipment_request_id, equipment_line_id, action, user_id, from_user_id, note)
    values
      (old.equipment_request_id, old.id, 'line_reset', null, old.outcome_by,
       'The line was changed, so its outcome was cleared');
    new.outcome := null;
    new.outcome_note := null;
    new.outcome_by := null;
    new.outcome_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists equipment_lines_reset_outcome on equipment_lines;
create trigger equipment_lines_reset_outcome
  before update on equipment_lines
  for each row execute function equipment_line_reset_outcome();


-- ---------------------------------------------------------------------
-- 5. Small helpers
-- ---------------------------------------------------------------------

-- Units live reservations hold for a line.
create or replace function equipment_line_reserved(p_line_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(quantity), 0)::integer
    from equipment_reservations
   where equipment_line_id = p_line_id
     and released_at is null;
$$;

create or replace function equipment_request_status_words(p_status text)
returns text
language sql
immutable
as $$
  select case p_status
           when 'pending_review'           then 'Pending review'
           when 'under_review'             then 'Under review'
           when 'arranged'                 then 'Arranged'
           when 'cannot_be_fully_arranged' then 'Cannot be fully arranged'
           when 'cancelled'                then 'Cancelled'
           else p_status
         end;
$$;

-- Locks the event row, then its current equipment request (the latest one that
-- is not cancelled), and returns that request.
create or replace function lock_equipment_request(p_event_request_id uuid)
returns equipment_requests
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  perform 1
     from event_requests
    where id = p_event_request_id
      for update;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
     and status <> 'cancelled'
   order by created_at desc, id desc
   limit 1
     for update;

  if not found then
    raise exception 'This event has no equipment request to review'
      using errcode = 'P0002';
  end if;

  return v_request;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Reading a request for review
-- ---------------------------------------------------------------------
-- The event fields AC4 names and nothing else from the event, the request's
-- status and reviewer, and for each line its type, quantity, notes, reserved
-- quantity, outcome and the availability result for the event's period with the
-- event's own reservations excluded (equipment_availability, 024). The result is
-- null when the event has no usable period yet.
-- stable, so viewing a request can never change it (AC2).

create or replace function equipment_review_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event   event_requests%rowtype;
  v_request equipment_requests%rowtype;
  v_has_period boolean;
begin
  select * into v_event from event_requests where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  -- Order is not checked here: event_requests already refuses an end that is not
  -- after the start (001, event_requests_dates_ordered).
  v_has_period := v_event.proposed_start is not null
              and v_event.proposed_end is not null;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id',                      v_event.id,
      'name',                    v_event.event_name,
      'proposed_start',          v_event.proposed_start,
      'proposed_end',            v_event.proposed_end,
      'assigned_coordinator_id', v_event.assigned_coordinator_id
    ),
    'request', jsonb_build_object(
      'id',                v_request.id,
      'status',            v_request.status,
      'reviewer_id',       v_request.reviewer_id,
      'review_started_at', v_request.review_started_at,
      'created_at',        v_request.created_at,
      'updated_at',        v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'outcome_by',        l.outcome_by,
                   'outcome_at',        l.outcome_at,
                   'availability',      case when v_has_period then
                                          equipment_availability(
                                            l.equipment_type_id,
                                            v_event.proposed_start,
                                            v_event.proposed_end,
                                            v_event.id)
                                        end
                 )
                 order by t.name, l.id
               )
          from equipment_lines l
          join equipment_types t on t.id = l.equipment_type_id
         where l.equipment_request_id = v_request.id
           and l.removed_at is null
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- 037's read for the coordinator, with each line's reserved quantity and any
-- "Cannot be provided" note added (AC8). Same name and arguments as 037, so this
-- replaces it. Do not run 037 again after this file.
create or replace function equipment_for_event(p_event_request_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_request equipment_requests%rowtype;
begin
  select * into v_request
    from equipment_requests
   where event_request_id = p_event_request_id
   order by (status = 'cancelled'), created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('request', null);
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id',         v_request.id,
      'status',     v_request.status,
      'created_at', v_request.created_at,
      'updated_at', v_request.updated_at,
      'lines', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',                l.id,
                   'equipment_type_id', l.equipment_type_id,
                   'name',              t.name,
                   'quantity',          l.quantity,
                   'technical_notes',   l.technical_notes,
                   'type_retired',      t.retired_at is not null,
                   'reserved',          equipment_line_reserved(l.id),
                   'outcome',           l.outcome,
                   'outcome_note',      l.outcome_note,
                   'created_at',        l.created_at,
                   'updated_at',        l.updated_at
                 )
                 order by t.name, l.id
               )
          from equipment_lines l
          join equipment_types t on t.id = l.equipment_type_id
         where l.equipment_request_id = v_request.id
           and l.removed_at is null
      ), '[]'::jsonb)
    )
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 7. Start a review
-- ---------------------------------------------------------------------
-- Two staff starting at the same moment: both take the event row's lock in
-- turn, so the second sees Under review and is refused. Exactly one succeeds.

create or replace function start_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'Only Technical Support Staff can review equipment requests'
      using errcode = '42501';
  end if;

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status = 'under_review' then
    raise exception
      'This equipment request is already Under review. Take over the review instead.'
      using errcode = '55000';
  end if;

  if v_request.status not in ('pending_review', 'cannot_be_fully_arranged') then
    raise exception
      'A review can only start when the request is Pending review or Cannot be fully arranged. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  update equipment_requests
     set status = 'under_review',
         reviewer_id = p_user_id,
         review_started_at = now()
   where id = v_request.id
     and status in ('pending_review', 'cannot_be_fully_arranged');

  if not found then
    raise exception 'The equipment request changed while the review was being started'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'started', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 8. Take over a review
-- ---------------------------------------------------------------------
-- Replaces the reviewer and records who it was taken from. The time the review
-- started stays as it was.

create or replace function take_over_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'Only Technical Support Staff can review equipment requests'
      using errcode = '42501';
  end if;

  v_request := lock_equipment_request(p_event_request_id);

  if v_request.status <> 'under_review' then
    raise exception
      'A review can only be taken over while the request is Under review. This request is %.',
      equipment_request_status_words(v_request.status::text)
      using errcode = '55000';
  end if;

  if v_request.reviewer_id = p_user_id then
    raise exception 'You are already reviewing this request'
      using errcode = '55000';
  end if;

  update equipment_requests
     set reviewer_id = p_user_id
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being taken over'
      using errcode = '40001';
  end if;

  insert into equipment_review_history
    (equipment_request_id, action, user_id, from_user_id)
  values (v_request.id, 'taken_over', p_user_id, v_request.reviewer_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 9. The reviewer-only guard for outcomes
-- ---------------------------------------------------------------------
-- Used by the three functions below. Only the current reviewer records
-- outcomes or completes the review (AC3).

create or replace function assert_current_reviewer(
  p_request equipment_requests,
  p_user_id uuid
)
returns void
language plpgsql
as $$
begin
  if p_request.status <> 'under_review' then
    raise exception
      'This can only be done while the request is Under review. This request is %.',
      equipment_request_status_words(p_request.status::text)
      using errcode = '55000';
  end if;

  if p_user_id is null or p_request.reviewer_id is distinct from p_user_id then
    raise exception 'Only the current reviewer can do this'
      using errcode = '42501';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 10. Mark a line "Cannot be provided"
-- ---------------------------------------------------------------------
-- The note is required and says what is missing (AC7). A line that is already
-- fully reserved can be provided, so it cannot be marked. Marking again replaces
-- the note.

create or replace function mark_equipment_line_unavailable(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid,
  p_note             text
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_line    equipment_lines%rowtype;
  v_note    text := nullif(btrim(p_note), '');
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  if v_note is null then
    raise exception 'A note is required: say what is missing'
      using errcode = '22023';
  end if;

  if equipment_line_reserved(v_line.id) >= v_line.quantity then
    raise exception 'This line is already fully reserved, so it can be provided'
      using errcode = '55000';
  end if;

  update equipment_lines
     set outcome = 'cannot_be_provided',
         outcome_note = v_note,
         outcome_by = p_user_id,
         outcome_at = now()
   where id = v_line.id;

  insert into equipment_review_history
    (equipment_request_id, equipment_line_id, action, user_id, note)
  values (v_request.id, v_line.id, 'line_marked', p_user_id, v_note);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 11. Take the mark off a line
-- ---------------------------------------------------------------------
-- A line that is not marked is left alone and nothing is recorded.

create or replace function clear_equipment_line_outcome(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_line_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_line    equipment_lines%rowtype;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select * into v_line
    from equipment_lines
   where id = p_line_id
     and equipment_request_id = v_request.id
     and removed_at is null
     for update;

  if not found then
    raise exception 'Equipment line not found' using errcode = 'P0002';
  end if;

  if v_line.outcome is null then
    return equipment_review_for_event(p_event_request_id);
  end if;

  update equipment_lines
     set outcome = null,
         outcome_note = null,
         outcome_by = null,
         outcome_at = null
   where id = v_line.id;

  insert into equipment_review_history
    (equipment_request_id, equipment_line_id, action, user_id)
  values (v_request.id, v_line.id, 'line_unmarked', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 12. Complete a review
-- ---------------------------------------------------------------------
-- Needs at least one line that is not fully reserved (if every line is, the
-- request is already Arranged), and every such line must carry a note, or the
-- call is refused naming the lines without one. Reservations are kept. Any
-- line that has since become fully reserved loses a stale mark.

create or replace function complete_equipment_review(
  p_event_request_id uuid,
  p_user_id          uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_short   integer;
  v_missing text[];
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select count(*),
         coalesce(array_agg(t.name order by t.name) filter (where l.outcome is null), '{}')
    into v_short, v_missing
    from equipment_lines l
    join equipment_types t on t.id = l.equipment_type_id
   where l.equipment_request_id = v_request.id
     and l.removed_at is null
     and equipment_line_reserved(l.id) < l.quantity;

  if v_short = 0 then
    raise exception
      'Every line is fully reserved, so there is nothing to complete. Reserve the last line to arrange the request.'
      using errcode = '55000';
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'Add a note to each line that cannot be provided. Missing a note: %',
      array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  update equipment_lines l
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where l.equipment_request_id = v_request.id
     and l.outcome is not null
     and (l.removed_at is not null or equipment_line_reserved(l.id) >= l.quantity);

  update equipment_requests
     set status = 'cannot_be_fully_arranged'
   where id = v_request.id
     and status = 'under_review';

  if not found then
    raise exception 'The equipment request changed while the review was being completed'
      using errcode = '40001';
  end if;

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'completed', p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 13. The automatic Arranged transition (AC6)
-- ---------------------------------------------------------------------
-- Called by SCRUM-300's reservation function after every reservation change,
-- inside that function, so the reservation and this check succeed or fail
-- together. The caller already holds the event and request locks; the request
-- row is locked again here, which costs nothing, so a call from anywhere else is
-- still safe. Returns true when the request became Arranged, false when it did
-- not (not Under review, no lines, or a line still short). Marks left on lines
-- are cleared: every line is now provided.

create or replace function arrange_equipment_request_if_complete(
  p_equipment_request_id uuid,
  p_user_id              uuid
)
returns boolean
language plpgsql
as $$
declare
  v_request equipment_requests%rowtype;
  v_lines   integer;
  v_short   integer;
begin
  select * into v_request
    from equipment_requests
   where id = p_equipment_request_id
     for update;

  if not found or v_request.status <> 'under_review' then
    return false;
  end if;

  select count(*),
         count(*) filter (where equipment_line_reserved(l.id) < l.quantity)
    into v_lines, v_short
    from equipment_lines l
   where l.equipment_request_id = v_request.id
     and l.removed_at is null;

  if v_lines = 0 or v_short > 0 then
    return false;
  end if;

  update equipment_lines
     set outcome = null, outcome_note = null, outcome_by = null, outcome_at = null
   where equipment_request_id = v_request.id
     and outcome is not null;

  update equipment_requests
     set status = 'arranged'
   where id = v_request.id
     and status = 'under_review';

  insert into equipment_review_history (equipment_request_id, action, user_id)
  values (v_request.id, 'arranged', p_user_id);

  return true;
end;
$$;