-- 065_pending_booking_requests.sql
-- SCRUM-259 (SCRUM-258 AC1): the Venue Staff queue of pending booking requests,
-- oldest first, each with the other pending requests that clash with it.
--
-- Read-only. Pending requests never block each other (first come, first
-- served), so the overlaps are shown for the decision, not enforced here.
--
-- SQLSTATEs, mapped by translateError:
--   42501  the caller is null, or does not hold venue_staff  403


-- ---------------------------------------------------------------------
-- 1. pending_request_overlaps
-- ---------------------------------------------------------------------
-- The one home of "which pending requests overlap this period": the list
-- below asks it, and so will approval (SCRUM-261). venue_occupancy_conflicts
-- (040) deliberately never counts a pending request as an occupant.
--
-- Both periods are padded by venue_occupied_period() (032) with the venue's
-- minutes and compared with &&: half-open, so touching is no clash. Requests
-- of p_exclude_event_id are left out; null excludes nothing.

create or replace function pending_request_overlaps(
  p_venue_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_exclude_event_id  uuid
)
returns table (
  id                 uuid,
  event_request_id   uuid,
  event_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  occupied_starts_at timestamptz,
  occupied_ends_at   timestamptz,
  created_at         timestamptz
)
language sql
stable
as $$
  with requested as (
    select v.id,
           v.setup_minutes::integer      as setup_minutes,
           v.turnaround_minutes::integer as turnaround_minutes,
           venue_occupied_period(p_starts_at, p_ends_at,
                                 v.setup_minutes, v.turnaround_minutes) as period
      from venues v
     where v.id = p_venue_id
  ),
  pending as (
    select b.id,
           b.event_request_id,
           er.event_name,
           b.starts_at,
           b.ends_at,
           b.created_at,
           venue_occupied_period(b.starts_at, b.ends_at,
                                 req.setup_minutes, req.turnaround_minutes) as occupied,
           req.period
      from requested req
      join bookings b
        on b.venue_id = req.id
      join event_requests er
        on er.id = b.event_request_id
     where b.status = 'pending'
       and b.event_request_id is distinct from p_exclude_event_id
  )
  select p.id,
         p.event_request_id,
         p.event_name,
         p.starts_at,
         p.ends_at,
         lower(p.occupied),
         upper(p.occupied),
         p.created_at
    from pending p
   where p.occupied && p.period
   order by p.created_at, p.id;
$$;

revoke execute on function pending_request_overlaps(uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. list_pending_booking_requests
-- ---------------------------------------------------------------------
-- A jsonb array, '[]' when nothing is pending, as the other jsonb readers
-- answer. Each element is one request; `overlapping` is what
-- pending_request_overlaps (section 1) answers for it.

create or replace function list_pending_booking_requests(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as place_venue_hold (040) checks it. A null caller is
  -- refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view pending booking requests'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    with pending as (
      select b.*,
             er.event_name,
             er.status::text                      as event_status,
             v.name                               as venue_name,
             v.location                           as venue_location,
             venue_occupied_period(b.starts_at, b.ends_at,
                                   v.setup_minutes, v.turnaround_minutes) as occupied
        from bookings b
        join event_requests er on er.id = b.event_request_id
        join venues v          on v.id  = b.venue_id
       where b.status = 'pending'
    )
    select jsonb_agg(
             jsonb_build_object(
               'id',                         p.id,
               'event_request_id',           p.event_request_id,
               'event_name',                 p.event_name,
               'event_status',               p.event_status,
               'venue_id',                   p.venue_id,
               'venue_name',                 p.venue_name,
               'venue_location',             p.venue_location,
               'starts_at',                  p.starts_at,
               'ends_at',                    p.ends_at,
               'occupied_starts_at',         lower(p.occupied),
               'occupied_ends_at',           upper(p.occupied),
               'expected_attendance',        p.expected_attendance,
               'room_layout_code',           p.room_layout_code,
               'venue_requirements',         p.venue_requirements,
               'accessibility_requirements', p.accessibility_requirements,
               'setup_notes',                p.setup_notes,
               'suitability_result',         p.suitability_result,
               'suitability_overridden',     p.suitability_overridden,
               'requested_by',               p.requested_by,
               'created_at',                 p.created_at,
               -- Other events only, which also leaves this request out: 051
               -- refuses a second live request for the same event and venue,
               -- so a same-event clash is not a choice Venue Staff make.
               'overlapping', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',                 o.id,
                            'event_request_id',   o.event_request_id,
                            'event_name',         o.event_name,
                            'starts_at',          o.starts_at,
                            'ends_at',            o.ends_at,
                            'occupied_starts_at', o.occupied_starts_at,
                            'occupied_ends_at',   o.occupied_ends_at,
                            'created_at',         o.created_at
                          )
                          order by o.created_at, o.id
                        )
                   from pending_request_overlaps(p.venue_id, p.starts_at, p.ends_at,
                                                 p.event_request_id) o
               ), '[]'::jsonb)
             )
             order by p.created_at, p.id
           )
      from pending p
  ), '[]'::jsonb);
end;
$$;

-- As in 030, 040 and 051: only the API should reach this. Nothing is granted.
revoke execute on function list_pending_booking_requests(uuid)
  from public, anon, authenticated;


notify pgrst, 'reload schema';
