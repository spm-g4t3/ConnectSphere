-- 068's version read a `registrations` table that is never created; this one
-- reads event_registrations from 050.

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
      from event_registrations r
     where r.event_request_id = any (coalesce(p_event_ids, '{}'::uuid[]))
     group by r.event_request_id;
end;
$$;

revoke execute on function open_event_registration_state(uuid[], uuid)
  from public, anon, authenticated;
