-- 064_safety_review_submission.sql
-- SCRUM-489 (SCRUM-555, SCRUM-556): the readiness check shared with SCRUM-363,
-- and submitting an Approved event for the Operational Safety Check.
--
-- Run after 063 (it moves events into 062's safety_review, through 063's
-- approved -> safety_review). Safe to re-run: create or replace, if not exists,
-- drop-then-add for the constraint and the trigger.
--
-- SQLSTATEs, and the API's answer:
--   22004 null event id (500: the API never sends one)   42501 not the holder (403)
--   P0002 no such event (404)                            55000 not Approved (409)
--   22023 note over 2,000 characters (400)               40001 changed under us (409)
--   PT409 hint EVENT_NOT_READY, DETAIL the outstanding lines as JSON (409)
-- Decisions and their alternatives: docs/test-cases/SCRUM-489.md.
--
-- After running it in Supabase, read-only:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_type_known';
--   select event_readiness(id) from event_requests where status = 'approved' limit 1;


-- ---------------------------------------------------------------------
-- 1. The readiness check (D1 to D5)
-- ---------------------------------------------------------------------
-- Takes no locks: submit (below) and SCRUM-363's confirm lock the event, its
-- bookings and its equipment requests first, then call this.

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
       and b.status::text in ('pending', 'approved', 'flagged_for_review')
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


-- ---------------------------------------------------------------------
-- 2. The submissions (D7)
-- ---------------------------------------------------------------------

create table if not exists safety_review_submissions (
  id                     uuid primary key default gen_random_uuid(),
  event_request_id       uuid not null references event_requests (id) on delete cascade,
  submitted_by           uuid not null references auth.users (id),
  note                   text check (note is null or length(btrim(note)) between 1 and 2000),
  no_equipment_confirmed boolean not null default false,
  created_at             timestamptz not null default now()
);

create index if not exists idx_safety_review_submissions_event_created
  on safety_review_submissions (event_request_id, created_at);

alter table safety_review_submissions enable row level security;

-- A record of who sent the event and why: never edited, as 030's clarification history.
create or replace function refuse_safety_review_submission_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'safety review submissions cannot be changed or deleted' using errcode = '42501';
end;
$$;

drop trigger if exists safety_review_submissions_immutable on safety_review_submissions;
create trigger safety_review_submissions_immutable
  before update or delete on safety_review_submissions
  for each row execute function refuse_safety_review_submission_mutation();


-- ---------------------------------------------------------------------
-- 3. The notification type (D11)
-- ---------------------------------------------------------------------
-- 052's eleven, then SCRUM-490's three: 490's 058 restates the list with them and
-- is already applied on the live database, so leaving them out would delete them.

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
      'event_submitted_for_safety_review'
    )
  );


-- ---------------------------------------------------------------------
-- 4. Submitting for the safety check (D6 to D8, D11)
-- ---------------------------------------------------------------------

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
  select p.id,
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
    from profiles p
   where p.role = 'safety_officer';

  return v_request;
end;
$$;

revoke execute on function submit_event_for_safety_review(uuid, uuid, text, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
