/**
 * SCRUM-382 (SCRUM-379 AC3): the final-event guard against the real schema.
 *
 * The guard is run directly, with a request and a `next`, on a database built
 * from the baseline and every migration. Each event is seeded in every status,
 * and a booking, a registration and a change request are attached to a
 * completed, a cancelled and a live event. Nothing here depends on the clock.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import {
  createFinalEventGuard,
  noopFinalEventGuard,
  eventIdFromParam,
  eventIdFromBody,
  eventIdFromRecord,
  FINAL_EVENT_GUARD_TAG,
} from '../../src/middleware/finalEventGuard.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ConflictError } from '../../src/errors.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';
import { useSchemaDb, seedEvent, seedUser, seedVenue, seedBooking } from '../db/helpers/schemaDb.js';

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

// Runs one guard on one request. Returns what happened instead of throwing.
async function run(guard, req = {}) {
  let nexted = 0;
  try {
    await guard({ params: {}, body: {}, ...req }, {}, () => { nexted += 1; });
    return { nexted, error: null };
  } catch (error) {
    return { nexted, error };
  }
}

describe('SCRUM-382: the final-event guard on the real schema', () => {
  const getDb = useSchemaDb();
  let db;
  let client;
  let guard;
  let organiser;
  let coordinator;
  let attendee;
  let venueId;
  const eventByStatus = {};
  const attached = { completed: {}, cancelled: {}, approved: {} };

  const setStatus = (id, status) => db.query(
    'update event_requests set status = $2 where id = $1', [id, status],
  );

  beforeAll(async () => {
    db = getDb();
    client = pgliteSupabaseClient(db);
    guard = createFinalEventGuard({ client });
    organiser = await seedUser(db, { email: 'organiser382@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator382@example.com', role: 'event_coordinator' });
    attendee = await seedUser(db, { email: 'attendee382@example.com', role: 'attendee' });
    venueId = await seedVenue(db, { name: 'Guard hall' });

    for (const status of Object.values(STATUS)) {
      eventByStatus[status] = await seedEvent(db, {
        status,
        organiser_id: organiser,
        event_name: `Guard ${status}`,
        assigned_coordinator_id: coordinator,
        reviewing_coordinator_id: coordinator,
        proposed_start: '2099-03-01T09:00:00Z',
        proposed_end: '2099-03-01T11:00:00Z',
      });
    }

    const changeField = (await db.query('select (enum_range(null::event_change_field))[1]::text as field')).rows[0].field;
    let day = 10;
    for (const status of ['completed', 'cancelled', 'approved']) {
      const eventId = eventByStatus[status];
      day += 1;
      const start = `2099-04-${String(day).padStart(2, '0')}T09:00:00Z`;
      const end = `2099-04-${String(day).padStart(2, '0')}T11:00:00Z`;
      attached[status].booking = await seedBooking(db, { venueId, eventId, status: 'pending', start, end });
      attached[status].registration = (await db.query(
        'insert into event_registrations (event_request_id, attendee_id) values ($1, $2) returning id',
        [eventId, attendee],
      )).rows[0].id;
      attached[status].changeRequest = (await db.query(
        `insert into event_change_requests (event_request_id, requested_by, change_field, requested_change)
         values ($1, $2, $3::event_change_field, 'Move it') returning id`,
        [eventId, organiser, changeField],
      )).rows[0].id;
    }
  }, 120_000);

  describe('by status, from a route parameter', () => {
    it.each(['completed', 'cancelled'])('SCRUM382_AC3_a_%s_event_is_refused_with_409_EVENT_FINAL', async (status) => {
      const { nexted, error } = await run(guard(eventIdFromParam('id')), { params: { id: eventByStatus[status] } });

      expect(nexted).toBe(0);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.status).toBe(409);
      expect(error.code).toBe('EVENT_FINAL');
      expect(error.message).toBe(`This event is ${status} and can no longer be changed`);
    });

    it.each(Object.values(STATUS).filter((s) => s !== 'completed' && s !== 'cancelled'))(
      'SCRUM382_AC3_a_%s_event_is_let_through',
      async (status) => {
        const { nexted, error } = await run(guard(eventIdFromParam('id')), { params: { id: eventByStatus[status] } });

        expect(error).toBeNull();
        expect(nexted).toBe(1);
      },
    );

    it('SCRUM382_AC3_every_status_is_covered_by_a_seeded_event', () => {
      expect(Object.keys(eventByStatus).sort()).toEqual(Object.values(STATUS).sort());
    });

    it('SCRUM382_AC3_an_event_becoming_final_is_refused_on_the_next_call_because_nothing_is_cached', async () => {
      const id = await seedEvent(db, {
        status: 'approved', organiser_id: organiser, event_name: 'Turns final',
        assigned_coordinator_id: coordinator, reviewing_coordinator_id: coordinator,
      });
      const request = { params: { id } };

      expect((await run(guard(eventIdFromParam('id')), request)).nexted).toBe(1);

      await db.query("select change_event_request_status($1, 'approved', 'cancelled', $2)", [id, coordinator]);

      const after = await run(guard(eventIdFromParam('id')), request);
      expect(after.nexted).toBe(0);
      expect(after.error.code).toBe('EVENT_FINAL');
    });

    it('SCRUM382_AC3_a_padded_upper_case_id_still_finds_the_event', async () => {
      const id = ` ${eventByStatus.completed.toUpperCase()} `;
      const { error } = await run(guard(eventIdFromParam('id')), { params: { id } });
      expect(error?.code).toBe('EVENT_FINAL');
    });

    it('SCRUM382_AC3_a_different_parameter_name_can_be_used', async () => {
      const { error } = await run(guard(eventIdFromParam('eventRequestId')), {
        params: { eventRequestId: eventByStatus.cancelled },
      });
      expect(error?.code).toBe('EVENT_FINAL');
    });
  });

  describe('from the body', () => {
    it.each(['completed', 'cancelled'])('SCRUM382_AC3_a_%s_event_named_in_the_body_is_refused', async (status) => {
      const { nexted, error } = await run(guard(eventIdFromBody('eventRequestId')), {
        body: { eventRequestId: eventByStatus[status] },
      });
      expect(nexted).toBe(0);
      expect(error?.code).toBe('EVENT_FINAL');
    });

    it('SCRUM382_AC3_a_live_event_named_in_the_body_is_let_through', async () => {
      const { nexted, error } = await run(guard(eventIdFromBody()), {
        body: { eventRequestId: eventByStatus.approved },
      });
      expect(error).toBeNull();
      expect(nexted).toBe(1);
    });

    it('SCRUM382_AC3_the_body_field_name_is_exact', async () => {
      const { nexted } = await run(guard(eventIdFromBody('eventRequestId')), {
        body: { eventrequestid: eventByStatus.completed, event_request_id: eventByStatus.completed },
      });
      expect(nexted).toBe(1);
    });
  });

  describe('from a record attached to the event', () => {
    const cases = [
      ['bookings', 'booking', 'id'],
      ['event_registrations', 'registration', 'registrationId'],
      ['event_change_requests', 'changeRequest', 'changeRequestId'],
    ];

    it.each(cases.flatMap(([table, key, param]) => [
      [table, 'completed', key, param],
      [table, 'cancelled', key, param],
    ]))('SCRUM382_AC3_a_%s_row_of_a_%s_event_is_refused', async (table, status, key, param) => {
      const recordId = attached[status][key];
      const { nexted, error } = await run(guard(eventIdFromRecord(table, param)), { params: { [param]: recordId } });

      expect(nexted).toBe(0);
      expect(error?.code).toBe('EVENT_FINAL');
      expect(error.message).toBe(`This event is ${status} and can no longer be changed`);
    });

    it.each(cases)('SCRUM382_AC3_a_%s_row_of_a_live_event_is_let_through', async (table, key, param) => {
      const { nexted, error } = await run(guard(eventIdFromRecord(table, param)), {
        params: { [param]: attached.approved[key] },
      });
      expect(error).toBeNull();
      expect(nexted).toBe(1);
    });

    it('SCRUM382_AC3_a_record_that_does_not_exist_is_let_through_for_the_handler_to_404', async () => {
      const { nexted, error } = await run(guard(eventIdFromRecord('bookings', 'id')), { params: { id: UNKNOWN_ID } });
      expect(error).toBeNull();
      expect(nexted).toBe(1);
    });

    it('SCRUM382_AC3_a_padded_upper_case_record_id_still_finds_the_record', async () => {
      const id = ` ${attached.completed.booking.toUpperCase()} `;
      const { error } = await run(guard(eventIdFromRecord('bookings', 'id')), { params: { id } });
      expect(error?.code).toBe('EVENT_FINAL');
    });

    it('SCRUM382_AC3_a_booking_id_is_never_mistaken_for_an_event_id', async () => {
      // The completed event's own id sent as a booking id names no booking.
      const { nexted } = await run(guard(eventIdFromRecord('bookings', 'id')), {
        params: { id: eventByStatus.completed },
      });
      expect(nexted).toBe(1);
    });
  });

  describe('when the event cannot be found or the id is unusable', () => {
    it('SCRUM382_AC3_an_unknown_event_is_let_through_so_the_handler_answers_404_not_the_guard', async () => {
      const { nexted, error } = await run(guard(eventIdFromParam('id')), { params: { id: UNKNOWN_ID } });
      expect(error).toBeNull();
      expect(nexted).toBe(1);
    });

    it.each([
      ['a missing parameter', { params: {} }],
      ['an empty string', { params: { id: '' } }],
      ['text that is not a uuid', { params: { id: 'not-a-uuid' } }],
      ["an injection attempt", { params: { id: `${eventByStatus.completed}' or '1'='1` } }],
      ['a uuid with a character too many', { params: { id: `${eventByStatus.completed}0` } }],
      ['a number', { params: { id: 12345 } }],
      ['an array holding a real id', { params: { id: [eventByStatus.completed] } }],
      ['an object', { params: { id: { toString: () => eventByStatus.completed } } }],
    ])('SCRUM382_AC3_%s_is_let_through_without_touching_the_database', async (_label, req) => {
      const calls = [];
      const spy = { from: (table) => { calls.push(table); return client.from(table); } };
      const { nexted, error } = await run(createFinalEventGuard({ client: spy })(eventIdFromParam('id')), req);

      expect(error).toBeNull();
      expect(nexted).toBe(1);
      expect(calls).toEqual([]);
    });

    it.each([
      ['no body at all', {}],
      ['a body without the field', { body: {} }],
      ['a null field', { body: { eventRequestId: null } }],
      ['a numeric field', { body: { eventRequestId: 7 } }],
    ])('SCRUM382_AC3_%s_is_let_through_for_a_body_route', async (_label, req) => {
      const { nexted, error } = await run(guard(eventIdFromBody()), { ...req, body: req.body });
      expect(error).toBeNull();
      expect(nexted).toBe(1);
    });

    it('SCRUM382_AC3_a_record_route_with_no_id_is_let_through', async () => {
      const { nexted } = await run(guard(eventIdFromRecord('bookings', 'id')), { params: {} });
      expect(nexted).toBe(1);
    });
  });

  describe('when the read fails', () => {
    const failing = (failOn) => ({
      from: (table) => {
        const real = client.from(table);
        return table === failOn
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }) }) }) }
          : real;
      },
    });

    it('SCRUM382_AC3_an_unreadable_status_fails_closed_with_an_error_that_is_not_a_conflict', async () => {
      const { nexted, error } = await run(
        createFinalEventGuard({ client: failing('event_requests') })(eventIdFromParam('id')),
        { params: { id: eventByStatus.approved } },
      );
      expect(nexted).toBe(0);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConflictError);
      expect(error.message).toContain('final-event guard');
      expect(error.message).toContain('connection lost');
    });

    it('SCRUM382_AC3_an_unreadable_record_fails_closed_too', async () => {
      const { nexted, error } = await run(
        createFinalEventGuard({ client: failing('bookings') })(eventIdFromRecord('bookings', 'id')),
        { params: { id: attached.approved.booking } },
      );
      expect(nexted).toBe(0);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('connection lost');
    });

    it('SCRUM382_AC3_a_thrown_driver_error_is_not_swallowed', async () => {
      const throwing = { from: () => { throw new Error('socket closed'); } };
      const { nexted, error } = await run(
        createFinalEventGuard({ client: throwing })(eventIdFromParam('id')),
        { params: { id: eventByStatus.approved } },
      );
      expect(nexted).toBe(0);
      expect(error.message).toBe('socket closed');
    });
  });

  describe('the middleware itself', () => {
    it('SCRUM382_AC3_a_real_guard_is_tagged_so_the_completeness_test_can_find_it', () => {
      expect(guard(eventIdFromParam('id'))[FINAL_EVENT_GUARD_TAG]).toBe(true);
    });

    it('SCRUM382_AC3_the_default_for_a_router_built_without_a_guard_checks_nothing', async () => {
      const middleware = noopFinalEventGuard(eventIdFromParam('id'));
      expect(middleware[FINAL_EVENT_GUARD_TAG]).toBeUndefined();

      let nexted = 0;
      await middleware({ params: { id: eventByStatus.completed } }, {}, () => { nexted += 1; });

      expect(nexted).toBe(1);
    });

    it('SCRUM382_AC3_a_guard_for_one_route_does_not_affect_another', async () => {
      const first = guard(eventIdFromParam('id'));
      const second = guard(eventIdFromBody('eventRequestId'));

      expect((await run(first, { params: { id: eventByStatus.completed } })).nexted).toBe(0);
      expect((await run(second, { body: { eventRequestId: eventByStatus.approved } })).nexted).toBe(1);
      expect((await run(first, { params: { id: eventByStatus.approved } })).nexted).toBe(1);
    });

    it('SCRUM382_AC3_the_guard_reads_exactly_one_status_per_request', async () => {
      const reads = [];
      const spy = {
        from: (table) => {
          const chain = client.from(table);
          return {
            select: (cols) => { reads.push(`${table}:${cols}`); return chain.select(cols); },
          };
        },
      };
      await run(createFinalEventGuard({ client: spy })(eventIdFromParam('id')), { params: { id: eventByStatus.approved } });
      expect(reads).toEqual(['event_requests:status']);

      reads.length = 0;
      await run(createFinalEventGuard({ client: spy })(eventIdFromRecord('bookings', 'id')), {
        params: { id: attached.approved.booking },
      });
      expect(reads).toEqual(['bookings:event_request_id', 'event_requests:status']);
    });
  });
});
