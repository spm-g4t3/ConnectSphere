/**
 * SCRUM-266, walked through over HTTP on a real database: Venue Staff
 * reinstate a flagged booking once its block is shortened, a coordinator
 * cancels one and requests the venue again, and a coordinator replaces one.
 *
 * Why real routes. The route tests answer every call from a fake client, and
 * the database tests call 076-078 directly; neither shows that the routers,
 * services and functions agree with each other. Here the real flagged-booking,
 * booking-request and event-request routers run over PGlite, so each status,
 * code and needsAttention value below comes from where it would in production.
 *
 * The adapter is leadReassignmentWalkthrough.test.js's, extended only as this
 * path needs: a jsonb-returning function's value is unwrapped, as supabase-js
 * does, Postgres's hint and detail are passed on, and the bookings(status)
 * embed needsAttention reads is answered with a subquery. Anything else still
 * throws by name. The suitability check is stubbed suitable, as the route
 * tests stub it; it is N10's, not this story's.
 *
 * Migrations: replaceFlaggedBookingDatabase.test.js's stack and stand-ins,
 * plus the event_requests columns the services' COLUMNS reads (025, 042 and
 * clarification_reply_by_date), as leadReassignmentWalkthrough adds them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createFlaggedBookingRouter } from '../../src/routes/flaggedBookings.js';
import { createBookingRequestRouter } from '../../src/routes/bookingRequests.js';
import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '025_event_request_decisions.sql',
  'STAND_IN',
  '014_coordinator_assignment.sql',
  '002_venues.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '012_venue_block_creation.sql',
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
  '017_venue_turnaround.sql',
  '023_venue_setup_time.sql',
  '027_booking_request_statuses.sql',
  '028_booking_status_default_pending.sql',
  '030_create_booking_request.sql',
  '031_withdraw_booking_request.sql',
  '032_venue_occupancy.sql',
  '033_venue_occupancy_callers.sql',
  '034_setup_change_recheck.sql',
  '040_venue_holds.sql',
  'CANCELLATION_FIELDS',
  '051_multi_venue_booking_requests.sql',
  '065_booking_decision_statuses.sql',
  'SAFETY_ENUM',
  '066_venue_staff_booking_decisions.sql',
  'SAFETY_REASON',
  '076_reinstate_flagged_booking.sql',
  '077_cancel_flagged_booking.sql',
  '078_list_flagged_bookings.sql',
];

/** What 014 reads from SCRUM-19's migration, plus the column COLUMNS reads from 030's clarifications. */
const STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
  alter table event_requests add column if not exists clarification_reply_by_date date;
`;

/**
 * 042's cancellation columns, which COLUMNS reads. Its last statement extends
 * 006's change_request_decision, which this path never creates, so it is left out.
 */
const CANCELLATION_FIELDS = migration('042_event_cancellation_fields.sql').replace(
  /alter type change_request_decision\s+add value if not exists 'event_cancelled';/,
  '',
);

/** 062's `alter type ... add value` lines, read from the file, not retyped. */
const SAFETY_ENUM = migration('062_safety_statuses.sql')
  .split('\n')
  .filter((line) => line.startsWith('alter type event_request_status add value'))
  .join('\n');

/** 071's review-reason list, which adds 'safety_review' to 034's. */
const SAFETY_REASON = `
  alter table bookings drop constraint if exists bookings_review_reason_known;
  alter table bookings
    add constraint bookings_review_reason_known
    check (review_reason in ('setup_or_turnaround_changed', 'safety_review'));
`;

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

/** The bookings(status) embed, as PostgREST answers it along bookings.event_request_id. */
const BOOKING_STATUS_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object('status', b.status)), '[]'::json)
      from bookings b where b.event_request_id = ${table}.id) as bookings`;

/** The supabase-js shapes this path uses, over PGlite. */
function pgliteClient(db) {
  const answer = async (run) => {
    try {
      return { data: await run(), error: null };
    } catch (err) {
      return {
        data: null,
        error: { code: err.code, message: err.message, hint: err.hint, details: err.detail },
      };
    }
  };

  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const sql = `select * from ${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`;
      return answer(async () => {
        const row = (await db.query(sql, names.map((name) => args[name]))).rows[0] ?? null;
        // A function returning jsonb comes back as one column named after it;
        // supabase-js hands over the value itself.
        const keys = row ? Object.keys(row) : [];
        return keys.length === 1 && keys[0] === fn ? row[fn] : row;
      });
    },
    from(table) {
      let columns = '*';
      const where = [];
      const chain = {
        select(cols = '*') {
          if (/\w+\(/.test(cols.replace(/\bbookings\(status\)/, ''))) {
            throw new Error(`pgliteClient: an embed in "${cols}" is not on this path`);
          }
          columns = cols.replace(/\bbookings\(status\)/, BOOKING_STATUS_EMBED(table));
          return chain;
        },
        eq(column, value) { where.push([column, value]); return chain; },
        maybeSingle() {
          const clause = where.map(([column], i) => `${column} = $${i + 1}`).join(' and ');
          const sql = `select ${columns} from ${table}${clause ? ` where ${clause}` : ''}`;
          return answer(async () => (await db.query(sql, where.map(([, value]) => value))).rows[0] ?? null);
        },
        then() { throw new Error(`pgliteClient: a list read on ${table} is not on this path`); },
      };
      return chain;
    },
  };
}

describe('SCRUM-266: resolving a flagged booking, over HTTP, on a real database', () => {
  let db;
  let client;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  const as = (role, id) => (req, _res, next) => {
    req.user = { id, email: 'someone@example.com', role };
    next();
  };
  const app = (role, id) => {
    const requireAuth = as(role, id);
    return express()
      .use(express.json())
      .use('/api/flagged-bookings', createFlaggedBookingRouter({ client, requireAuth }))
      .use(
        '/api/booking-requests',
        createBookingRequestRouter({
          client,
          requireAuth,
          checkSuitability: async () => ({ suitable: true, criteria: [{ criterion: 'Capacity', met: true }] }),
        }),
      )
      .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
  };
  const asStaff = () => app(ROLE.VENUE_STAFF, staff);
  const asCoordinator = () => app(ROLE.EVENT_COORDINATOR, coordinator);

  const needsAttention = async (eventId) => {
    const res = await request(asCoordinator()).get(`/api/event-requests/${eventId}/review`);
    expect(res.status).toBe(200);
    return res.body.needsAttention;
  };

  async function makeVenue() {
    counter += 1;
    return (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, 30, 45) returning id`,
        [`Harbour Room ${counter}`],
      )
    ).id;
  }

  /** A confirmed 14:00-16:00 event the coordinator holds and approved (025 pairs the two). */
  async function makeConfirmedEvent() {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id,
            reviewing_coordinator_id, decision, decided_by, decided_at)
         values ($1, $2, 'confirmed', $3, $4, 150, now(), $5, $5, 'approved', $5, now()) returning id`,
        [organiser, `Event ${counter}`, at('14:00'), at('16:00'), coordinator],
      )
    ).id;
  }

  /** A booking for the event's period, approved by Venue Staff, as a seed. */
  async function approvedBooking(eventId, venueId) {
    const { id } = await one(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, 'pending') returning id`,
      [venueId, eventId, at('14:00'), at('16:00')],
    );
    const { result } = await one('select decide_booking_request($1, $2, $3, null, null) as result', [
      id,
      staff,
      'approve',
    ]);
    expect(result.outcome).toBe('approved');
    return id;
  }

  /** Flagged by a venue setup change, as 034 flags it: no block stands on the venue. */
  async function flaggedBySetupChange(eventId, venueId) {
    const id = await approvedBooking(eventId, venueId);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = 'setup_or_turnaround_changed',
              flagged_at = now(), flagged_by = $2
        where id = $1`,
      [id, staff],
    );
    return id;
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
    `);
    for (const name of MIGRATIONS) {
      if (name === 'STAND_IN') await db.exec(STAND_IN);
      else if (name === 'SAFETY_ENUM') await db.exec(SAFETY_ENUM);
      else if (name === 'SAFETY_REASON') await db.exec(SAFETY_REASON);
      else if (name === 'CANCELLATION_FIELDS') await db.exec(CANCELLATION_FIELDS);
      else await db.exec(migration(name));
    }
    const user = async (email, role) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    staff = await user('s@x', 'venue_staff');
    client = pgliteClient(db);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM266_AC2_venue_staff_reinstate_a_flagged_booking_once_its_block_is_shortened', async () => {
    const venueId = await makeVenue();
    const eventId = await makeConfirmedEvent();
    const bookingId = await approvedBooking(eventId, venueId);
    const { result: created } = await one(
      `select create_venue_block($1, $2, $3, 'maintenance', null, $4, true, $5::uuid[]) as result`,
      [venueId, at('15:00'), at('18:00'), staff, [bookingId]],
    );
    const blockId = created.block.id;

    // AC1: listed for Venue Staff with what flagged it.
    const listed = await request(asStaff()).get('/api/flagged-bookings');
    expect(listed.status).toBe(200);
    const row = listed.body.find((b) => b.id === bookingId);
    expect(row).toMatchObject({ eventRequestId: eventId, venueId, block: { id: blockId, reason: 'maintenance' } });

    // AC2: the block still covers the occupied period (13:30-16:45).
    const refused = await request(asStaff())
      .post(`/api/flagged-bookings/${bookingId}/reinstate`)
      .send({ reason: 'Block moved' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(refused.body.conflicts.map((c) => c.kind)).toEqual(['block']);
    expect((await one('select status from bookings where id = $1', [bookingId])).status).toBe('flagged_for_review');

    // The block now starts where the turnaround ends.
    const { result: amended } = await one(
      `select update_venue_block($1, $2, $3, null, null, null, false, $4, false, null) as result`,
      [venueId, blockId, at('16:45'), staff],
    );
    expect(amended.outcome).toBe('updated');

    const reinstated = await request(asStaff())
      .post(`/api/flagged-bookings/${bookingId}/reinstate`)
      .send({ reason: 'Maintenance now starts after the event' });
    expect(reinstated.status).toBe(200);
    expect(reinstated.body).toMatchObject({ id: bookingId, status: 'approved' });
    expect(reinstated.body.resolution).toMatchObject({
      outcome: 'reinstated',
      reason: 'Maintenance now starts after the event',
    });

    // AC5: one record; AC6: the coordinator and, for a confirmed event, the organiser are told.
    expect(await rows('select outcome, resolved_by, review_block_id from booking_resolutions where booking_id = $1', [bookingId]))
      .toEqual([{ outcome: 'reinstated', resolved_by: staff, review_block_id: blockId }]);
    const notices = await rows(
      `select recipient_id from notifications
        where booking_id = $1 and type = 'flagged_booking_resolved' order by payload->>'audience'`,
      [bookingId],
    );
    expect(notices.map((n) => n.recipient_id)).toEqual([coordinator, organiser]);
    expect((await request(asStaff()).get('/api/flagged-bookings')).body.map((b) => b.id)).not.toContain(bookingId);
  });

  it('SCRUM266_AC3_a_coordinator_cancels_a_flagged_booking_and_requests_the_venue_again', async () => {
    const venueId = await makeVenue();
    const eventId = await makeConfirmedEvent();
    const bookingId = await flaggedBySetupChange(eventId, venueId);

    // AC1: on the coordinator's event list; AC4: the event needs attention.
    const listed = await request(asCoordinator()).get(`/api/flagged-bookings/events/${eventId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((b) => [b.id, b.reviewReason])).toEqual([[bookingId, 'setup_or_turnaround_changed']]);
    expect(await needsAttention(eventId)).toBe(true);

    // While flagged, the event cannot request this venue again.
    const tooSoon = await request(asCoordinator()).post('/api/booking-requests').send({ eventRequestId: eventId, venueId });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.code).toBe('BOOKING_FLAGGED_FOR_REVIEW');

    const cancelled = await request(asCoordinator())
      .post(`/api/flagged-bookings/${bookingId}/cancel`)
      .send({ reason: 'Setup no longer fits; rebooking' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: bookingId, status: 'cancelled' });
    expect(cancelled.body.resolution).toMatchObject({ outcome: 'cancelled', reason: 'Setup no longer fits; rebooking' });
    expect(await needsAttention(eventId)).toBe(false);

    const again = await request(asCoordinator()).post('/api/booking-requests').send({ eventRequestId: eventId, venueId });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ eventRequestId: eventId, venueId, status: 'pending' });
  });

  it('SCRUM266_W7_a_coordinator_replaces_a_flagged_booking_with_another_venue', async () => {
    const eventId = await makeConfirmedEvent();
    const bookingId = await flaggedBySetupChange(eventId, await makeVenue());
    const otherVenue = await makeVenue();
    expect(await needsAttention(eventId)).toBe(true);

    const requested = await request(asCoordinator())
      .post('/api/booking-requests')
      .send({ eventRequestId: eventId, venueId: otherVenue, replacesBookingId: bookingId });
    expect(requested.status).toBe(201);
    expect(requested.body.replacesBookingId).toBe(bookingId);

    // Requesting alone resolves nothing; the flag stands until Venue Staff approve.
    expect((await one('select status from bookings where id = $1', [bookingId])).status).toBe('flagged_for_review');

    const approved = await request(asStaff()).post(`/api/booking-requests/${requested.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    expect((await one('select status from bookings where id = $1', [bookingId])).status).toBe('cancelled');
    expect(await rows('select outcome, replacement_booking_id from booking_resolutions where booking_id = $1', [bookingId]))
      .toEqual([{ outcome: 'replaced', replacement_booking_id: requested.body.id }]);
    const listed = await request(asCoordinator()).get(`/api/flagged-bookings/events/${eventId}`);
    expect(listed.body).toEqual([]);
    expect(await needsAttention(eventId)).toBe(false);
  });
});
