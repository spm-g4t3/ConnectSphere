-- 068_open_event_registration_state.sql
-- SCRUM-495: places taken and the caller's own registration, counted in the database
--
-- Run after 063. Safe to run twice.
--
-- The browse list used to read every registration row of the listed events and
-- count them in JavaScript. PostgREST returns at most 1,000 rows per request, so
-- a busy event could read as having free places, and the caller's own row could
-- be cut off. The event ids also travelled in the URL, which fails once a few
-- hundred events are open. This sends the ids in the request body and returns
-- one row per event.
--
-- Needs SCRUM-22's `registrations` table (event_request_id, attendee_id,
-- status). The body is not checked when the function is created, so this can be
-- run before that table exists; calling it before then fails.
-- Only 'registered' holds a place (ACTIVE_REGISTRATION_STATUS in
-- backend/src/domain/registrationAvailability.js).
--
-- The function trusts nothing but the database: p_attendee_id must be an
-- account whose role is attendee (42501 otherwise), and execute is revoked from
-- public, anon and authenticated, as for create_booking_request (030), so only
-- the API's secret key can call it. The route gates the role as well; both must
-- agree, so a caller cannot read another account's registrations by passing
-- its id.

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
