-- Migration 039: SCRUM-402's two notice types put back, SCRUM-347's
-- rejected-event refusal moved under the event lock, and an event's open change
-- requests closed on every path to Rejected. Re-runnable.

-- ---------------------------------------------------------------------
-- 1. create_change_request_group, restated from 036
-- ---------------------------------------------------------------------
-- 036's definition, with one refusal added after the draft check: SCRUM-347's
-- rule that a rejected event takes no change requests, which was checked only in
-- Express, outside the lock. Same SQLSTATE as the draft refusal, so the API answers 400.
create or replace function create_change_request_group(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_changes          jsonb,
  p_note             text default null
)
returns setof event_change_requests
language plpgsql
set search_path = public
as $$
declare
  v_event event_requests;
  v_item jsonb;
  v_field text;
  v_group uuid;
  v_row event_change_requests;
  v_fields text[] := '{}';
  v_significant text[] := '{}';
  v_note text := nullif(btrim(p_note), '');
begin
  select * into v_event
    from event_requests
   where id = p_event_request_id
   for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if p_organiser_id is null or v_event.organiser_id is distinct from p_organiser_id then
    raise exception 'Only the event organiser may request a change to this event'
      using errcode = '22023';
  end if;
  if v_event.status = 'draft' then
    raise exception 'Cannot request a change to a draft event; submit it first'
      using errcode = '22023';
  end if;
  -- SCRUM-347: a rejected event is revised by reopening it, not by change requests,
  -- which rejection closes and nobody could process after a reopen.
  if v_event.status = 'rejected' then
    raise exception 'Cannot request a change to a rejected event; revise and resubmit it instead'
      using errcode = '22023';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 9 then
    raise exception 'A change request names 1 to 9 changes'
      using errcode = '22023';
  end if;
  if length(v_note) > 2000 then
    raise exception 'The note must be 2,000 characters or fewer'
      using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_changes) loop
    v_field := v_item ->> 'changeField';
    if v_field is null or not (v_field = any (enum_range(null::event_change_field)::text[])) then
      raise exception 'Unknown change field: %', coalesce(v_field, 'none')
        using errcode = '22023';
    end if;
    if v_field = any (v_fields) then
      raise exception 'Each field can be changed once per request: %', v_field
        using errcode = '22023';
    end if;
    if nullif(btrim(v_item ->> 'requestedChange'), '') is null then
      raise exception 'requestedChange cannot be blank for %', v_field
        using errcode = '22023';
    end if;
    v_fields := v_fields || v_field;
  end loop;
  -- D8: what accepting a cancellation together with a field change means is undefined.
  if 'cancellation' = any (v_fields) and cardinality(v_fields) > 1 then
    raise exception 'A cancellation request cannot be combined with other changes'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_changes) loop
    insert into event_change_requests
      (event_request_id, requested_by, change_field, requested_change, request_group_id, organiser_note)
    values (
      p_event_request_id, p_organiser_id,
      (v_item ->> 'changeField')::event_change_field,
      btrim(v_item ->> 'requestedChange'),
      v_group,
      v_note
    )
    returning * into v_row;
    v_group := coalesce(v_group, v_row.request_group_id);
    if change_request_field_class(v_row.change_field::text) in ('significant', 'equipment') then
      v_significant := v_significant || v_row.change_field::text;
    end if;
    return next v_row;
  end loop;

  -- AC12 (W1 §6): the holder hears of a significant change; with nobody assigned
  -- the Lead's queue already shows the request.
  if cardinality(v_significant) > 0 and v_event.assigned_coordinator_id is not null then
    insert into notifications (recipient_id, type, event_request_id, payload)
    values (
      v_event.assigned_coordinator_id,
      'change_request_significant_submitted',
      p_event_request_id,
      jsonb_build_object(
        'eventRequestId', p_event_request_id,
        'eventName', v_event.event_name,
        'changeRequestId', v_group,
        'changeFields', to_jsonb(v_fields)
      )
    );
  end if;
  return;
end;
$$;
revoke execute on function create_change_request_group(uuid, uuid, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Rejection closes the event's open change requests
-- ---------------------------------------------------------------------
-- Only reject_approved_event (029) closed them; a rejection from Under review
-- (decide_event_request, 032) left them Outstanding on an event where AC2 refuses
-- to process them. A trigger covers every path without restating either
-- function, and 029's own update then finds nothing left to close.
create or replace function close_change_requests_on_rejection()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update event_change_requests
     set status = 'processed',
         decision = 'event_rejected',
         decision_notes = null,
         processed_by = coalesce(new.reviewing_coordinator_id, new.assigned_coordinator_id)
   where event_request_id = new.id
     and status in ('outstanding', 'in_progress');
  return null;
end;
$$;
revoke execute on function close_change_requests_on_rejection() from public, anon, authenticated;

drop trigger if exists event_requests_close_change_requests_on_rejection on event_requests;
create trigger event_requests_close_change_requests_on_rejection
  after update of status on event_requests
  for each row
  when (new.status::text = 'rejected' and old.status::text <> 'rejected')
  execute function close_change_requests_on_rejection();

-- ---------------------------------------------------------------------
-- 3. The two notice types, appended to the live list
-- ---------------------------------------------------------------------
-- 036 appended change_request_decided and change_request_significant_submitted
-- to the live list, then 024, 032 and 037 ran on live and each restated the list
-- whole without them, so every insert of either notice failed the check (23514).
-- Any later migration that restates notifications_type_known whole must include
-- both types, or append to the live list as this block does.
--
-- 036's block: it reads the live list back and adds only what it lacks, so it
-- works on any list and does nothing when both are present.
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
    raise exception 'notifications_type_known is missing; restore it before 039';
  end if;

  v_types := array(select m[1] from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m);
  v_missing := array(
    select t from unnest(array['change_request_decided', 'change_request_significant_submitted']) as t
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
