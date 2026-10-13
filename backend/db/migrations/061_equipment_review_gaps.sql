-- SCRUM-300: three gaps found reviewing 053 and 054. Redefines functions only,
-- so it is safe to run on top of 038, 053, 054, 055 and 060.
--
--   complete_equipment_review   refuses while a live reservation is flagged (AC7).
--                               053 gave arrange_equipment_request_if_complete that
--                               check but not this function, so a review could be
--                               completed over reservations nobody had decided on.
--   start_equipment_review      runs the Arranged check once the review is Under
--                               review. Removing the one short line leaves a request
--                               with everything reserved; with no reservation action
--                               left to run the check, it stuck Under review and
--                               complete_equipment_review refused it.
--   equipment_review_for_event  each live reservation carries can_keep: flagged and
--                               equipment_reservation_keep_problem finds nothing
--                               wrong. A date change flags a reservation whose
--                               period then never matches the event, so Keep can
--                               never work for it; the screen offers Keep only
--                               where it can.


-- ---------------------------------------------------------------------
-- 1. Complete review (038), refusing while a reservation is flagged
-- ---------------------------------------------------------------------
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
  v_flagged integer;
begin
  v_request := lock_equipment_request(p_event_request_id);
  perform assert_current_reviewer(v_request, p_user_id);

  select count(*) into v_flagged
    from equipment_reservations r
    join equipment_lines l on l.id = r.equipment_line_id
   where l.equipment_request_id = v_request.id
     and r.released_at is null
     and r.flagged;

  if v_flagged > 0 then
    raise exception
      'Decide on each flagged reservation before completing the review. Still to decide: %.',
      v_flagged
      using errcode = '55000';
  end if;

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
-- 2. Start review (038), arranging at once when nothing is short
-- ---------------------------------------------------------------------
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

  perform arrange_equipment_request_if_complete(v_request.id, p_user_id);

  return equipment_review_for_event(p_event_request_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. The review read (054), with can_keep on each reservation
-- ---------------------------------------------------------------------
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
                   'reservations',      coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',          r.id,
                                'quantity',    r.quantity,
                                'start_at',    r.start_at,
                                'end_at',      r.end_at,
                                'flagged',     r.flagged,
                                'flag_reason', r.flag_reason,
                                'flagged_at',  r.flagged_at,
                                'can_keep',    r.flagged
                                               and equipment_reservation_keep_problem(r, v_event, l) is null
                              )
                              order by r.start_at, r.id
                            )
                       from equipment_reservations r
                      where r.equipment_line_id = l.id
                        and r.released_at is null
                   ), '[]'::jsonb),
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
