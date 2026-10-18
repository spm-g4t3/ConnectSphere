-- Keep safety submission and confirmation on the same read-only checklist.
create or replace function event_readiness(
  p_event_request_id       uuid,
  p_no_equipment_confirmed boolean default false
)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_event        event_requests;
  v_items        jsonb := '[]'::jsonb;
  v_booking      record;
  v_equipment    record;
  v_any_booking  boolean := false;
  v_any_request  boolean := false;
  v_covers       boolean;
  v_now          timestamptz;
begin
  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    raise exception 'event request % not found', p_event_request_id using errcode = 'P0002';
  end if;

  for v_booking in
    select b.id, b.status::text as status, b.starts_at, b.ends_at, v.name as venue_name
      from bookings b
      join venues v on v.id = b.venue_id
     where b.event_request_id = p_event_request_id
       and b.status::text in ('pending', 'conflicting', 'approved', 'flagged_for_review')
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
                     when v_booking.status = 'conflicting'        then 'Conflicting, awaiting a decision'
                     when v_booking.status = 'flagged_for_review' then 'Flagged for review'
                     when not v_covers                            then 'Does not cover the event''s start to end'
                     else 'Approved'
                   end,
      'bookingId', v_booking.id,
      'venueName', v_booking.venue_name,
      'startsAt',  v_booking.starts_at,
      'endsAt',    v_booking.ends_at
    ));
  end loop;

  if not v_any_booking then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key', 'venue', 'met', false, 'detail', 'No venue booking'));
  end if;

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
    -- btrim alone misses tabs and line breaks in otherwise blank requirements.
    if coalesce(v_event.equipment_requirements, '') !~ '[^[:space:]]' then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key', 'equipment', 'met', true, 'detail', 'No equipment requested'));
    else
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'key',                   'no_equipment_confirmation',
        'met',                   coalesce(p_no_equipment_confirmed, false),
        'detail',                'Confirm that this event needs no equipment',
        'organiserRequirements', v_event.equipment_requirements
      ));
    end if;
  end if;

  -- Recheck the wall clock when called inside a transaction that may have waited.
  v_now := clock_timestamp();
  v_items := v_items || jsonb_build_array(jsonb_build_object(
    'key',    'date',
    'met',    v_event.proposed_start is not null and v_event.proposed_end is not null
              and v_now < v_event.proposed_start,
    'detail', case
                when v_event.proposed_start is null then 'The event has no start date'
                when v_event.proposed_end is null   then 'The event has no end date'
                when v_event.proposed_start <= v_now then 'The event''s start has passed'
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
grant execute on function event_readiness(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
