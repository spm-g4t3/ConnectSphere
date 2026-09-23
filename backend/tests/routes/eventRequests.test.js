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


// ---------------------------------------------------------------------------
// SCRUM-29 / SCRUM-11 / SCRUM-10 / SCRUM-32 / SCRUM-34 -- the five routes that
// used to 404
// ---------------------------------------------------------------------------
/**
 * A writable stand-in for the supabase-js query builder.
 *
 * Declared separately rather than by extending createFakeClient above, and the
 * separation is deliberate: four describe blocks are already written against
 * that fake's exact behaviour, and it has no insert/update on purpose because
 * nothing it was written for writes. Adding them there would change a fixture
 * the existing suite depends on; adding them here changes nothing that already
 * passes.
 *
 * Copied from tests/services/eventRequestService.test.js so the two stay in
 * step -- a second, subtly different fake would let a route test pass against
 * behaviour the service never had. Running out of queued results throws loudly
 * rather than returning undefined, so a route that makes an unexpected extra
 * round trip fails with a legible message instead of a null dereference three
 * frames down.
 */
function createWritableFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(
        `fake client: no result queued for ${call.operation} on ${call.table}`,
      );
    }
    return Promise.resolve(queue.shift());
  }

  function builder(call) {
    const chain = {
      insert(payload) {
        call.operation = 'insert';
        call.payload = payload;
        return chain;
      },
      update(payload) {
        call.operation = 'update';
        call.payload = payload;
        return chain;
      },
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
      const call = {
        table,
        operation: 'select',
        payload: null,
        select: null,
        filters: [],
        order: [],
      };
      calls.push(call);
      return builder(call);
    },
  };
}

/** A Postgres failure, shaped as supabase-js surfaces it. */
const dbFailure = (code, message) => ({ data: null, error: { code, message } });

/**
 * A stored draft whose proposed period is always ahead of the real clock.
 *
 * The shared storedRow fixture above pins 2026-06-01, which is fine for every
 * read: nothing on a read path looks at the clock. Submission does --
 * validateSubmitEventRequest refuses a start that is not in the future -- and
 * `now` is NOT injectable through the route, because submitEventRequest
 * defaults it and the handler passes only { client }. So a fixed date here
 * would make these tests pass until that date arrived and then start failing
 * for a reason with nothing to do with the router. Computed a year out
 * instead, which is the only form of determinism available on this side of
 * the wire; the service tests pin the boundary with an injected `now`.
 */
function submittableRow(overrides = {}) {
  const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);

  return storedRow({
    status: STATUS.DRAFT,
    proposed_start: start.toISOString(),
    proposed_end: end.toISOString(),
    ...overrides,
  });
}

/** A stored change request row, as PostgREST returns it. */
function storedChangeRequestRow(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    event_request_id: REQUEST_ID,
    requested_by: ORGANISER_ID,
    change_field: 'venue',
    requested_change: 'A larger room, the RSVPs have doubled.',
    status: 'outstanding',
    decision: null,
    decision_notes: null,
    processed_by: null,
    processed_at: null,
    created_at: '2026-01-12T03:00:00+00:00',
    updated_at: '2026-01-12T03:00:00+00:00',
    ...overrides,
  };
}


describe('SCRUM-29: an Organiser creates a request over HTTP', () => {
  it('SCRUM29_AC3_returns_201_and_the_created_request_with_its_status_display', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client }))
      .post('/api/event-requests')
      .send({ eventName: 'IS212 Industry Night' });

    // 201 and a body, not 204. EventRequestForm reads saved.id and saved.status
    // straight off this response; a bodiless answer would force a refetch to
    // learn what was just created.
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(REQUEST_ID);
    expect(res.body.status).toBe(STATUS.DRAFT);

    // The same statusDisplay projection every other event-shaped response
    // carries, so the form renders a badge without a second request.
    expect(res.body.statusDisplay).toEqual({
      status: STATUS.DRAFT,
      label: STATUS_DISPLAY[STATUS.DRAFT].label,
      group: STATUS_DISPLAY[STATUS.DRAFT].group,
      description: STATUS_DISPLAY[STATUS.DRAFT].description,
    });
  });

  it('SCRUM29_AC3_stamps_the_organiser_from_the_token_not_the_body', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    await request(appWith({ client }))
      .post('/api/event-requests')
      .send({ eventName: 'IS212 Industry Night', organiserId: OTHER_ORGANISER_ID });

    // Mass assignment, closed. The body names another Organiser and the write
    // must still belong to the signed-in one. Without this assertion someone
    // "simplifying" toColumns into a spread of the request body would hand any
    // caller the ability to create rows owned by anybody, and every test above
    // would still pass because none of them post anything.
    expect(client.calls[0].operation).toBe('insert');
    expect(client.calls[0].payload.organiser_id).toBe(ORGANISER_ID);
    expect(client.calls[0].payload.organiser_id).not.toBe(OTHER_ORGANISER_ID);

    // And the camelCase key is not carried through as a column of its own --
    // PostgREST ignores keys no column matches, so it would vanish silently.
    expect(client.calls[0].payload).not.toHaveProperty('organiserId');
  });

  it('SCRUM29_AC3_drops_a_status_a_caller_tried_to_set', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    await request(appWith({ client }))
      .post('/api/event-requests')
      .send({
        eventName: 'IS212 Industry Night',
        status: STATUS.APPROVED,
        id: 'a-chosen-id',
        submittedAt: '2026-01-01T00:00:00+00:00',
      });

    // A request is born a draft whatever the body says. A caller who could
    // choose their own status would skip the Coordinator entirely; one who
    // could choose their own id would collide with, or overwrite, someone
    // else's row. The allow-list in toColumns is what stops both, and this is
    // the only test that would notice if it stopped being one.
    expect(client.calls[0].payload.status).toBe(STATUS.DRAFT);
    expect(client.calls[0].payload.id).toBeUndefined();
    expect(client.calls[0].payload.submitted_at).toBeUndefined();
    expect(client.calls[0].payload).not.toHaveProperty('submittedAt');
  });

  it('SCRUM29_AC3_returns_400_and_never_queries_without_an_event_name', async () => {
    const client = createWritableFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client })).post('/api/event-requests').send({});

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'eventName', message: 'is required' }]);

    // The gate has to bite before the query, not after. Validation runs before
    // the client is even resolved, so a bad form costs no round trip and the
    // Organiser gets a message about their form rather than a driver message
    // about a not-null constraint.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM29_AC3_returns_400_and_never_queries_for_a_body_that_is_not_an_object', async () => {
    const client = createWritableFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client }))
      .post('/api/event-requests')
      .set('Content-Type', 'application/json')
      .send('[1, 2, 3]');

    // An array parses as JSON and would survive a bare typeof check, so it is
    // worth its own case: there is nothing to enumerate field by field, and
    // the refusal names the shape rather than a field the caller never sent.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expected an object/i);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM29_AC3_returns_401_and_never_queries_without_a_token', async () => {
    const client = createWritableFakeClient([ok(storedRow())]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .post('/api/event-requests')
      .send({ eventName: 'IS212 Industry Night' });

    expect(res.status).toBe(401);

    // Refused by the middleware before the handler runs. An unauthenticated
    // POST that reached the service would have no organiser to stamp.
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-11: an Organiser saves edits to their own draft over HTTP', () => {
  it('SCRUM11_AC1_returns_200_and_the_saved_request', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.DRAFT })),
      ok(storedRow({ status: STATUS.DRAFT, event_name: 'IS212 Industry Evening' })),
    ]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'IS212 Industry Evening' });

    // 200 with the whole request rather than 204, for the same reason POST /
    // returns a body: the form reads saved.id and saved.status back off it.
    expect(res.status).toBe(200);
    expect(res.body.eventName).toBe('IS212 Industry Evening');
    expect(res.body.statusDisplay.status).toBe(STATUS.DRAFT);

    // Read then write, in that order, and only the field that changed is sent.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].operation).toBe('update');
    expect(client.calls[1].payload).toEqual({ event_name: 'IS212 Industry Evening' });
  });

  it('SCRUM11_AC1_guards_the_write_on_id_owner_and_draft_status', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.DRAFT })),
      ok(storedRow({ status: STATUS.DRAFT })),
    ]);

    await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ purpose: 'Connect final-year students with industry partners.' });

    // All three filters, in order, asserted as a whole rather than with
    // toContainEqual: each is doing separate work and dropping any one of them
    // is a different bug. The status filter is what stops a submit landing
    // between the read and the write from being silently overwritten; the
    // organiser filter can never fire, and exists so the statement sent to a
    // deny-all table is structurally incapable of touching a foreign row
    // rather than safe only because of a check made in an earlier round trip.
    expect(client.calls[1].filters).toEqual([
      ['id', REQUEST_ID],
      ['organiser_id', ORGANISER_ID],
      ['status', STATUS.DRAFT],
    ]);
  });

  it('SCRUM11_AC1_returns_409_when_a_submit_wins_the_race', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.DRAFT })),
      dbFailure('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
    ]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'IS212 Industry Evening' });

    // The read saw a draft and the write matched nothing, which can only mean
    // the status moved in between. 409, not 404: the row is certainly there,
    // and ownership was proved a moment ago, so there is no id to protect.
    // Translating this as a 404 would tell the Organiser their own request had
    // vanished; as a 500 it would tell them nothing at all.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer a draft/i);
    expect(res.body.error).toMatch(/reload/i);
  });

  it('SCRUM11_AC1_returns_409_for_a_request_that_is_already_submitted', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'IS212 Industry Evening' });

    expect(res.status).toBe(409);

    // The distinction the message has to carry: editing is closed, but asking
    // for a change is not. Without it an Organiser reads "conflict" and has no
    // idea what to do next.
    expect(res.body.error).toMatch(/request a change/i);

    // And the write was never attempted -- the status check is a gate, not a
    // filter that happens to match nothing.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].operation).toBe('select');
  });

  it('SCRUM11_AC1_returns_404_for_another_organisers_event_rather_than_400', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.DRAFT })),
    ]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'Not mine to rename' });

    // Named for the reason and not just the number, so it survives a refactor
    // that "tidies" the ownership check into something answering 400 or 403.
    // Both would confirm the id exists, which is exactly the enumeration
    // oracle errors.js refuses to build.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);

    // The read happened, the write did not.
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM11_AC1_returns_400_and_never_queries_for_an_empty_change_set', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({});

    // A precise 400 instead of an ambiguous 500. toColumns({}) is {}, so the
    // service would otherwise issue .update({}), whose PostgREST behaviour is
    // unspecified and untranslated.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no changes supplied/i);

    // Refused before the client is resolved, so an empty PATCH costs nothing.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM11_AC1_returns_400_and_never_queries_for_an_attempt_to_clear_the_name', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: '   ' });

    // event_name is not null in 001, so a cleared name would be bounced by the
    // column constraint a round trip later with a driver message naming a
    // column. Refusing it here names the field the Organiser can actually fix.
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain('eventName');
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM11_AC1_returns_401_and_never_queries_without_a_token', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'IS212 Industry Evening' });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-10: a draft is submitted for review over HTTP', () => {
  it('SCRUM10_AC5_returns_200_and_the_submitted_request', async () => {
    const client = createWritableFakeClient([
      // The route's ownership pre-check.
      ok(submittableRow()),
      // submitEventRequest's own read.
      ok(submittableRow()),
      // The guarded write.
      ok(submittableRow({ status: STATUS.SUBMITTED, submitted_at: '2026-01-15T09:00:00+00:00' })),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.SUBMITTED);
    expect(res.body.statusDisplay.group).toBe('AWAITING_REVIEW');

    // Only that it is there and is a string. `now` is not injectable through
    // the route -- submitEventRequest defaults it to the real clock -- so
    // asserting a value here would either assert the fixture back to itself or
    // pin a timestamp that moves on every run.
    expect(res.body).toHaveProperty('submittedAt');
    expect(typeof res.body.submittedAt).toBe('string');

    // That the write stamped one at all is the half of the contract the
    // fixture cannot prove: the row comes back with whatever was queued.
    expect(client.calls[2].operation).toBe('update');
    expect(typeof client.calls[2].payload.submitted_at).toBe('string');
    expect(Number.isNaN(new Date(client.calls[2].payload.submitted_at).getTime())).toBe(false);
  });

  it('SCRUM10_AC5_returns_404_for_another_organisers_draft', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.DRAFT })),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    // The single most important test in this file. submitEventRequest takes no
    // organiserId and checks nothing -- its own header says ownership belongs
    // to the caller -- so this route's pre-check is the only thing standing
    // between any authenticated Organiser and submitting somebody else's draft
    // by guessing its id. Delete the pre-check and every other test here still
    // passes; this one does not.
    expect(res.status).toBe(404);

    // Exactly one round trip: the pre-check refused, so the service was never
    // reached and no write was attempted against a foreign row.
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM10_AC5_returns_404_for_an_id_that_does_not_exist', async () => {
    const client = createWritableFakeClient([ok(null)]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    // Answered identically to the foreign case above, so the pair cannot be
    // used to learn which ids are real.
    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM10_AC4_returns_400_listing_every_gap_at_once', async () => {
    const incomplete = storedRow({
      status: STATUS.DRAFT,
      purpose: null,
      proposed_start: null,
      proposed_end: null,
      expected_attendance: null,
    });
    const client = createWritableFakeClient([ok(incomplete), ok(incomplete)]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    expect(res.status).toBe(400);

    // The whole of AC4: every gap in one answer, so the Organiser fixes the
    // form in a single pass instead of discovering the next missing field on
    // each retry. The form renders details[] as a list.
    expect(res.body.details.map((d) => d.field).sort()).toEqual([
      'expectedAttendance',
      'proposedEnd',
      'proposedStart',
      'purpose',
    ]);

    // Refused before the write. An incomplete request must not reach the
    // Coordinator's queue at all.
    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((call) => call.operation === 'select')).toBe(true);
  });

  it('SCRUM10_AC6_returns_409_for_a_request_that_is_already_submitted', async () => {
    // Complete and future-dated, so the only thing left to refuse is the
    // status. A past-dated fixture here would 400 on the dates and this test
    // would be proving nothing about "once and only once".
    const submitted = submittableRow({ status: STATUS.SUBMITTED });
    const client = createWritableFakeClient([ok(submitted), ok(submitted)]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    // 409 and not 400: the input was never the problem, the row's state was.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot be submitted/i);

    // And no second write landed, which is the whole of "once and only once".
    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((call) => call.operation === 'select')).toBe(true);
  });

  it('SCRUM10_AC6_returns_409_when_a_second_submit_wins_the_race', async () => {
    const client = createWritableFakeClient([
      ok(submittableRow()),
      ok(submittableRow()),
      dbFailure('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    // Both callers read a draft; the first write moved it and the second
    // matched no row. Without the .eq('status','draft') guard both writes
    // would land and submitted_at would be overwritten with the later instant,
    // measuring review turnaround from the wrong moment.
    expect(res.status).toBe(409);
    expect(client.calls[2].filters).toContainEqual(['status', STATUS.DRAFT]);
  });

  it('SCRUM10_AC5_returns_401_and_never_queries_without_a_token', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-32: a change request is raised against a submitted event over HTTP', () => {
  it('SCRUM32_AC1_returns_201_and_the_created_change_request', async () => {
    const client = createWritableFakeClient([
      // The route's ownership pre-check.
      ok(storedRow({ status: STATUS.SUBMITTED })),
      // createChangeRequest reloads the event for its own status/ownership check.
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: STATUS.SUBMITTED }),
      ok(storedChangeRequestRow()),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room, the RSVPs have doubled.' });

    expect(res.status).toBe(201);

    // The wire shape the form sends ({ field, details }) is translated into
    // the service's own names on the way in -- neither the route nor the
    // frontend has to learn the other's vocabulary.
    expect(client.calls[2].operation).toBe('insert');
    expect(client.calls[2].payload).toMatchObject({
      event_request_id: REQUEST_ID,
      requested_by: ORGANISER_ID,
      change_field: 'venue',
      requested_change: 'A larger room, the RSVPs have doubled.',
    });
    expect(res.body.changeField).toBe('venue');
  });

  it('SCRUM32_AC1_stamps_the_requester_from_the_token_not_the_body', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: STATUS.SUBMITTED }),
      ok(storedChangeRequestRow()),
    ]);

    await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({
        field: 'venue',
        details: 'A larger room, the RSVPs have doubled.',
        requestedBy: OTHER_ORGANISER_ID,
        eventRequestId: '99999999-9999-4999-8999-999999999999',
      });

    // Two mass-assignment holes closed at once: who asked, and which event it
    // is against. The id comes from the path and the requester from the token,
    // so a body naming either is ignored.
    expect(client.calls[2].payload.requested_by).toBe(ORGANISER_ID);
    expect(client.calls[2].payload.event_request_id).toBe(REQUEST_ID);
  });

  it('SCRUM32_AC1_does_not_label_a_change_request_with_the_event_status_vocabulary', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: STATUS.SUBMITTED }),
      ok(storedChangeRequestRow({ status: 'outstanding' })),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room, the RSVPs have doubled.' });

    // withStatusDisplay speaks the *event* vocabulary. A change request's
    // statuses are its own -- 'outstanding', 'in_progress', 'processed' -- so
    // running this response through it would stamp every row UNKNOWN and look
    // like corrupt data rather than the wrong helper.
    expect(res.body).not.toHaveProperty('statusDisplay');
    expect(res.body.status).toBe('outstanding');
  });

  it('SCRUM32_AC1_returns_404_for_another_organisers_event_rather_than_400', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.SUBMITTED })),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room.' });

    // Named for the reason. createChangeRequest answers 400 for a foreign
    // event and 404 for one that does not exist, which tells a caller the
    // difference -- an enumeration oracle sitting in the same router as three
    // routes built not to be one. The pre-check settles it at 404 on the way
    // in; the service's own check stays as defence in depth.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(400);

    // And the insert never happened.
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM32_AC2_returns_400_for_a_field_outside_the_vocabulary', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'accessibilityRequirements', details: 'Step-free access.' });

    // The enum has no accessibility member and is not getting one -- the
    // frontend maps that option to 'other' before it leaves the browser. A
    // camelCase option name arriving here is a client that skipped the map,
    // and it must be refused rather than stored as an unreadable change_field.
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain('changeField');

    // One round trip, the ownership pre-check, and no insert. The pre-check is
    // deliberately ahead of validation: it is what makes a foreign event
    // indistinguishable from a missing one whatever the body says.
    expect(client.calls).toHaveLength(1);
    expect(client.calls.every((call) => call.operation === 'select')).toBe(true);
  });

  it('SCRUM32_AC1_returns_400_for_a_change_requested_against_a_draft', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.DRAFT })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: STATUS.DRAFT }),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room.' });

    // AC1's boundary: a draft is edited directly through the PATCH above.
    // Allowing a change request against one would give the same edit two
    // competing representations and fill the Coordinator's queue with requests
    // nobody needed to make.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft/i);
    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((call) => call.operation === 'select')).toBe(true);
  });

  it('SCRUM32_AC1_returns_401_and_never_queries_without_a_token', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room.' });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-34: the change requests for one event are listed over HTTP', () => {
  it('SCRUM34_AC4_returns_200_and_a_bare_array', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID }),
      ok([
        storedChangeRequestRow({ id: 'newer', created_at: '2026-01-13T03:00:00+00:00' }),
        storedChangeRequestRow({ id: 'older', created_at: '2026-01-12T03:00:00+00:00' }),
      ]),
    ]);

    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    expect(res.status).toBe(200);

    // A bare array, like GET / above: ChangeRequestStatusList maps the
    // response directly, so a { items: [...] } wrapper would cost a frontend
    // change and buy nothing. This is also the call that was polling a 404
    // every fifteen seconds before the route existed.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    // Newest first, asked of the database rather than sorted in JS, and scoped
    // to this event rather than filtered after the fact.
    expect(client.calls[2].order[0]).toEqual(['created_at', { ascending: false }]);
    expect(client.calls[2].filters).toEqual([['event_request_id', REQUEST_ID]]);
  });

  it('SCRUM34_AC4_carries_the_field_label_the_list_renders', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID }),
      ok([storedChangeRequestRow({ change_field: 'venue' })]),
    ]);

    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // The list is the only place fieldLabel and details appear -- the POST
    // response is toChangeRequest and carries neither, which is why the
    // frontend refetches after creating one instead of splicing the response
    // into the list it already has.
    expect(res.body[0].fieldLabel).toBe('Venue');
    expect(res.body[0].details).toBe('A larger room, the RSVPs have doubled.');

    // And the internal names survive alongside them, so nothing already
    // reading changeField breaks.
    expect(res.body[0].changeField).toBe('venue');
  });

  it('SCRUM34_AC4_does_not_label_the_rows_with_the_event_status_vocabulary', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID }),
      ok([storedChangeRequestRow({ status: 'outstanding' })]),
    ]);

    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // 'outstanding' is not an event status, so withStatusDisplay would render
    // it as UNKNOWN on every row of a perfectly healthy list.
    expect(res.body[0]).not.toHaveProperty('statusDisplay');
    expect(res.body[0].status).toBe('outstanding');
  });

  it('SCRUM34_AC4_returns_200_and_an_empty_array_when_there_are_none', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ status: STATUS.SUBMITTED })),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID }),
      ok([]),
    ]);

    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // "None yet" is the ordinary state of a request nobody has needed to
    // change. A 404 here would make the poll render an error on every healthy
    // event, which is the worst possible reading of an empty list.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM34_AC4_returns_404_for_another_organisers_event_rather_than_400', async () => {
    const client = createWritableFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.SUBMITTED })),
    ]);

    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // getChangeRequestsForEvent answers 400 for a foreign event and 404 for a
    // missing one. Named for the reason rather than the number so a later
    // refactor that "simplifies" the pre-check away is caught by a test that
    // says why it was there.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(400);

    // One round trip, and the change request table was never read.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_requests');
  });

  it('SCRUM34_AC4_answers_a_foreign_event_identically_to_a_missing_one', async () => {
    const foreign = await request(
      appWith({
        client: createWritableFakeClient([
          ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.SUBMITTED })),
        ]),
      }),
    ).get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    const missing = await request(
      appWith({ client: createWritableFakeClient([ok(null)]) }),
    ).get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // The same indistinguishability GET /:id already proves, restated for the
    // route that would otherwise leak it -- a caller who can tell the two
    // apart can enumerate which event ids exist.
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it('SCRUM34_AC4_returns_401_and_never_queries_without_a_token', async () => {
    const client = createWritableFakeClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});
