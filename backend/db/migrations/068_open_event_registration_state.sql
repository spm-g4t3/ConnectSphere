-- 068_open_event_registration_state.sql
-- Places taken and the caller's own registration, counted in the database so
-- PostgREST's 1,000-row cap cannot cut a count short. Returns one row per event
-- that has registrations. Needs the `registrations` table only when called.
-- Only 'registered' holds a place. p_attendee_id must be an attendee (42501),
-- and execute is revoked from public, anon and authenticated (as 030): only the
-- API's secret key calls it. The route checks the role too; both must agree.

create or replace function open_event_registration_state(
  p_event_ids   uuid[],
  p_attendee_id uuid
)
returns table (
  event_request_id uuid,
  active_count     bigint,
  is_registered    boolean
)
language plpgsql
stable
as $$
begin
  if p_attendee_id is null then
    raise exception 'An attendee is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from profiles p
     where p.id = p_attendee_id
       and p.role = 'attendee'
  ) then
    raise exception 'Only an attendee may read registration state'
      using errcode = '42501';
  end if;

  return query
    select r.event_request_id,
           count(*),
           coalesce(bool_or(r.attendee_id = p_attendee_id), false)
      from registrations r
     where r.event_request_id = any (coalesce(p_event_ids, '{}'::uuid[]))
       and r.status = 'registered'
     group by r.event_request_id;
end;
$$;

revoke execute on function open_event_registration_state(uuid[], uuid)
  from public, anon, authenticated;
