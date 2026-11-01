-- Migration 030: the read-only registration list for an event's organiser and
-- assigned coordinator. Read only: nothing here writes a registration.

create or replace function list_event_registrations(
  p_event_request_id uuid,
  p_user_id          uuid,
  p_hide_withdrawn   boolean default false
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_event event_requests;
  v_role user_role;
  v_registered bigint;
  v_entries jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  select role into v_role from profiles where id = p_user_id;

  select * into v_event from event_requests where id = p_event_request_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- An organiser may not learn that another organiser's event exists, so they
  -- get not_found; coordinators already see every event, so theirs is forbidden.
  if v_role = 'event_organiser' then
    if v_event.organiser_id is distinct from p_user_id then
      return jsonb_build_object('outcome', 'not_found');
    end if;
  elsif v_role is distinct from 'event_coordinator'
     or v_event.assigned_coordinator_id is distinct from p_user_id then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  -- Registration needs a Confirmed event, so an Approved event has registrations
  -- only after a significant change took it back from Confirmed, the one move
  -- that writes confirmed -> approved.
  if not (
    v_event.status::text in ('confirmed', 'completed', 'cancelled')
    or (v_event.status::text = 'approved' and exists (
      select 1 from event_request_status_history h
       where h.event_request_id = v_event.id
         and h.previous_status = 'confirmed'
         and h.new_status = 'approved'
    ))
  ) then
    return jsonb_build_object('outcome', 'status_not_available', 'status', v_event.status);
  end if;

  -- Cancelling an event leaves its registrations 'registered'; the list shows
  -- them as cancelled without changing the stored rows. Emails live in
  -- auth.users, which service_role may not read, so the API adds them.
  with listed as (
    select r.id, r.attendee_id, r.registered_at, p.full_name,
           case when r.status = 'registered' and v_event.status::text = 'cancelled'
                then 'cancelled' else r.status end as status
      from event_registrations r
      left join profiles p on p.id = r.attendee_id
     where r.event_request_id = v_event.id
  )
  select count(*) filter (where status = 'registered'),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', id,
           'attendeeId', attendee_id,
           'attendeeName', full_name,
           'registeredAt', registered_at,
           'status', status
         ) order by registered_at, id)
           filter (where not (coalesce(p_hide_withdrawn, false) and status = 'withdrawn')), '[]'::jsonb)
    into v_registered, v_entries
    from listed;

  return jsonb_build_object(
    'outcome', 'listed',
    'event', jsonb_build_object(
      'id', v_event.id,
      'eventName', v_event.event_name,
      'status', v_event.status,
      'capacity', v_event.registration_capacity
    ),
    'registeredCount', v_registered,
    'entries', v_entries
  );
end;
$$;
revoke execute on function list_event_registrations(uuid, uuid, boolean) from public, anon, authenticated;
