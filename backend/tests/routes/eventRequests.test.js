/**
 * Tests for the event request routes.
 *
 * SCRUM-42, a subtask of SCRUM-14 (Track Event Request Status).
 *
 * These are transport tests. The status vocabulary is already proved by
 * tests/domain/eventRequestStatus.test.js and the queries by
 * tests/services/eventRequestService.test.js; what is unproved until here is
 * that a status survives the trip -- routing, ownership scoping, JSON
 * serialisation and the status code -- and arrives at React intact.
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- the Organiser can view the status of their own submitted request
 *   AC2 -- the status reflects the stages of the planning process
 *   AC3 -- awaiting action, under review, approved, rejected and confirmed are
 *          distinguishable from one another
 *   AC4 -- the displayed status is updated when the request changes
 *
 * Why the router is built here rather than imported from src/app.js: app.js
 * calls app.listen() at module scope and pulls in src/config/supabaseClient.js
 * through routes/auth.js, which throws without a .env. Mounting the exported
 * factory on a bare Express app tests the same routing with no credentials,
 * which is what lets this run in CI.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { STATUS, STATUS_DISPLAY, STATUS_FALLBACK } from '../../src/domain/eventRequestStatus.js';
import { ValidationError, NotFoundError } from '../../src/errors.js';


const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANISER_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';


/** A stored row, as PostgREST returns it. */
function storedRow(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'IS212 Industry Night',
    purpose: 'Connect final-year students with industry partners.',
    description: 'An evening of short talks followed by open networking.',
    proposed_start: '2026-06-01T09:00:00+00:00',
    proposed_end: '2026-06-01T17:00:00+00:00',
    expected_attendance: 120,
    venue_requirements: 'A large room, ideally tiered seating.',
    accessibility_requirements: null,
    equipment_requirements: null,
    status: STATUS.SUBMITTED,
    created_at: '2026-01-10T03:00:00+00:00',
    updated_at: '2026-01-12T03:00:00+00:00',
    submitted_at: '2026-01-11T03:00:00+00:00',
    ...overrides,
  };
}

/**
 * The same hand-rolled query-builder stand-in the service tests use, kept in
 * step with it deliberately: a second, subtly different fake would let a route
 * test pass against behaviour the service never had.
 */
function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table}`);
    }
    return Promise.resolve(queue.shift());
  }

  function builder(call) {
    const chain = {
      select(columns = '*') {
        call.select = columns;
        return chain;
      },
      eq(column, value) {
        call.filters.push([column, value]);
        return chain;
      },
      order(column, options) {
        call.order.push([column, options]);
        return chain;
      },
      single: () => settle(call),
      maybeSingle: () => settle(call),
      then: (resolve, reject) => settle(call).then(resolve, reject),
    };
    return chain;
  }

  return {
    calls,
    from(table) {
      const call = { table, operation: 'select', select: null, filters: [], order: [] };
      calls.push(call);
      return builder(call);
    },
  };
}

const ok = (data) => ({ data, error: null });

/** Stands in for a verified session. */
const signedInAs = (id) => (req, _res, next) => {
  req.user = { id, email: 'organiser@example.com' };
  next();
};

/** Stands in for no session at all, answering as the real middleware does. */
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/** An app with the router mounted where app.js mounts it. */
function appWith({ client, requireAuth = signedInAs(ORGANISER_ID) } = {}) {
  return express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
}


describe('AC1: the Organiser can view their submitted requests over HTTP', () => {
  it('SCRUM14_AC1_returns_200_and_an_array_for_the_signed_in_organiser', async () => {
    const client = createFakeClient([ok([storedRow(), storedRow({ id: 'b' })])]);

    const res = await request(appWith({ client })).get('/api/event-requests');

    expect(res.status).toBe(200);

    // A bare array, not a wrapper: MyEventRequests.jsx maps the response
    // directly, so the shape is part of the contract.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM14_AC1_scopes_the_query_to_the_token_not_the_query_string', async () => {
    const client = createFakeClient([ok([])]);

    await request(appWith({ client }))
      .get('/api/event-requests')
      .query({ organiserId: OTHER_ORGANISER_ID });

    // The whole of AC1's "their own". A query string asking for someone else's
    // requests changes nothing about which organiser is filtered on.
    expect(client.calls[0].filters).toEqual([['organiser_id', ORGANISER_ID]]);
  });

  it('SCRUM14_AC1_returns_401_without_a_token', async () => {
    const client = createFakeClient([ok([storedRow()])]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .get('/api/event-requests');

    expect(res.status).toBe(401);

    // Refused before the database is touched, not after.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM14_AC1_returns_401_on_the_status_endpoint_without_a_token', async () => {
    const res = await request(appWith({ client: createFakeClient([]), requireAuth: signedOut }))
      .get(`/api/event-requests/${REQUEST_ID}/status`);

    expect(res.status).toBe(401);
  });

  it('SCRUM14_AC1_returns_404_for_another_organisers_request', async () => {
    const client = createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // 404 rather than 403: a 403 would confirm the id exists.
    expect(res.status).toBe(404);
  });

  it('SCRUM14_AC1_returns_404_for_an_id_that_does_not_exist', async () => {
    const client = createFakeClient([ok(null)]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(404);
  });

  it('SCRUM14_AC1_answers_a_foreign_request_identically_to_a_missing_one', async () => {
    const foreign = await request(
      appWith({ client: createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    const missing = await request(
      appWith({ client: createFakeClient([ok(null)]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    // Identical status and body. Anything that distinguished them would let a
    // caller enumerate which ids exist.
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it('SCRUM14_AC1_serves_one_request_in_full_to_its_owner', async () => {
    const client = createFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: REQUEST_ID,
      eventName: 'IS212 Industry Night',
      status: STATUS.SUBMITTED,
    });
  });
});


describe('AC2: the response carries every stage of the planning process', () => {
  it.each(Object.values(STATUS))(
    'SCRUM14_AC2_serves_the_backend_label_and_description_for_%s',
    async (status) => {
      const client = createFakeClient([ok(storedRow({ status }))]);

      const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

      // Compared against the domain table rather than against strings copied
      // into this file: the point of SCRUM-42 is that the backend is the single
      // source of these words, so the test must read them from that source too.
      expect(res.body.statusDisplay).toEqual({
        status,
        label: STATUS_DISPLAY[status].label,
        group: STATUS_DISPLAY[status].group,
        description: STATUS_DISPLAY[status].description,
      });
    },
  );

  it('SCRUM14_AC2_keeps_the_raw_status_alongside_the_display', async () => {
    const client = createFakeClient([ok(storedRow({ status: STATUS.PLANNING }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // The frontend gates actions on the raw value ("continue editing" only on a
    // draft), so removing it in favour of the display object would break that.
    expect(res.body.status).toBe(STATUS.PLANNING);
  });

  it('SCRUM14_AC2_never_lets_the_status_description_overwrite_the_event_description', async () => {
    const client = createFakeClient([
      ok(storedRow({ description: 'An evening of short talks followed by open networking.' })),
    ]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // Both objects have a `description`. Spreading the status display onto the
    // request would silently replace what the Organiser typed with prose about
    // their status -- and only for the statuses that happen to have one.
    expect(res.body.description).toBe('An evening of short talks followed by open networking.');
    expect(res.body.statusDisplay.description).toBe(STATUS_DISPLAY[STATUS.SUBMITTED].description);
    expect(res.body.description).not.toBe(res.body.statusDisplay.description);
  });
});


describe('AC3: awaiting action, under review, approved, rejected and confirmed are distinguishable', () => {
  it('SCRUM14_AC3_sends_the_group_so_the_client_need_not_interpret_the_status', async () => {
    const client = createFakeClient([ok([storedRow({ status: STATUS.CONFIRMED })])]);

    const res = await request(appWith({ client })).get('/api/event-requests');

    // The group is the stable half of the contract: the frontend styles on it,
    // so a status added later maps into an existing group and needs no React
    // change. Sending only the raw status would put that mapping back on the
    // client, which is the duplication this sub-task removes.
    expect(res.body[0].statusDisplay.group).toBe('CONFIRMED');
  });

  it('SCRUM14_AC3_separates_waiting_on_connectsphere_from_waiting_on_the_organiser', async () => {
    const waiting = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: STATUS.SUBMITTED }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    const acting = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: STATUS.PENDING_CLARIFICATION }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    // The most useful thing the status page does: tell the Organiser whether to
    // wait or to go and do something. Both are "awaiting action" in AC3's
    // wording, and collapsing them would lose exactly that.
    expect(waiting.body.statusDisplay.group).toBe('AWAITING_REVIEW');
    expect(acting.body.statusDisplay.group).toBe('ACTION_REQUIRED');
  });

  it('SCRUM14_AC3_gives_every_terminal_outcome_its_own_group', async () => {
    const groups = [];

    for (const status of [STATUS.APPROVED, STATUS.REJECTED, STATUS.CONFIRMED, STATUS.COMPLETED]) {
      const res = await request(
        appWith({ client: createFakeClient([ok(storedRow({ status }))]) }),
      ).get(`/api/event-requests/${REQUEST_ID}`);
      groups.push(res.body.statusDisplay.group);
    }

    // Four outcomes AC3 names separately must not arrive as one another.
    expect(new Set(groups).size).toBe(4);
  });
});


describe('AC4: the status endpoint answers a refetch cheaply and freshly', () => {
  it('SCRUM14_AC4_serves_the_status_display_payload_on_its_own_endpoint', async () => {
    const client = createFakeClient([ok(storedRow({ status: STATUS.UNDER_REVIEW }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/status`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: REQUEST_ID,
      status: STATUS.UNDER_REVIEW,
      label: STATUS_DISPLAY[STATUS.UNDER_REVIEW].label,
      group: STATUS_DISPLAY[STATUS.UNDER_REVIEW].group,
      description: STATUS_DISPLAY[STATUS.UNDER_REVIEW].description,
    });
  });

  it('SCRUM14_AC4_includes_updated_at_so_a_change_is_detectable', async () => {
    const client = createFakeClient([ok(storedRow({ updated_at: '2026-01-12T03:00:00+00:00' }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/status`);

    // Maintained by the trigger in 001, so it is the one field that reliably
    // moves whenever anything about the request does.
    expect(res.body.updatedAt).toBe('2026-01-12T03:00:00+00:00');
  });

  it('SCRUM14_AC4_omits_the_request_body_fields', async () => {
    const client = createFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/status`);

    // The reason this endpoint exists rather than reusing GET /:id. If the
    // prose fields creep back in, a refetch-on-focus stops being cheap and the
    // distinction between the two routes quietly disappears.
    expect(res.body).not.toHaveProperty('eventName');
    expect(res.body).not.toHaveProperty('venueRequirements');
    expect(res.body).not.toHaveProperty('purpose');
    expect(Object.keys(res.body).sort()).toEqual(
      ['description', 'group', 'id', 'label', 'status', 'submittedAt', 'updatedAt'],
    );
  });

  it('SCRUM14_AC4_reflects_the_stored_status_on_each_call', async () => {
    // Two reads of the same id, with the status moved in between -- which is
    // what a Coordinator advancing the request looks like from here. This is
    // AC4 under the chosen strategy: the endpoint re-reads, it does not cache.
    const client = createFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED, updated_at: '2026-01-12T03:00:00+00:00' })),
      ok(storedRow({ status: STATUS.UNDER_REVIEW, updated_at: '2026-01-13T03:00:00+00:00' })),
    ]);
    const app = appWith({ client });

    const before = await request(app).get(`/api/event-requests/${REQUEST_ID}/status`);
    const after = await request(app).get(`/api/event-requests/${REQUEST_ID}/status`);

    expect(before.body.label).toBe('Submitted');
    expect(after.body.label).toBe('Under Review');
    expect(after.body.updatedAt).not.toBe(before.body.updatedAt);
  });

  it('SCRUM14_AC4_lists_the_most_recently_changed_request_first', async () => {
    const client = createFakeClient([ok([storedRow()])]);

    await request(appWith({ client })).get('/api/event-requests');

    expect(client.calls[0].order[0]).toEqual(['updated_at', { ascending: false }]);
  });

  it('SCRUM14_AC4_does_not_mistake_the_status_path_for_an_id', async () => {
    const client = createFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/status`);

    // If Express matched /:id here, the response would be a whole request and
    // the id filter would read 'status'.
    expect(res.body).not.toHaveProperty('statusDisplay');
    expect(client.calls[0].filters).toEqual([['id', REQUEST_ID]]);
  });
});


describe('SCRUM-47: an unavailable status is told apart from an unknown one over the wire', () => {
  it('SCRUM47_a_null_status_crosses_the_wire_as_UNAVAILABLE', async () => {
    const client = createFakeClient([ok(storedRow({ status: null }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.statusDisplay).toEqual({
      status: null,
      label: STATUS_FALLBACK.UNAVAILABLE.label,
      group: STATUS_FALLBACK.UNAVAILABLE.group,
      description: STATUS_FALLBACK.UNAVAILABLE.description,
    });
  });

  it('SCRUM47_a_null_status_serialises_as_null_rather_than_being_dropped', async () => {
    const client = createFakeClient([ok(storedRow({ status: null }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // JSON.stringify drops undefined values entirely, so a regression that
    // turned this null into undefined would make the key vanish -- and a
    // toMatchObject assertion would still pass. Asserting the key is present
    // AND null is what catches that.
    expect('status' in res.body.statusDisplay).toBe(true);
    expect(res.body.statusDisplay.status).toBeNull();
  });

  it('SCRUM47_an_unrecognised_status_crosses_the_wire_as_UNKNOWN', async () => {
    const client = createFakeClient([ok(storedRow({ status: 'awaiting_teleportation' }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.body.statusDisplay.group).toBe(STATUS_FALLBACK.UNKNOWN.group);
    expect(res.body.statusDisplay.group).not.toBe(STATUS_FALLBACK.UNAVAILABLE.group);
  });

  it('SCRUM47_the_unrecognised_value_is_echoed_so_it_can_be_reported', async () => {
    const client = createFakeClient([ok(storedRow({ status: 'awaiting_teleportation' }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // So an Organiser reading it to a Coordinator, or a log line, names the
    // actual value rather than "unknown".
    expect(res.body.statusDisplay.status).toBe('awaiting_teleportation');
  });

  it('SCRUM47_the_two_fallbacks_keep_different_descriptions_after_serialisation', async () => {
    const unavailable = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: null }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    const unknown = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: 'awaiting_teleportation' }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    // The single assertion that proves SCRUM-47 survived the wire rather than
    // being flattened into one "something went wrong".
    expect(unavailable.body.statusDisplay.group)
      .not.toBe(unknown.body.statusDisplay.group);
    expect(unavailable.body.statusDisplay.description)
      .not.toBe(unknown.body.statusDisplay.description);
  });

  it('SCRUM47_offers_retry_advice_only_where_retrying_could_work', async () => {
    const unavailable = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: null }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    const unknown = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: 'awaiting_teleportation' }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    // Nothing arrived, so a refresh may fix it. A value this build does not
    // know will still be unknown after a refresh, so it must not say so.
    expect(unavailable.body.statusDisplay.description).toMatch(/refresh/i);
    expect(unknown.body.statusDisplay.description).not.toMatch(/refresh/i);
  });

  it('SCRUM47_every_item_in_a_mixed_list_carries_a_status_display', async () => {
    const client = createFakeClient([
      ok([
        storedRow({ id: 'a', status: STATUS.SUBMITTED }),
        storedRow({ id: 'b', status: null }),
        storedRow({ id: 'c', status: 'awaiting_teleportation' }),
      ]),
    ]);

    const res = await request(appWith({ client })).get('/api/event-requests');

    expect(res.body).toHaveLength(3);
    for (const item of res.body) {
      expect(Object.keys(item.statusDisplay).sort())
        .toEqual(['description', 'group', 'label', 'status']);
    }

    // The list renders one badge per row, so one bad row must not blank the
    // others or take the whole page down.
    expect(res.body.map((item) => item.statusDisplay.group))
      .toEqual(['AWAITING_REVIEW', 'UNAVAILABLE', 'UNKNOWN']);
  });

  it('SCRUM47_the_status_endpoint_makes_the_same_distinction', async () => {
    const unavailable = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: null }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}/status`);

    const unknown = await request(
      appWith({ client: createFakeClient([ok(storedRow({ status: 'awaiting_teleportation' }))]) }),
    ).get(`/api/event-requests/${REQUEST_ID}/status`);

    // The flattened shape must not quietly lose what the nested one keeps.
    expect(unavailable.body.group).toBe('UNAVAILABLE');
    expect(unknown.body.group).toBe('UNKNOWN');
    expect(unavailable.body.description).not.toBe(unknown.body.description);
  });
});


describe('service errors are translated into HTTP status codes', () => {
  /** A client whose every call rejects with a given error. */
  const throwing = (err) => ({
    calls: [],
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        single: () => Promise.reject(err),
        maybeSingle: () => Promise.reject(err),
        then: (_resolve, reject) => Promise.reject(err).catch(reject),
      };
      return chain;
    },
  });

  it('SCRUM14_AC1_maps_a_not_found_error_to_404', async () => {
    const res = await request(appWith({ client: throwing(new NotFoundError('Event request x not found')) }))
      .get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('SCRUM14_AC1_maps_a_validation_error_to_400_with_its_details', async () => {
    const err = new ValidationError('Invalid event request details', [
      { field: 'organiserId', message: 'is required' },
    ]);

    const res = await request(appWith({ client: throwing(err) }))
      .get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(400);

    // Every gap at once, so a caller fixes a whole form in one pass.
    expect(res.body.details).toEqual([{ field: 'organiserId', message: 'is required' }]);
  });

  it('SCRUM14_AC1_maps_an_untyped_error_to_500_without_leaking_it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(
      appWith({ client: throwing(new Error('relation "event_requests" does not exist')) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });

    // The driver message goes to the log, never to the Organiser.
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
