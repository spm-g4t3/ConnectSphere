-- 090_equipment_reserve_in_safety_statuses.sql
-- SCRUM-300 AC1, amended: a reviewer may reserve, reduce, release, move and keep
-- reservations while the event is Approved, in Safety review, Safety approved or
-- Confirmed.
--
-- Run after 062 and 089. Safe to run twice.
--
-- SCRUM-488 put the two safety statuses between Approved and Confirmed, and 053
-- left them out ("add them once SCRUM-488 adds them"). With them out, a
-- reservation flagged in a safety status (a type retired, fewer usable units)
-- could not be resolved, so its request could not become Arranged until the event
-- moved on. Every reservation action reads this one list, so this is the only
-- place to change. Text, not the enum, as in 053.

create or replace function equipment_reservable_event_statuses()
returns text[]
language sql
immutable
as $$
  select array['approved', 'safety_review', 'safety_approved', 'confirmed']::text[];
$$;

-- Same as 053 except the refusal now names the statuses from the list above, so
-- a later change to the list cannot leave the message out of date.
create or replace function assert_event_allows_reservations(p_event_request_id uuid)
returns void
language plpgsql
as $$
declare
  v_status  text;
  v_labels  text[];
  v_allowed text;
begin
  select status::text into v_status
    from event_requests
   where id = p_event_request_id;

  if not found then
    raise exception 'Event request not found' using errcode = 'P0002';
  end if;

  if not (v_status = any (equipment_reservable_event_statuses())) then
    -- 'safety_review' -> 'Safety review', in the list's order.
    select array_agg(upper(left(w, 1)) || substr(w, 2) order by n)
      into v_labels
      from (select replace(s, '_', ' ') as w, n
              from unnest(equipment_reservable_event_statuses()) with ordinality as t(s, n)) x;

    v_allowed := case
      when cardinality(v_labels) = 1 then v_labels[1]
      else array_to_string(v_labels[1:cardinality(v_labels) - 1], ', ') || ' or ' || v_labels[cardinality(v_labels)]
    end;

    raise exception
      'Equipment can only be reserved while the event is %. This event is %.',
      v_allowed, equipment_event_status_words(v_status)
      using errcode = '55000';
  end if;
end;
$$;
