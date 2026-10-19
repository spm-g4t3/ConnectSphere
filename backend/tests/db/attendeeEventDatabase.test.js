import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getAttendeeEvent, listAttendeeEvents } from '../../src/services/attendeeEventService.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const prerequisites = ['050_event_registration.sql', '082_event_registration_state.sql',
  '091_event_registration_hardening.sql', '092_event_registration_persistence.sql'];
const migrationPath = name => resolve(migrationsDir, name);
const migrations = [
  '001_event_requests.sql', '002_venues.sql', '003_venue_audit.sql',
  '004_venue_functions.sql', '005_venue_retirement.sql', '007_user_roles.sql',
  '008_venue_audit_completion.sql', '009_bookings.sql', '011_venue_blocks.sql',
  '013_venue_block_booking_conflicts.sql', '014_booking_review_notifications.sql',
  '017_venue_turnaround.sql', '023_venue_setup_time.sql',
  '021_event_status_history.sql', '025_event_request_decisions.sql',
  '027_booking_request_statuses.sql', '028_booking_status_default_pending.sql',
  '032_venue_occupancy.sql', '040_venue_holds.sql', '062_safety_statuses.sql',
  '065_booking_decision_statuses.sql', '088_booking_released_status.sql',
  prerequisites[0], '068_open_event_registration_state.sql', ...prerequisites.slice(1),
];
const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORGANISER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COORDINATOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const user = { id: ATTENDEE, role: 'attendee' };
const start = '2030-05-06T09:00:00+08:00';
const end = '2030-05-06T11:00:00+08:00';

describe('SCRUM-52 SQL read using repository migrations', () => {
  let db;
  let eventId;
  let queries;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  // PostgREST is not part of PGlite. Execute its nested-read equivalent as one
  // SQL statement against real tables; hosted relationship resolution needs E2E verification.
  const client = {
    from(table) {
      expect(table).toBe('event_registrations');
      const filters = [];
      let isList = false;
      const query = {
        select(columns) {
          isList = columns === 'event_request_id, attendee_id, status, event_requests!inner(id, event_name)';
          if (isList) return query;
          expect(columns.replace(/\s+/g, '')).toBe('event_request_id,attendee_id,status,'
            + 'event_requests!inner(id,status,proposed_start,proposed_end,bookings(id,status,venues(name,location)))');
          return query;
        },
        eq(field, value) { filters.push([field, value]); return query; },
        order() { return query; },
        async range(first, last) {
          expect(isList).toBe(true);
          expect(filters.map(([field]) => field)).toEqual(['attendee_id', 'status']);
          queries += 1;
          const { rows } = await db.query(`
            select r.attendee_id, r.event_request_id, r.status,
              jsonb_build_object('id', e.id, 'event_name', e.event_name) as event_requests
            from event_registrations r join event_requests e on e.id = r.event_request_id
            where r.attendee_id = $1 and r.status = $2
            order by r.registered_at desc, r.id asc limit $3 offset $4
          `, [...filters.map(([, value]) => value), last - first + 1, first]);
          return { data: rows, error: null };
        },
        async maybeSingle() {
          expect(filters.map(([field]) => field)).toEqual(['attendee_id', 'event_request_id', 'status']);
          queries += 1;
          try {
            const data = await one(`
              select r.attendee_id, r.event_request_id, r.status,
                jsonb_build_object('id', e.id, 'status', e.status,
                  'proposed_start', e.proposed_start, 'proposed_end', e.proposed_end,
                  'bookings', coalesce((
                    select jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status,
                      'venues', jsonb_build_object('name', v.name, 'location', v.location)) order by b.id)
                    from bookings b join venues v on v.id = b.venue_id
                    where b.event_request_id = e.id
                  ), '[]'::jsonb)) as event_requests
              from event_registrations r join event_requests e on e.id = r.event_request_id
              where r.attendee_id = $1 and r.event_request_id = $2 and r.status = $3
            `, filters.map(([, value]) => value));
            return { data, error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
      };
      return query;
    },
  };
  const read = () => getAttendeeEvent({ user, eventRequestId: eventId, client });
  const book = async (name, status = 'approved') => {
    const venue = await one(`insert into venues (name, location, max_capacity)
      values ($1, $2, 100) returning id`, [name, `${name} location`]);
    return one(`insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
      values ($1, $2, $3, $4, $5) returning id`, [venue.id, eventId, start, end, status]);
  };

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`create schema auth;
      create table auth.users (id uuid primary key, email text);
      create role anon; create role authenticated; create role service_role bypassrls;`);
    for (const name of migrations) await db.exec(readFileSync(migrationPath(name), 'utf8'));
    await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4)', [ATTENDEE, ORGANISER, OTHER, COORDINATOR]);
    await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'event_organiser'), ($3, 'attendee'), ($4, 'event_coordinator')",
      [ATTENDEE, ORGANISER, OTHER, COORDINATOR]);
  });
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec('begin');
    queries = 0;
    eventId = (await one(`insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end,
        decision, reviewing_coordinator_id, decided_by, decided_at)
      values ($1, 'Registered event', 'confirmed', $2, $3, 'approved', $4, $4, now()) returning id`,
    [ORGANISER, start, end, COORDINATOR])).id;
    await db.query('insert into event_registrations (event_request_id, attendee_id) values ($1, $2)', [eventId, ATTENDEE]);
  });
  // Each fixture is rolled back, including deliberate database failures.
  afterEach(async () => { await db.exec('rollback'); });

  it('SCRUM24_AC4_AC5_AC6_SQL_reads_current_times_and_multiple_confirmed_venues', async () => {
    const a = await book('Hall A');
    const b = await book('Hall B');
    const result = await read();
    expect(result).toMatchObject({ eventRequestId: eventId, state: 'confirmed' });
    expect(new Date(result.startsAt).toISOString()).toBe('2030-05-06T01:00:00.000Z');
    expect(new Date(result.endsAt).toISOString()).toBe('2030-05-06T03:00:00.000Z');
    expect(result.venues).toHaveLength(2);
    expect(result.venues).toEqual(expect.arrayContaining([
      { bookingId: a.id, name: 'Hall A', location: 'Hall A location' },
      { bookingId: b.id, name: 'Hall B', location: 'Hall B location' },
    ]));
    expect(queries).toBe(1);
  });

  it.each(Object.values(STATUS).filter(status => status !== STATUS.CONFIRMED))(
    'SCRUM24_AC2_AC3_SQL_non_confirmed_event_has_no_arrangements_%s', async status => {
      await book('Private hall');
      const decision = status === STATUS.REJECTED ? 'rejected'
        : [STATUS.APPROVED, STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED, STATUS.COMPLETED].includes(status)
          ? 'approved' : null;
      await db.query(`update event_requests set status = $1, decision = $2,
        decision_note = 'Fixture review', decided_by = $3,
        decided_at = case when $3::uuid is null then null else now() end where id = $4`,
      [status, decision, decision ? COORDINATOR : null, eventId]);
      expect(await read()).toEqual({ eventRequestId: eventId, state: 'unavailable' });
      expect(queries).toBe(1);
    },
  );

  it('SCRUM24_AC6_SQL_holds_and_every_unconfirmed_booking_are_excluded', async () => {
    for (const status of Object.values(BOOKING_STATUS).filter(status => status !== BOOKING_STATUS.APPROVED)) {
      await book(status, status);
    }
    const heldVenue = await one(`insert into venues (name, location, max_capacity)
      values ('Held only', 'Private', 100) returning id`);
    await db.query(`insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
      values ($1, $2, $3, now() + interval '1 day')`, [eventId, heldVenue.id, ORGANISER]);
    expect((await read()).venues).toEqual([]);
  });

  it('SCRUM24_AC1_SQL_closed_disabled_full_and_past_events_remain_readable', async () => {
    await book('Hall');
    await db.query(`update event_requests set registration_enabled = false,
      registration_opens_at = '2000-01-01', registration_closes_at = '2000-01-02',
      registration_capacity = 1 where id = $1`, [eventId]);
    await db.query(`update event_requests set proposed_start = '2000-02-01', proposed_end = '2000-02-02'
      where id = $1`, [eventId]);
    const result = await read();
    expect(result.state).toBe('confirmed');
    expect(result.venues).toHaveLength(1);
    expect(new Date(result.startsAt).getUTCFullYear()).toBe(2000);
  });

  it('SCRUM24_AC7_SQL_change_hides_old_arrangements_and_reconfirmation_reads_latest', async () => {
    const old = await book('Old hall');
    expect((await read()).venues[0].bookingId).toBe(old.id);
    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    expect(await read()).toEqual({ eventRequestId: eventId, state: 'unavailable' });
    await db.query("update bookings set status = 'cancelled' where id = $1", [old.id]);
    const latest = await book('Latest hall');
    await db.query(`update event_requests set status = 'confirmed', proposed_start = $1, proposed_end = $2
      where id = $3`, ['2031-05-06T09:00:00+08:00', '2031-05-06T11:00:00+08:00', eventId]);
    const result = await read();
    expect(result.venues).toEqual([{ bookingId: latest.id, name: 'Latest hall', location: 'Latest hall location' }]);
    expect(new Date(result.startsAt).getUTCFullYear()).toBe(2031);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted'])(
    'SCRUM24_AC1_SQL_inactive_registration_never_grants_access_%s', async status => {
      await db.query('update event_registrations set status = $1 where event_request_id = $2', [status, eventId]);
      await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
    },
  );

  it('SCRUM24_AC1_SQL_unknown_and_other_attendees_event_have_identical_refusals', async () => {
    await db.query('update event_registrations set attendee_id = $1 where event_request_id = $2', [OTHER, eventId]);
    await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
    eventId = randomUUID();
    await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
  });

  it('SCRUM24_AC8_SQL_response_never_exposes_planning_or_staffing', async () => {
    await db.query("update event_requests set description = 'private planning', purpose = 'private' where id = $1", [eventId]);
    await book('Hall');
    const result = await read();
    expect(Object.keys(result).sort()).toEqual(['endsAt', 'eventRequestId', 'startsAt', 'state', 'venues']);
    expect(Object.keys(result.venues[0]).sort()).toEqual(['bookingId', 'location', 'name']);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('SCRUM24_AC1_SQL_registered_entry_points_survive_registration_closure_and_unconfirmed_state', async () => {
    await db.query(`update event_requests set status = 'approved', registration_enabled = false,
      registration_capacity = 1, registration_opens_at = '2000-01-01', registration_closes_at = '2000-01-02'
      where id = $1`, [eventId]);
    await db.query("update event_requests set description = 'PRIVATE_PLANNING' where id = $1", [eventId]);
    expect(await listAttendeeEvents({ user, client })).toEqual([{ eventRequestId: eventId, eventName: 'Registered event' }]);
    expect(queries).toBe(1);
    await db.query("update event_registrations set status = 'withdrawn' where event_request_id = $1", [eventId]);
    expect(await listAttendeeEvents({ user, client })).toEqual([]);
  });

  it('SCRUM24_AC1_SQL_missing_schema_fails_without_returning_event_data', async () => {
    await db.exec('alter table bookings rename column status to unavailable_status');
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
});
