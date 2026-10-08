/**
 * SCRUM-17 end to end, through the HTTP layer: one Venue Staff member blocks a
 * venue over an approved booking, overrides it, a second staff member shortens,
 * extends and removes the block, and an Event Coordinator sees the flag, the
 * search and the calendar change along the way.
 *
 * SCRUM-132. What this proves, honestly: WIRING AND CONTRACTS. The real
 * routers (venues + notifications), the real role gates, validators, services
 * and error handler run on every request, and every Supabase call they make is
 * checked against a scripted queue -- the exact RPC or table, in order, with
 * its arguments -- while ids are threaded from each real response into the
 * next request. What it does NOT prove is database behaviour: the responses
 * below are what the RPCs are specified to return, not what Postgres did.
 * That half is proven against a live Supabase by `npm run venue-blocks:check`
 * (scripts/check-venue-blocks.js).
 *
 * SCRUM-484: a dated search now reads the venues first and then asks
 * rpc('available_venue_ids') (033) which of them are free, instead of a raw
 * venue_blocks read before the venues query. The scripted answers below stand
 * in for that function; its real rule (bookings padded with the venue's setup
 * and turnaround, blocks raw, touching is clear) is tested against PGlite in
 * tests/db/venueSearchOccupancyDatabase.test.js.
 *
 * The tests in this file share one journey and run in order; each `it` scripts
 * only the calls its own requests make, and afterEach asserts the queue is
 * empty, so an unexpected or missing call fails the step that caused it.
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- a block is created with a venue, a period and a reason
 *   AC2 -- blocked venues leave search and show on the calendar
 *   AC3 -- a block over an approved booking needs an override, flags the
 *          booking for review and notifies the Event Coordinator
 *   AC4 -- a block can be amended and removed, and the history records who
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});

const { createVenueRouter } = await import('../../src/routes/venues.js');
const { createNotificationRouter } = await import('../../src/routes/notifications.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


// ---------------------------------------------------------------- fixtures

const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const STAFF1_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const STAFF2_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e';
const COORDINATOR_ID = '11111111-1111-4111-8111-111111111111';
const FORGED_ID = '99999999-9999-4999-8999-999999999999';
const BOOKING_1 = 'a1b2c3d4-0000-4000-8000-00000000000b';
const BOOKING_2 = 'a1b2c3d4-0000-4000-8000-00000000000c';
const EVENT_1 = '22222222-2222-4222-8222-222222222221';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const BLOCK_X_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c1';
const BLOCK_M_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c2';
const NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const USERS = {
  staff1: { id: STAFF1_ID, role: ROLE.VENUE_STAFF },
  staff2: { id: STAFF2_ID, role: ROLE.VENUE_STAFF },
  coordinator: { id: COORDINATOR_ID, role: ROLE.EVENT_COORDINATOR },
};

/**
 * Next year's 1 March, Singapore time: always in the future, so the real
 * "must end in the future" rule passes without faking the clock.
 */
const Y = new Date().getUTCFullYear() + 1;
const at = (hhmm) => `${Y}-03-01T${hhmm}:00+08:00`;
const utc = (hhmm) => new Date(at(hhmm)).toISOString().replace('.000Z', '+00:00');

// B1 = [10:00, 12:00), B2 = [14:00, 16:00); X = [08:00, 10:00) only touches B1.
const B1_ROW = {
  booking_id: BOOKING_1, event_request_id: EVENT_1, event_name: 'Tech Talk',
  starts_at: utc('10:00'), ends_at: utc('12:00'),
};
const B2_ROW = {
  booking_id: BOOKING_2, event_request_id: EVENT_2, event_name: 'Career Fair',
  starts_at: utc('14:00'), ends_at: utc('16:00'),
};

function blockRow(overrides = {}) {
  return {
    id: BLOCK_M_ID,
    venue_id: VENUE_ID,
    starts_at: utc('10:00'),
    ends_at: utc('13:00'),
    reason: 'maintenance',
    notes: null,
    created_by: STAFF1_ID,
    last_modified_by: STAFF1_ID,
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-01T00:00:00+00:00',
    removed_at: null,
    removed_by: null,
    ...overrides,
  };
}

function historyRow(id, action, changedBy, changedAt) {
  return {
    id, block_id: BLOCK_M_ID, action, changed_by: changedBy, changed_at: changedAt,
    old_values: null, new_values: null,
  };
}


// ------------------------------------------------------ scripted call queue

/** Steps still to be consumed, and assertion failures caught inside the mock. */
const queue = [];
const failures = [];

/** A recording query builder. Its asserts run when the chain is awaited. */
function queryStub(step) {
  const calls = [];
  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
  };
  const settle = () => {
    try {
      step.assert?.(stub);
    } catch (err) {
      failures.push(err);
    }
    return Promise.resolve(step.respond);
  };
  for (const method of [
    'select', 'eq', 'is', 'ilike', 'gte', 'lt', 'gt', 'not', 'in', 'order', 'limit', 'update',
  ]) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  stub.maybeSingle = (...args) => { calls.push(['maybeSingle', ...args]); return settle(); };
  stub.then = (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected);
  return stub;
}

/** Take the next step, recording a failure if it is not the call made. */
function next(kind, name) {
  const step = queue.shift();
  if (step === undefined) {
    failures.push(new Error(`unexpected ${kind}('${name}'): the queue is empty`));
    return null;
  }
  if (step.kind !== kind || step.name !== name) {
    failures.push(new Error(`expected ${step.kind}('${step.name}'), got ${kind}('${name}')`));
  }
  return step;
}

rpc.mockImplementation((name, args) => {
  const step = next('rpc', name);
  if (step === null) return Promise.resolve({ data: null, error: { message: 'unscripted' } });
  try {
    step.assert?.(args);
  } catch (err) {
    failures.push(err);
  }
  return Promise.resolve(step.respond);
});

from.mockImplementation((table) => {
  const step = next('from', table);
  return queryStub(step ?? { respond: { data: null, error: { message: 'unscripted' } } });
});

/** Script the calls the next request(s) must make, in order. */
function script(...steps) {
  queue.push(...steps);
}

const rpcStep = (name, respond, assert) => ({ kind: 'rpc', name, respond, assert });
const fromStep = (name, respond, assert) => ({ kind: 'from', name, respond, assert });
const ok = (data) => ({ data, error: null });


// ------------------------------------------------------------------ the app

/** Signs in whoever the x-test-as header names; no header is no session. */
function fakeRequireAuth(req, res, next) {
  const user = USERS[req.get('x-test-as')];
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: user.id, email: `${req.get('x-test-as')}@example.com`, role: user.role };
  return next();
}

const app = express()
  .use(express.json())
  .use('/api/venues', createVenueRouter({ requireAuth: fakeRequireAuth }))
  .use('/api/notifications', createNotificationRouter({ requireAuth: fakeRequireAuth }));

/** A request as one user; any assertion failure inside the mock fails here first. */
async function as(who, build) {
  const res = await build(request(app)).set('x-test-as', who);
  expect(failures).toEqual([]);
  return res;
}

afterEach(() => {
  const leftover = queue.splice(0).map((s) => `${s.kind}('${s.name}')`);
  const caught = failures.splice(0);
  expect(caught).toEqual([]);
  expect(leftover, 'scripted calls never made').toEqual([]);
});

// Threaded through the journey from real responses.
const journey = {};


describe('the test double', () => {
  it('SCRUM17_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    // Without this, a machine with a real .env would run the whole journey
    // against live data and report success.
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM17 venue block journey: create, override, amend, remove', () => {
  it('SCRUM17_AC3_block_over_an_approved_booking_is_409_and_acts_as_the_session_user', async () => {
    script(rpcStep(
      'create_venue_block',
      ok({ outcome: 'conflict', conflicts: [B1_ROW] }),
      (args) => {
        expect(args.p_user_id).toBe(STAFF1_ID);
        expect(args.p_confirm_override).toBe(false);
        expect(args.p_acknowledged_booking_ids).toEqual([]);
        expect(args.p_venue_id).toBe(VENUE_ID);
      },
    ));

    const res = await as('staff1', (r) => r
      .post(`/api/venues/${VENUE_ID}/blocks`)
      // userId is forged: the acting user must still be the session's.
      .send({ startsAt: at('10:00'), endsAt: at('13:00'), reason: 'maintenance', userId: FORGED_ID }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(res.body.conflicts).toEqual([{
      bookingId: BOOKING_1, eventRequestId: EVENT_1, eventName: 'Tech Talk',
      startsAt: B1_ROW.starts_at, endsAt: B1_ROW.ends_at,
    }]);
    journey.conflicts = res.body.conflicts;
  });

  describe('SCRUM17_AC1 a block that touches a booking is created outright', () => {
    it('SCRUM17_AC1_non_overlapping_block_is_201_with_nothing_flagged', async () => {
      script(rpcStep(
        'create_venue_block',
        ok({
          outcome: 'created',
          block: blockRow({ id: BLOCK_X_ID, starts_at: utc('08:00'), ends_at: utc('10:00') }),
          affected_bookings: [],
          flagged_bookings: [],
        }),
        (args) => {
          expect(args).toEqual({
            p_venue_id: VENUE_ID,
            p_starts_at: at('08:00'),
            p_ends_at: at('10:00'),
            p_reason: 'maintenance',
            p_notes: null,
            p_user_id: STAFF1_ID,
            p_confirm_override: false,
            p_acknowledged_booking_ids: [],
          });
        },
      ));

      const res = await as('staff1', (r) => r
        .post(`/api/venues/${VENUE_ID}/blocks`)
        .send({ startsAt: at('08:00'), endsAt: at('10:00'), reason: 'maintenance' }));

      expect(res.status).toBe(201);
      expect(res.body.block).toMatchObject({ id: BLOCK_X_ID, venueId: VENUE_ID, createdBy: STAFF1_ID });
      expect(res.body.flaggedBookings).toEqual([]);
      journey.blockX = res.body.block;
    });
  });

  it('SCRUM17_AC3_override_lowercases_acknowledged_ids_and_answers_201_with_flaggedBookings', async () => {
    const acknowledged = journey.conflicts.map((c) => c.bookingId.toUpperCase());
    expect(acknowledged).toEqual([BOOKING_1.toUpperCase()]);

    script(rpcStep(
      'create_venue_block',
      ok({
        outcome: 'created',
        block: blockRow(),
        affected_bookings: [B1_ROW],
        flagged_bookings: [B1_ROW],
      }),
      (args) => {
        expect(args.p_confirm_override).toBe(true);
        expect(args.p_acknowledged_booking_ids).toEqual([BOOKING_1]);
        expect(args.p_user_id).toBe(STAFF1_ID);
      },
    ));

    const res = await as('staff1', (r) => r
      .post(`/api/venues/${VENUE_ID}/blocks`)
      .send({
        startsAt: at('10:00'), endsAt: at('13:00'), reason: 'maintenance',
        confirmOverride: true, acknowledgedBookingIds: acknowledged,
      }));

    expect(res.status).toBe(201);
    expect(res.body.block).toMatchObject({ id: BLOCK_M_ID, createdBy: STAFF1_ID });
    expect(res.body.flaggedBookings.map((b) => b.bookingId)).toEqual([BOOKING_1]);
    journey.blockM = res.body.block;
    journey.flagged = res.body.flaggedBookings;
  });

  it('SCRUM17_AC3_coordinator_reads_the_booking_flagged_notification', async () => {
    const [flagged] = journey.flagged;
    script(fromStep(
      'notifications',
      ok([{
        id: NOTIFICATION_ID,
        recipient_id: COORDINATOR_ID,
        type: 'booking_flagged',
        booking_id: flagged.bookingId,
        block_id: journey.blockM.id,
        payload: {
          venueName: 'Seminar Room 2-1', eventName: flagged.eventName,
          startsAt: flagged.startsAt, endsAt: flagged.endsAt, reason: 'maintenance',
          blockStartsAt: journey.blockM.startsAt, blockEndsAt: journey.blockM.endsAt,
        },
        read_at: null,
        created_at: '2026-10-01T00:00:01+00:00',
      }]),
      (q) => {
        expect(q.args('eq')).toEqual(['recipient_id', COORDINATOR_ID]);
        expect(q.args('limit')).toEqual([50]);
      },
    ));

    const res = await as('coordinator', (r) => r.get('/api/notifications'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: NOTIFICATION_ID,
      type: 'booking_flagged',
      bookingId: BOOKING_1,
      blockId: BLOCK_M_ID,
      readAt: null,
    });
    expect(res.body[0].payload.eventName).toBe('Tech Talk');
    expect(res.body[0]).not.toHaveProperty('recipientId');
  });

  it('SCRUM17_AC4_second_staff_member_shortens_and_is_recorded_as_editor', async () => {
    script(rpcStep(
      'update_venue_block',
      ok({
        outcome: 'updated',
        block: blockRow({ ends_at: utc('11:00'), last_modified_by: STAFF2_ID }),
        affected_bookings: [],
        flagged_bookings: [],
      }),
      (args) => {
        expect(args).toEqual({
          p_venue_id: VENUE_ID,
          p_block_id: journey.blockM.id,
          p_starts_at: null,
          p_ends_at: at('11:00'),
          p_reason: null,
          p_notes: null,
          p_notes_supplied: false,
          p_user_id: STAFF2_ID,
          p_confirm_override: false,
          p_acknowledged_booking_ids: [],
        });
      },
    ));

    const res = await as('staff2', (r) => r
      .patch(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`)
      .send({ endsAt: at('11:00'), userId: FORGED_ID }));

    expect(res.status).toBe(200);
    expect(res.body.block).toMatchObject({ lastModifiedBy: STAFF2_ID, createdBy: STAFF1_ID });
    expect(res.body.flaggedBookings).toEqual([]);
  });

  it('SCRUM17_AC4_extending_over_another_booking_is_409_then_override_is_200', async () => {
    script(rpcStep(
      'update_venue_block',
      ok({ outcome: 'conflict', conflicts: [B2_ROW] }),
      (args) => {
        expect(args.p_ends_at).toBe(at('16:30'));
        expect(args.p_confirm_override).toBe(false);
        expect(args.p_user_id).toBe(STAFF2_ID);
      },
    ));

    const conflict = await as('staff2', (r) => r
      .patch(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`)
      .send({ endsAt: at('16:30') }));

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(conflict.body.conflicts.map((c) => c.bookingId)).toEqual([BOOKING_2]);

    script(rpcStep(
      'update_venue_block',
      ok({
        outcome: 'updated',
        block: blockRow({ ends_at: utc('16:30'), last_modified_by: STAFF2_ID }),
        affected_bookings: [B2_ROW],
        flagged_bookings: [B2_ROW],
      }),
      (args) => {
        expect(args.p_confirm_override).toBe(true);
        expect(args.p_acknowledged_booking_ids).toEqual([BOOKING_2]);
        expect(args.p_user_id).toBe(STAFF2_ID);
      },
    ));

    const res = await as('staff2', (r) => r
      .patch(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`)
      .send({
        endsAt: at('16:30'),
        confirmOverride: true,
        acknowledgedBookingIds: conflict.body.conflicts.map((c) => c.bookingId),
      }));

    expect(res.status).toBe(200);
    expect(res.body.flaggedBookings.map((b) => b.bookingId)).toEqual([BOOKING_2]);
    expect(res.body.block.endsAt).toBe(utc('16:30'));
  });

  it('SCRUM17_AC2_dated_search_leaves_the_blocked_venue_out', async () => {
    const startsAt = at('12:00');
    const endsAt = at('13:00');
    // Block M, extended to [10:00, 16:30), covers [12:00, 13:00), so the
    // shared function leaves VENUE_ID out of its answer.
    script(
      fromStep(
        'venues',
        ok([
          { id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 },
          { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'SCIS', max_capacity: 40 },
        ]),
        (q) => {
          expect(q.args('is')).toEqual(['retired_at', null]);
          // Availability is no longer a PostgREST filter on the venues query.
          expect(q.called('not')).toBe(false);
        },
      ),
      rpcStep('available_venue_ids', ok([{ venue_id: OTHER_VENUE_ID }]), (args) => {
        expect(args).toEqual({
          p_venue_ids: [OTHER_VENUE_ID, VENUE_ID],
          p_starts_at: startsAt,
          p_ends_at: endsAt,
        });
      }),
    );

    // '+' must be URL-encoded, or it arrives as a space.
    const res = await as('coordinator', (r) => r.get(
      `/api/venues/search?startsAt=${encodeURIComponent(startsAt)}&endsAt=${encodeURIComponent(endsAt)}`,
    ));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.id)).not.toContain(VENUE_ID);
    expect(res.body.map((v) => v.id)).toEqual([OTHER_VENUE_ID]);
  });

  it('SCRUM17_AC4_second_staff_member_removes_the_block_with_204', async () => {
    script(rpcStep(
      'remove_venue_block',
      ok({ outcome: 'removed', block: blockRow({ removed_at: '2026-10-01T00:05:00+00:00', removed_by: STAFF2_ID }) }),
      (args) => {
        expect(args).toEqual({
          p_venue_id: VENUE_ID, p_block_id: journey.blockM.id, p_user_id: STAFF2_ID,
        });
      },
    ));

    const res = await as('staff2', (r) => r
      .delete(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`));

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('SCRUM17_AC4_a_removed_block_cannot_be_removed_or_amended_again', async () => {
    const removed = {
      data: null,
      error: {
        code: 'PT409',
        message: `venue block ${journey.blockM.id} has been removed`,
        hint: 'BLOCK_REMOVED',
        details: null,
      },
    };
    script(
      rpcStep('remove_venue_block', removed, (args) => expect(args.p_user_id).toBe(STAFF2_ID)),
      rpcStep('update_venue_block', removed, (args) => expect(args.p_user_id).toBe(STAFF2_ID)),
    );

    const again = await as('staff2', (r) => r
      .delete(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: `venue block ${BLOCK_M_ID} has been removed`,
      code: 'BLOCK_REMOVED',
      conflicts: [],
    });

    const patch = await as('staff2', (r) => r
      .patch(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`)
      .send({ reason: 'renovation' }));
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('BLOCK_REMOVED');
  });

  it('SCRUM17_AC2_after_removal_dated_search_includes_the_venue_again', async () => {
    // With M removed, nothing occupies [12:00, 13:00): B1 ends at 12:00 and
    // this fixture's venue has no turnaround, so it only touches; the scripted
    // answer frees both venues. (That a removed block occupies nothing is
    // tested against PGlite in tests/db/venueSearchOccupancyDatabase.test.js.)
    script(
      fromStep(
        'venues',
        ok([
          { id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 },
          { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'SCIS', max_capacity: 40 },
        ]),
        (q) => {
          // The venues query is exactly the dateless one.
          expect(q.called('not')).toBe(false);
        },
      ),
      rpcStep(
        'available_venue_ids',
        ok([{ venue_id: OTHER_VENUE_ID }, { venue_id: VENUE_ID }]),
        (args) => {
          expect(args).toEqual({
            p_venue_ids: [OTHER_VENUE_ID, VENUE_ID],
            p_starts_at: at('12:00'),
            p_ends_at: at('13:00'),
          });
        },
      ),
    );

    const res = await as('coordinator', (r) => r.get(
      `/api/venues/search?startsAt=${encodeURIComponent(at('12:00'))}&endsAt=${encodeURIComponent(at('13:00'))}`,
    ));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.id)).toContain(VENUE_ID);
  });

  it('SCRUM17_AC4_history_lists_removed_amended_amended_created_with_each_editor', async () => {
    script(
      fromStep(
        'venue_blocks',
        ok(blockRow({ removed_at: '2026-10-01T00:05:00+00:00', removed_by: STAFF2_ID, last_modified_by: STAFF2_ID })),
        (q) => {
          expect(q.allArgs('eq')).toEqual([['venue_id', VENUE_ID], ['id', journey.blockM.id]]);
          expect(q.called('maybeSingle')).toBe(true);
          // A removed block's history still answers.
          expect(q.called('is')).toBe(false);
        },
      ),
      fromStep(
        'venue_block_history',
        ok([
          historyRow('00000000-0000-4000-8000-000000000004', 'removed', STAFF2_ID, '2026-10-01T00:05:00+00:00'),
          historyRow('00000000-0000-4000-8000-000000000003', 'amended', STAFF2_ID, '2026-10-01T00:04:00+00:00'),
          historyRow('00000000-0000-4000-8000-000000000002', 'amended', STAFF2_ID, '2026-10-01T00:03:00+00:00'),
          historyRow('00000000-0000-4000-8000-000000000001', 'created', STAFF1_ID, '2026-10-01T00:00:00+00:00'),
        ]),
        (q) => {
          expect(q.args('eq')).toEqual(['block_id', journey.blockM.id]);
          expect(q.allArgs('order')).toEqual([
            ['changed_at', { ascending: false }],
            ['id', { ascending: false }],
          ]);
        },
      ),
    );

    const res = await as('staff1', (r) => r
      .get(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}/history`));

    expect(res.status).toBe(200);
    expect(res.body.map((h) => h.action)).toEqual(['removed', 'amended', 'amended', 'created']);
    expect(res.body.map((h) => h.changedBy)).toEqual([STAFF2_ID, STAFF2_ID, STAFF2_ID, STAFF1_ID]);
  });

  it('SCRUM17_AC2_coordinator_reads_the_venue_calendar_window', async () => {
    const fromAt = at('00:00');
    const toAt = `${Y}-03-02T00:00:00+08:00`;
    script(fromStep(
      'venue_blocks',
      ok([blockRow({ id: BLOCK_X_ID, starts_at: utc('08:00'), ends_at: utc('10:00') })]),
      (q) => {
        expect(q.allArgs('eq')).toEqual([['venue_id', VENUE_ID]]);
        expect(q.args('is')).toEqual(['removed_at', null]);
        expect(q.args('lt')).toEqual(['starts_at', toAt]);
        expect(q.args('gt')).toEqual(['ends_at', fromAt]);
      },
    ));

    const res = await as('coordinator', (r) => r.get(
      `/api/venues/${VENUE_ID}/blocks?from=${encodeURIComponent(fromAt)}&to=${encodeURIComponent(toAt)}`,
    ));

    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.id)).toEqual([journey.blockX.id]);
    expect(res.body.map((b) => b.id)).not.toContain(BLOCK_M_ID);
  });
});
