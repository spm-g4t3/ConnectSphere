-- 044_event_cancellation_impact_preview.sql
-- SCRUM-373: read-only cancellation impact preview.
--
-- Run after 011_venue_blocks.sql, 022_equipment_schema.sql,
-- 027_booking_request_statuses.sql and 043_release_event_arrangements.sql.
--
-- Present in the preview:
--   * approved and flagged venue bookings
--   * pending venue booking requests
--   * equipment requests, their lines and active reservations
--
-- Not included because no corresponding tables exist in this repository:
--   * separate tentative venue holds
--   * on-site support assignments
--   * registrations
--
-- The function is STABLE and contains only reads. Counts and details use the
-- same live-state filters as release_event_arrangements().

create or replace function event_cancellation_impact_preview(
  p_event_request_id uuid
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_preview jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event request id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (
    select 1
      from event_requests
     where id = p_event_request_id
  ) then
    raise exception 'Event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  select jsonb_build_object(
    'eventRequestId', p_event_request_id,
    'venueBookings', jsonb_build_object(
      'count', (
        select count(*)::integer
          from bookings b
         where b.event_request_id = p_event_request_id
           and b.status in ('approved', 'flagged_for_review')
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'status', b.status::text,
            'venueId', b.venue_id,
            'venueName', v.name,
            'venueLocation', v.location,
            'startsAt', b.starts_at,
            'endsAt', b.ends_at
          )
          order by b.starts_at, b.id
        )
          from bookings b
          join venues v on v.id = b.venue_id
         where b.event_request_id = p_event_request_id
           and b.status in ('approved', 'flagged_for_review')
      ), '[]'::jsonb)
    ),
    'bookingRequests', jsonb_build_object(
      'count', (
        select count(*)::integer
          from bookings b
         where b.event_request_id = p_event_request_id
           and b.status = 'pending'
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'status', b.status::text,
            'venueId', b.venue_id,
            'venueName', v.name,
            'venueLocation', v.location,
            'startsAt', b.starts_at,
            'endsAt', b.ends_at
          )
          order by b.starts_at, b.id
        )
          from bookings b
          join venues v on v.id = b.venue_id
         where b.event_request_id = p_event_request_id
           and b.status = 'pending'
      ), '[]'::jsonb)
    ),
    'equipmentRequests', jsonb_build_object(
      'count', (
        select count(*)::integer
          from equipment_requests r
         where r.event_request_id = p_event_request_id
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'status', r.status::text,
            'createdAt', r.created_at,
            'lines', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', l.id,
                  'equipmentTypeId', l.equipment_type_id,
                  'equipmentName', t.name,
                  'quantity', l.quantity,
                  'technicalNotes', l.technical_notes
                )
                order by t.name, l.id
              )
                from equipment_lines l
                join equipment_types t on t.id = l.equipment_type_id
               where l.equipment_request_id = r.id
            ), '[]'::jsonb)
          )
          order by r.created_at, r.id
        )
          from equipment_requests r
         where r.event_request_id = p_event_request_id
      ), '[]'::jsonb)
    ),
    'equipmentReservations', jsonb_build_object(
      'count', (
        select count(*)::integer
          from equipment_reservations r
         where r.event_request_id = p_event_request_id
           and r.released_at is null
      ),
      'details', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'equipmentTypeId', r.equipment_type_id,
            'equipmentName', t.name,
            'equipmentLineId', r.equipment_line_id,
            'quantity', r.quantity,
            'startsAt', r.start_at,
            'endsAt', r.end_at,
            'flagged', r.flagged
          )
          order by r.start_at, t.name, r.id
        )
          from equipment_reservations r
          join equipment_types t on t.id = r.equipment_type_id
         where r.event_request_id = p_event_request_id
           and r.released_at is null
      ), '[]'::jsonb)
    )
  )
    into v_preview;

  return v_preview;
end;
$$;

notify pgrst, 'reload schema';
