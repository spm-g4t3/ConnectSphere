// A Supabase-client stand-in for attendeeEventService that runs the SQL
// equivalent of its PostgREST reads on PGlite. Shared so every database test of
// SCRUM-24 checks the same columns and joins; hosted relationship resolution
// still needs E2E verification.
import { expect } from 'vitest';

const LIST_COLUMNS = 'event_request_id, attendee_id, status, event_requests!inner(id, event_name)';
const DETAIL_COLUMNS = 'id,event_request_id,attendee_id,status,'
  + 'event_requests!inner(id,event_name,status,proposed_start,proposed_end,bookings(id,status,venues(name,location)))';

export function createAttendeeEventSqlClient(db, { onQuery = () => {} } = {}) {
  return {
    from(table) {
      expect(table).toBe('event_registrations');
      const filters = [];
      let isList = false;
      const values = () => filters.map(([, value]) => value);
      const query = {
        select(columns) {
          isList = columns === LIST_COLUMNS;
          if (!isList) expect(columns.replace(/\s+/g, '')).toBe(DETAIL_COLUMNS);
          return query;
        },
        eq(field, value) { filters.push([field, value]); return query; },
        order() { return query; },
        async range(first, last) {
          expect(isList).toBe(true);
          expect(filters.map(([field]) => field)).toEqual(['attendee_id', 'status']);
          onQuery();
          const { rows } = await db.query(`
            select r.attendee_id, r.event_request_id, r.status,
              jsonb_build_object('id', e.id, 'event_name', e.event_name) as event_requests
            from event_registrations r join event_requests e on e.id = r.event_request_id
            where r.attendee_id = $1 and r.status = $2
            order by r.registered_at desc, r.id asc limit $3 offset $4
          `, [...values(), last - first + 1, first]);
          return { data: rows, error: null };
        },
        async maybeSingle() {
          expect(filters.map(([field]) => field)).toEqual(['attendee_id', 'event_request_id', 'status']);
          onQuery();
          try {
            const { rows: [data = null] } = await db.query(`
              select r.id, r.attendee_id, r.event_request_id, r.status,
                jsonb_build_object('id', e.id, 'event_name', e.event_name, 'status', e.status,
                  'proposed_start', e.proposed_start, 'proposed_end', e.proposed_end,
                  'bookings', coalesce((
                    select jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status,
                      'venues', jsonb_build_object('name', v.name, 'location', v.location)) order by b.id)
                    from bookings b join venues v on v.id = b.venue_id
                    where b.event_request_id = e.id
                  ), '[]'::jsonb)) as event_requests
              from event_registrations r join event_requests e on e.id = r.event_request_id
              where r.attendee_id = $1 and r.event_request_id = $2 and r.status = $3
            `, values());
            return { data, error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
      };
      return query;
    },
  };
}
