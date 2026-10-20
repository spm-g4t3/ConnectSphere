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
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';


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
      // SCRUM-491: the hold candidates read names with .in(), as
      // equipmentReviewService does.
      in(column, values) {
        call.filters.push([column, values]);
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

/** Stands in for a verified session. */
const signedInAs = (id) => (req, _res, next) => {
  req.user = { id, email: 'organiser@example.com' };
  next();
};

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
    const client = createFakeClient([ok(storedRow({ status: STATUS.APPROVED }))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    // The frontend gates actions on the raw value ("continue editing" only on a
    // draft), so removing it in favour of the display object would break that.
    expect(res.body.status).toBe(STATUS.APPROVED);
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

    expect(before.body.label).toBe('Requested');
    expect(after.body.label).toBe('Under review');
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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

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
    const client = createEventRequestClient([ok(storedRow())]);

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
    const client = createEventRequestClient([ok(storedRow())]);

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
    const client = createEventRequestClient([ok(storedRow())]);

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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.DRAFT })),
      dbError('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .patch(`/api/event-requests/${REQUEST_ID}`)
      .send({ eventName: 'IS212 Industry Evening' });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM-46: clarification returns between Coordinator and Organiser', () => {
  const coordinatorAuth = (req, _res, next) => {
    req.user = { id: OTHER_ORGANISER_ID, role: 'event_coordinator' };
    next();
  };

  it('allows the assigned Coordinator to request clarification with a required note and optional reply-by date', async () => {
    // SCRUM-332: the event is now assigned to the signed-in coordinator, and
    // the fixture says so. Without it the row has no coordinator, which only
    // worked while the service ignored who was asking.
    //
    // Under review, not submitted as in dev before SCRUM-162: clarification is
    // asked for from under_review only, and a submitted request is refused.
    const note = 'Please clarify the proposed event purpose.';
    const replyByDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: OTHER_ORGANISER_ID })),
      ok(storedRow({
        status: STATUS.PENDING_CLARIFICATION,
        clarification_note: note,
        clarification_reply_by_date: replyByDate,
        assigned_coordinator_id: OTHER_ORGANISER_ID,
      })),
    ]);

    const res = await request(appWith({ client, requireAuth: coordinatorAuth }))
      .post(`/api/event-requests/${REQUEST_ID}/clarification`)
      .send({ note, replyByDate, requestedFields: ['purpose', 'proposedStart'] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.PENDING_CLARIFICATION);
    expect(res.body.clarificationNote).toBe(note);
    expect(res.body.clarificationReplyByDate).toBe(replyByDate);

    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[1].fn).toBe('request_event_clarification_with_fields');
    expect(client.calls[1].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_changed_by: OTHER_ORGANISER_ID,
      p_expected_coordinator: OTHER_ORGANISER_ID,
      p_reason: note,
      p_reply_by_date: replyByDate,
      p_requested_fields: ['purpose', 'proposedStart'],
    });
  });

  it('refuses clarification requests from non-Coordinators before database access', async () => {
    const client = createEventRequestClient([]);
    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/clarification`)
      .send({ note: 'Please clarify.' });

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('allows the owning Organiser to reply and return the request to review', async () => {
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.PENDING_CLARIFICATION, clarification_note: 'Clarify purpose.' })),
      ok(storedRow({
        status: STATUS.UNDER_REVIEW,
        clarification_note: null,
      })),
    ]);

    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}/clarification-response`)
      .send({ message: 'The event is invitation-only.', amendments: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.UNDER_REVIEW);
    expect(res.body.clarificationNote).toBeNull();
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[1].fn).toBe('reply_to_event_clarification_with_amendments');
    expect(client.calls[1].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_organiser_id: ORGANISER_ID,
      p_reply: 'The event is invitation-only.',
      p_updates: {},
    });
  });

  it('does not accept request-field payloads outside the amendments object', async () => {
    const client = createEventRequestClient([]);
    const res = await request(appWith({ client }))
      .patch(`/api/event-requests/${REQUEST_ID}/clarification-response`)
      .send({ description: 'Changed the event description.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reply is required/i);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM-46: Coordinators can read organiser change requests', () => {
  const coordinatorAuth = (req, _res, next) => {
    req.user = { id: OTHER_ORGANISER_ID, role: 'event_coordinator' };
    next();
  };

  it('returns the change field, requested value, and status to Coordinators', async () => {
    const client = createFakeClient([ok([storedChangeRequestRow()])]);
    const res = await request(appWith({ client, requireAuth: coordinatorAuth }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests/review`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{
      fieldLabel: 'Venue',
      details: 'A larger room, the RSVPs have doubled.',
      status: 'outstanding',
    }]);
    expect(client.calls[0].table).toBe('event_change_requests');
    expect(client.calls[0].filters).toContainEqual(['event_request_id', REQUEST_ID]);
  });

  it('denies the Coordinator review endpoint to non-Coordinator roles', async () => {
    const client = createFakeClient([]);
    const res = await request(appWith({ client }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests/review`);

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM-47: Coordinators decide organiser change requests', () => {
  const coordinatorAuth = (req, _res, next) => {
    req.user = { id: OTHER_ORGANISER_ID, role: 'event_coordinator' };
    next();
  };

  it('passes approval to the atomic database function', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: storedChangeRequestRow({
        status: 'processed',
        decision: 'approved',
        processed_by: OTHER_ORGANISER_ID,
      }),
      error: null,
    });
    const res = await request(appWith({ client: { rpc }, requireAuth: coordinatorAuth }))
      .post('/api/event-requests/change-requests/44444444-4444-4444-8444-444444444444/decision')
      .send({ decision: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.decision).toBe('approved');
    expect(rpc).toHaveBeenCalledWith('process_change_request', {
      p_change_request_id: '44444444-4444-4444-8444-444444444444',
      p_decision: 'approved',
      p_decision_notes: null,
      p_processed_by: OTHER_ORGANISER_ID,
    });
  });

  it('requires a rejection reason before reaching the database', async () => {
    const rpc = vi.fn();
    const res = await request(appWith({ client: { rpc }, requireAuth: coordinatorAuth }))
      .post('/api/event-requests/change-requests/44444444-4444-4444-8444-444444444444/decision')
      .send({ decision: 'rejected' });

    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({
      field: 'decisionNotes',
      message: 'is required when rejecting a change request',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('denies decisions from non-Coordinator roles', async () => {
    const rpc = vi.fn();
    const res = await request(appWith({ client: { rpc } }))
      .post('/api/event-requests/change-requests/44444444-4444-4444-8444-444444444444/decision')
      .send({ decision: 'approved' });

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('SCRUM-10: a draft is submitted for review over HTTP', () => {
  it('SCRUM10_AC5_returns_200_and_the_submitted_request', async () => {
    const client = createEventRequestClient([
      // The route's ownership pre-check.
      ok(submittableRow()),
      // submitEventRequest's own read.
      ok(submittableRow()),
      // submit_event_request (052): the row as the function leaves it --
      // submitted and timed, with no coordinator. Until SCRUM-486 this was
      // "and assigned a coordinator (SCRUM-330)", and the fixture carried one,
      // because 016 assigned it. 052 leaves that to the Lead.
      ok(submittableRow({
        status: STATUS.SUBMITTED,
        submitted_at: '2026-01-15T09:00:00+00:00',
        assigned_coordinator_id: null,
      })),
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

    // That a submission time was actually sent is the half of the contract the
    // fixture cannot prove, because the row comes back with whatever was
    // queued. Since SCRUM-330 the time travels as an argument to the
    // function, not in an update payload, so that is where it is checked.
    // The exact value is not asserted, for the reason given above; the
    // service tests pin it with an injected `now`.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2].operation).toBe('rpc');
    expect(client.calls[2].fn).toBe('submit_event_request');
    expect(client.calls[2].args.p_event_request_id).toBe(REQUEST_ID);
    // SCRUM-321: the status history records the signed-in Organiser, from the
    // token, as the person who submitted.
    expect(client.calls[2].args.p_changed_by).toBe(ORGANISER_ID);
    expect(typeof client.calls[2].args.p_submitted_at).toBe('string');
    expect(Number.isNaN(new Date(client.calls[2].args.p_submitted_at).getTime())).toBe(false);

    // SCRUM-486 AC1-04: the response says nobody is assigned yet -- the key
    // present and null, which is what the Organiser's screen reads to say the
    // request is waiting for the Lead. Until SCRUM-486 this asserted the
    // coordinator 016 had assigned ("the Organiser sees their coordinator",
    // SCRUM-327), and was right then.
    expect(res.body).toHaveProperty('assignedCoordinatorId', null);
  });

  it('SCRUM10_AC5_returns_404_for_another_organisers_draft', async () => {
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([ok(null)]);

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
    const client = createEventRequestClient([ok(incomplete), ok(incomplete)]);

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
    //
    // Since SCRUM-330, "once and only once" is no longer a status test in the
    // service. It is submit_event_request's draft check, made while holding
    // the row lock. So the service passes a row it read as 'submitted' straight
    // to the function, and the refusal comes back from there as 55000 with
    // the function's own message.
    const submitted = submittableRow({ status: STATUS.SUBMITTED });
    const client = createEventRequestClient([
      ok(submitted),
      ok(submitted),
      dbError(
        '55000',
        `event request ${REQUEST_ID} has status submitted, and only a draft can be submitted`,
      ),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    // 409 and not 400: the input was never the problem, the row's state was.
    // The message names the status the function found, so the Organiser
    // knows why. Matched as "has status submitted" rather than "submitted"
    // alone, because the word also appears in "can be submitted".
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has status submitted/);

    // The refusal came from the function, and the service wrote nothing of
    // its own around it.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2].operation).toBe('rpc');
    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
  });

  it('SCRUM10_AC6_returns_409_when_a_second_submit_wins_the_race', async () => {
    // Two submits of the same draft arrive together: a double-clicked button,
    // a retried request, two tabs. Unlike the test above, BOTH reads see a
    // draft here, so the service has no way to refuse. The race is decided
    // inside submit_event_request. The first call locks the row (`for update`).
    // The second call's function waits for that lock, then reads the row as
    // the first left it, now 'submitted', and raises 55000. This fake plays the
    // second caller.
    //
    // What the lock protects is the first submission's record. The second
    // call is refused before its UPDATE, so the first submission's
    // submitted_at is not overwritten with a later instant, and review
    // turnaround is still measured from the right moment. No second
    // coordinator is assigned and no second history row is written either.
    // That happens inside the database and a fake cannot observe it. What
    // the fake can observe is the service's part: the refusal arrives as a
    // 409, and the service attempts no write of its own afterwards.
    const client = createEventRequestClient([
      ok(submittableRow()),
      ok(submittableRow()),
      dbError(
        '55000',
        `event request ${REQUEST_ID} has status submitted, and only a draft can be submitted`,
      ),
    ]);

    const res = await request(appWith({ client }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    expect(res.status).toBe(409);
    expect(client.calls.filter((call) => call.operation === 'rpc')).toHaveLength(1);
    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
  });

  it('SCRUM10_AC5_returns_401_and_never_queries_without_a_token', async () => {
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .post(`/api/event-requests/${REQUEST_ID}/submit`)
      .send({});

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-32: a change request is raised against a submitted event over HTTP', () => {
  it('SCRUM32_AC1_returns_201_and_the_created_change_request', async () => {
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ field: 'venue', details: 'A larger room.' });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-34: the change requests for one event are listed over HTTP', () => {
  it('SCRUM34_AC4_returns_200_and_a_bare_array', async () => {
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
    const client = createEventRequestClient([
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
        client: createEventRequestClient([
          ok(storedRow({ organiser_id: OTHER_ORGANISER_ID, status: STATUS.SUBMITTED })),
        ]),
      }),
    ).get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    const missing = await request(
      appWith({ client: createEventRequestClient([ok(null)]) }),
    ).get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    // The same indistinguishability GET /:id already proves, restated for the
    // route that would otherwise leak it -- a caller who can tell the two
    // apart can enumerate which event ids exist.
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it('SCRUM34_AC4_returns_401_and_never_queries_without_a_token', async () => {
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.SUBMITTED }))]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-45 -- GET /api/event-requests/queue, the Event Coordinator's queue
// ---------------------------------------------------------------------------
/**
 * A third fake and a second auth stub, both appended rather than folded into
 * the ones above.
 *
 * createFakeClient and createEventRequestClient record .in() into `filters`,
 * which cannot show that no organiser_id eq() was made.
 *
 * .in() is recorded into its own list rather than into `filters`, so a test
 * can assert both that the status IN list is there and that no organiser_id
 * eq() is -- the absence being the whole of the reported bug.
 *
 * signedInWithRole sits beside signedInAs rather than replacing it, and that
 * is load-bearing rather than tidy: signedInAs sets no role at all, and the
 * fact that every other test in this file keeps using it is what proves the
 * coordinator gate never leaked onto the Organiser's own routes. Widening the
 * existing stub would quietly destroy that evidence. The two-stub shape is
 * copied from tests/routes/venues.test.js, which has had a role-carrying stub
 * since SCRUM-15.
 *
 * Imports are appended for the same reason the service suite appends its own:
 * an ESM import declaration is hoisted wherever it is written, and nothing
 * above this line may move.
 *
 * Acceptance criteria carried in the names:
 *   AC1 -- a Coordinator sees every request that is awaiting a decision
 *   AC2 -- and nobody else can
 */
import { ROLE } from '../../src/domain/userRole.js';
import { COORDINATOR_QUEUE_STATUSES } from '../../src/domain/eventRequestStatus.js';


const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';

function createQueueFakeClient(results = []) {
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
      in(column, values) {
        call.inFilters.push([column, values]);
        return chain;
      },
      // SCRUM-486 (SCRUM-520): the review queue now also reads
      // .not('assigned_coordinator_id', 'is', null). Recorded on its own, as
      // in the service tests' fake.
      not(column, operator, value) {
        call.notFilters.push([column, operator, value]);
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
        select: null,
        filters: [],
        inFilters: [],
        notFilters: [],
        order: [],
      };
      calls.push(call);
      return builder(call);
    },
  };
}

const signedInWithRole = signedInFor(COORDINATOR_ID, 'coordinator@example.com');

/**
 * A queue as PostgREST would hand it back: two Organisers, three statuses.
 *
 * SCRUM-486 (SCRUM-520): each row now has a coordinator. These rows had none,
 * which was right when written, because the queue did not select on the
 * coordinator. Since 052 it reads only requests someone holds (AC2-06), so a
 * row without one is a response the route can no longer receive, and a test
 * passing on it would pass on data production cannot produce.
 */
const queueRows = () => [
  storedRow({
    id: 'queue-1',
    organiser_id: ORGANISER_ID,
    status: STATUS.SUBMITTED,
    submitted_at: '2026-01-11T03:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
  }),
  storedRow({
    id: 'queue-2',
    organiser_id: OTHER_ORGANISER_ID,
    status: STATUS.UNDER_REVIEW,
    submitted_at: '2026-01-12T03:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
  }),
  storedRow({
    id: 'queue-3',
    organiser_id: OTHER_ORGANISER_ID,
    status: STATUS.PENDING_CLARIFICATION,
    submitted_at: null,
    assigned_coordinator_id: COORDINATOR_ID,
  }),
];


describe('SCRUM-45 AC1: a Coordinator reads the review queue over HTTP', () => {
  it('SCRUM45_AC1_returns_200_and_a_bare_array_for_a_coordinator', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    expect(res.status).toBe(200);

    // A bare array, not { items: [...] }, matching GET / above: the
    // Coordinator dashboard maps the response directly.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });

  it('SCRUM45_AC1_carries_the_status_display_on_every_row', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    // One status vocabulary for both screens. The Coordinator's badge is
    // rendered by the same frontend helper the Organiser's list uses, so a
    // row arriving without statusDisplay would render as a blank badge rather
    // than as an error anyone would notice.
    for (const row of res.body) {
      expect(row.statusDisplay).toBeDefined();
      expect(row.statusDisplay.status).toBe(row.status);
      expect(row.statusDisplay.label).toBe(STATUS_DISPLAY[row.status].label);
      expect(row.statusDisplay.group).toBe(STATUS_DISPLAY[row.status].group);
    }

    // And none of them fell through to a fallback, which is what a status the
    // queue admits but the vocabulary does not would look like.
    expect(res.body.map((row) => row.statusDisplay.label))
      .not.toContain(STATUS_FALLBACK.UNKNOWN.label);
  });

  it('SCRUM45_AC1_returns_a_request_belonging_to_another_organiser', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    // The reported bug, asserted end to end: an Organiser submits a request
    // and it never appears on the Coordinator side. Every other route in this
    // file answers 404 for a row belonging to somebody else -- deliberately,
    // and there are tests above that say so. This one must not, and the
    // signed-in caller owning none of these rows is the point.
    const owners = res.body.map((row) => row.organiserId);
    expect(owners).toContain(ORGANISER_ID);
    expect(owners).toContain(OTHER_ORGANISER_ID);
    expect(owners).not.toContain(COORDINATOR_ID);

    // And no eq() narrowed the read to the caller on the way out.
    expect(client.calls[0].filters).toEqual([]);
  });

  it('SCRUM45_AC1_answers_an_empty_queue_with_200_and_not_404', async () => {
    const client = createQueueFakeClient([ok([])]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    // Nothing waiting is the good state of this screen, not a missing
    // resource. A 404 would make the dashboard render an error every time the
    // team was caught up.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM45_AC1_does_not_read_the_queue_path_as_a_request_id', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    // Declaration order in the router is genuinely load-bearing here, unlike
    // everywhere else in that file: '/queue' and '/:id' both match a single
    // segment, so declared after GET /:id Express would match this with
    // id === 'queue', hand Postgres a uuid comparison against a word, and
    // answer 500 out of an unrecognised 22P02. The symptom is asserted from
    // the outside -- one status-filtered read, no id filter, and not a 500.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(500);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].inFilters).toEqual([['status', COORDINATOR_QUEUE_STATUSES]]);
    expect(client.calls[0].filters).not.toContainEqual(['id', 'queue']);
  });

  it('SCRUM45_AC1_answers_a_server_fault_with_500_and_leaks_nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createQueueFakeClient([
      dbError('42P01', 'relation "event_requests" does not exist'),
    ]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get('/api/event-requests/queue');

    expect(res.status).toBe(500);

    // The driver message goes to the log, never to the Coordinator, and a
    // fault must not be dressed up as an empty queue either.
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
    expect(res.body).not.toEqual([]);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});


describe('SCRUM-45 AC2: the queue is restricted, and the restriction stays put', () => {
  it('SCRUM45_AC2_refuses_an_organiser_with_403_and_never_queries', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID) }),
    ).get('/api/event-requests/queue');

    expect(res.status).toBe(403);

    // Refused before the database is touched. A gate that queried first and
    // discarded the rows would still be a gate, but it would put every
    // Organiser's request through a read that nothing narrows.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM45_AC2_refuses_a_caller_with_no_role_at_all', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    // signedInAs -- the stub the rest of this file uses -- sets no role, which
    // is also what requireAuth resolves for an authenticated account with no
    // profiles row. Closed by default, and pinned here rather than left to
    // the middleware's own suite, because this is the one path in this router
    // where it decides whether somebody sees other people's requests.
    const res = await request(appWith({ client, requireAuth: signedInAs(ORGANISER_ID) }))
      .get('/api/event-requests/queue');

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM45_AC2_names_event_coordinators_in_the_403', async () => {
    const res = await request(
      appWith({
        client: createQueueFakeClient([]),
        requireAuth: signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID),
      }),
    ).get('/api/event-requests/queue');

    // The message names the role that would work rather than the one the
    // caller has: "you are an Event Organiser" is not actionable, "this is
    // restricted to Event Coordinators" tells them who to ask.
    expect(res.body.error).toMatch(/Event Coordinators/);
  });

  it('SCRUM45_AC2_returns_401_without_a_token_and_never_queries', async () => {
    const client = createQueueFakeClient([ok(queueRows())]);

    const res = await request(appWith({ client, requireAuth: signedOut }))
      .get('/api/event-requests/queue');

    // 401 and not 403: a missing token is something the caller can fix by
    // signing in, and requireAuth runs first because it is mounted on the
    // router while the role gate is a per-route argument.
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM45_AC2_the_role_gate_does_not_reach_the_organisers_own_routes', async () => {
    const client = createQueueFakeClient([ok([storedRow()])]);

    // The regression guard for every other test in this repository, and the
    // reason it is written as its own case rather than trusted to the ones
    // above. Nothing in the production file pins that coordinatorOnly is a
    // per-route argument: moving it to router.use would read as a tidy-up,
    // would keep the queue working, and would make all eight Organiser routes
    // answer 403 at once -- because the fake authenticator this suite uses
    // sets no role, and neither does requireAuth for an account whose
    // profiles row has not been written yet.
    //
    // Deliberately uses signedInAs, the role-less stub, on the Organiser's
    // own list. If this ever fails with a 403, the gate has been mounted
    // router-wide; nothing else can produce that result.
    const res = await request(appWith({ client, requireAuth: signedInAs(ORGANISER_ID) }))
      .get('/api/event-requests');

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(403);
    expect(Array.isArray(res.body)).toBe(true);

    // And the read really happened, scoped to the caller as it always was --
    // so this is passing because the route ran, not because something short
    // circuited into an empty 200.
    expect(client.calls[0].filters).toEqual([['organiser_id', ORGANISER_ID]]);
  });
});

// ---------------------------------------------------------------------------
// SCRUM-331 -- the assigned coordinator hands an event to a colleague over HTTP
// ---------------------------------------------------------------------------
// POST /api/event-requests/:id/reassign, body { newCoordinatorId, handoverNote }.
// Behind coordinatorOnly, like every other Coordinator write in this router,
// and with no ownership pre-check: the caller is a coordinator, not the
// Organiser, and whether they hold this event is the one thing reassign_event_
// request (018) checks under its row lock. So the route's only job is to pass
// on what was asked, take the caller from the token, and turn the function's
// refusals into status codes.
//
// Named after SCRUM-327's criteria:
//   AC6 -- only the assigned coordinator may hand the event over
//   AC7 -- the new coordinator can act on the event once it is handed over
//   AC9 -- the handover records who made it, and the note

/** The colleague the event is handed to. COORDINATOR_ID is the one handing it over. */
const NEW_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';

const HANDOVER_NOTE = 'On leave from Monday. The venue shortlist is in the notes.';

/** The row reassign_event_request returns after an undecided handover. */
const handedOverRow = () => storedRow({
  status: STATUS.UNDER_REVIEW,
  assigned_coordinator_id: NEW_COORDINATOR_ID,
  reviewing_coordinator_id: NEW_COORDINATOR_ID,
});

/** POST the handover as the outgoing coordinator, unless told otherwise. */
const handOver = (client, body, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
  request(appWith({ client, requireAuth }))
    .post(`/api/event-requests/${REQUEST_ID}/reassign`)
    .send(body);

describe('SCRUM-331: a coordinator hands an event to a colleague over HTTP', () => {
  it('SCRUM331_AC7_the_new_coordinator_can_act_on_the_event', async () => {
    const client = createEventRequestClient([ok(handedOverRow())]);

    const res = await handOver(client, {
      newCoordinatorId: NEW_COORDINATOR_ID,
      handoverNote: HANDOVER_NOTE,
    });

    // 200 and the whole request, the same shape submit and the reads return,
    // so the Coordinator's screen can redraw from the response. Both
    // coordinator fields are checked: the event is now the new coordinator's,
    // and so is the right to decide it.
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(REQUEST_ID);
    expect(res.body.assignedCoordinatorId).toBe(NEW_COORDINATOR_ID);
    expect(res.body.reviewingCoordinatorId).toBe(NEW_COORDINATOR_ID);
    expect(res.body.statusDisplay.label).toBe('Under review');
  });

  it('SCRUM331_AC9_records_who_handed_it_over', async () => {
    // The person handing over comes from the token, never from the body. The
    // body below names someone else as the one handing over, and that is
    // ignored. Without this, any coordinator could make a handover look as if
    // the assigned coordinator had made it, and the function's AC6 check
    // would compare the wrong person.
    const client = createEventRequestClient([ok(handedOverRow())]);

    const res = await handOver(client, {
      newCoordinatorId: NEW_COORDINATOR_ID,
      handoverNote: HANDOVER_NOTE,
      assignedBy: OTHER_ORGANISER_ID,
    });

    expect(res.status).toBe(200);
    expect(client.calls[0].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_new_coordinator_id: NEW_COORDINATOR_ID,
      p_assigned_by: COORDINATOR_ID,
      p_handover_note: HANDOVER_NOTE,
    });
  });

  it('SCRUM331_AC9_the_handover_note_is_optional', async () => {
    // A handover with no note is still a handover. It reaches the function as
    // null, which is how 014's history table records "no note".
    const client = createEventRequestClient([ok(handedOverRow())]);

    const res = await handOver(client, { newCoordinatorId: NEW_COORDINATOR_ID });

    expect(res.status).toBe(200);
    expect(client.calls[0].args.p_handover_note).toBeNull();
  });

  it('SCRUM331_AC7_refuses_a_missing_new_coordinator_before_the_database', async () => {
    // 400 listing the field, and the client never touched. The function is
    // not even asked: a missing id is a fault in the form, which the service
    // reports without taking a lock (see the service tests for why it, not
    // the function, catches this).
    const client = createEventRequestClient([]);

    const res = await handOver(client, { handoverNote: HANDOVER_NOTE });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain('newCoordinatorId');
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM331_AC6_an_organiser_is_refused_with_403_and_never_queries', async () => {
    // coordinatorOnly answers before the handler runs. An Organiser has no
    // event to hand over, whatever the body says, and is refused without the
    // function being called at all.
    const client = createEventRequestClient([ok(handedOverRow())]);

    const res = await handOver(
      client,
      { newCoordinatorId: NEW_COORDINATOR_ID },
      signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID),
    );

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM331_AC6_returns_401_without_a_token_and_never_queries', async () => {
    const client = createEventRequestClient([ok(handedOverRow())]);

    const res = await handOver(client, { newCoordinatorId: NEW_COORDINATOR_ID }, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM331_AC6_a_coordinator_who_does_not_hold_the_event_cannot_hand_it_over', async () => {
    // A coordinator, so past the route's gate, but not this event's coordinator.
    // Only the function can tell, because only it reads the row under lock,
    // and it answers 42501. The route turns that into a 403, not a 404: the
    // caller can see this event in the shared queue already, so "not found"
    // would be false and would hide nothing (errors.test.js gives the full
    // argument).
    //
    // Was SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over, with
    // 018's message. Right when written: the holder was the only one who
    // could. Since 052 a Lead may too (SCRUM-486 AC6; the Lead's case is in
    // leadAssignmentRoutes.test.js), so the name now says the case it proves,
    // a coordinator who is not the holder, and the message is 052's.
    const message = `only the coordinator assigned to event request ${REQUEST_ID}, or the Event Coordinator Lead, can hand it over`;
    const client = createEventRequestClient([dbError('42501', message)]);

    const res = await handOver(client, { newCoordinatorId: NEW_COORDINATOR_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(message);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM331_AC7_refuses_a_new_coordinator_who_is_not_an_event_coordinator', async () => {
    // 22023: the person named does not hold the role, checked by the function
    // while it holds a lock on their profile. 400, because the request named
    // someone who cannot take the event; the outgoing coordinator needs to
    // pick someone else.
    const client = createEventRequestClient([
      dbError('22023', `user ${NEW_COORDINATOR_ID} is not an Event Coordinator, so cannot be handed event request ${REQUEST_ID}`),
    ]);

    const res = await handOver(client, { newCoordinatorId: NEW_COORDINATOR_ID });

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM331_AC6_refuses_a_status_that_does_not_allow_a_handover', async () => {
    // 55000: AC6 names five statuses a handover is allowed from, and planning
    // is not one of them (018's header explains why). 409, as for a submit
    // that finds the request no longer a draft.
    const client = createEventRequestClient([
      dbError('55000', `event request ${REQUEST_ID} has status planning, and cannot be handed over in that status`),
    ]);

    const res = await handOver(client, { newCoordinatorId: NEW_COORDINATOR_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has status planning/);
    expect(client.calls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-332 -- every coordinator can read an event, and only its assigned
// coordinator can change it
// ---------------------------------------------------------------------------
// SCRUM-327 AC7: after a handover the new coordinator can carry out every
// coordinator action on the event, and the previous one can view it but no
// longer change it.
//
// The read: a new route, GET /:id/review, behind coordinatorOnly. Not a role
// branch inside GET /:id. Either would work, and these are the reasons for
// this one:
//
//   - Who may call it is visible where it is declared, as a second argument,
//     like every other coordinator path in this router. requireAuth.js keeps
//     authorisation out of shared code for exactly this reason, so it can be
//     read off the route.
//   - It fails closed. A branch in GET /:id would choose between two
//     authorisation rules inside the handler, and a mistake in its condition
//     -- a missing role falling through to the coordinator side, say -- would
//     turn the Organiser's 404 into an open read of every event in the system.
//     A separate route behind requireRole answers 403 to anyone without the
//     role before the handler runs, whatever is wrong inside it.
//   - GET /:id stays exactly as it is, so its 404 and every test that pins it
//     are untouched.
//   - It follows the precedent already in this router: GET
//     /:id/change-requests/review is the coordinator's read of an event's
//     change requests, beside the Organiser's GET /:id/change-requests.
//
// The cost is two URLs for one event, and the frontend picks by role, as it
// already does between GET / and GET /queue.
//
// Why an Organiser asking for someone else's event gets a 404 and a
// coordinator gets the event: for the Organiser, whether an id exists is
// itself the secret. One customer has no business learning that another's
// request exists, so a foreign event is answered exactly as a missing one.
// A coordinator works on ConnectSphere's side and already sees every event in
// the shared queue, so there is no secret to keep, and AC7 says the previous
// coordinator can still view an event they handed over. The exception is a
// draft, which no coordinator is meant to know exists, so it stays a 404 on
// both routes.

/** GET the coordinator's single read, as COORDINATOR_ID unless told otherwise. */
const readAsCoordinator = (client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
  request(appWith({ client, requireAuth })).get(`/api/event-requests/${REQUEST_ID}/review`);

describe('SCRUM-332: every coordinator can read an event over HTTP', () => {
  it.each([STATUS.APPROVED, STATUS.CONFIRMED])(
    'SCRUM332_AC7_any_coordinator_can_read_an_event_in_%s',
    async (status) => {
      // Another Organiser's event, held by another coordinator, in a status
      // the queue does not cover. Before SCRUM-332 no coordinator could read
      // it at all.
      const client = createEventRequestClient([
        ok(storedRow({
          status,
          organiser_id: OTHER_ORGANISER_ID,
          assigned_coordinator_id: NEW_COORDINATOR_ID,
        })),
      ]);

      const res = await readAsCoordinator(client);

      // The same shape GET /:id serves, statusDisplay included, so the
      // coordinator's screen renders it with the same helper.
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(REQUEST_ID);
      expect(res.body.status).toBe(status);
      expect(res.body.statusDisplay.status).toBe(status);

      // One read, on the id alone: nothing narrows it to the caller.
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].filters).toEqual([['id', REQUEST_ID]]);
    },
  );

  it('SCRUM332_AC7_the_previous_coordinator_can_still_view_the_event', async () => {
    // AC7 in so many words: the event was handed to NEW_COORDINATOR_ID, and
    // COORDINATOR_ID, who held it, can still read it.
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: NEW_COORDINATOR_ID })),
    ]);

    const res = await readAsCoordinator(client, signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID));

    expect(res.status).toBe(200);
    expect(res.body.assignedCoordinatorId).toBe(NEW_COORDINATOR_ID);
  });

  it('SCRUM332_AC7_a_missing_event_is_404', async () => {
    const client = createEventRequestClient([ok(null)]);

    const res = await readAsCoordinator(client);

    // The read must have happened. Without that assertion, Express's own 404
    // for a path no route matches would pass this test before the route exists.
    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM332_AC7_a_draft_is_404_to_a_coordinator', async () => {
    // Identical to a missing event, status and body, so a coordinator cannot
    // learn a draft exists by guessing its id.
    const draft = await readAsCoordinator(
      createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]),
    );
    const missing = await readAsCoordinator(createEventRequestClient([ok(null)]));

    expect(draft.status).toBe(404);
    expect(draft.body).toEqual(missing.body);
    expect(draft.body.error).toBeDefined();
  });

  it('SCRUM332_AC7_an_organiser_is_refused_the_coordinator_read_and_never_queries', async () => {
    // An Organiser reads their own event through GET /:id. This route would
    // hand them anyone's, so it refuses them before the handler runs.
    const client = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const res = await readAsCoordinator(client, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM332_AC7_a_caller_with_no_role_is_refused_the_coordinator_read', async () => {
    // Closed by default, as SCRUM45_AC2_refuses_a_caller_with_no_role_at_all
    // pins for the queue: signedInAs sets no role, which is also what
    // requireAuth resolves for an account with no profiles row.
    const client = createEventRequestClient([ok(storedRow())]);

    const res = await readAsCoordinator(client, signedInAs(ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM332_AC7_the_coordinator_read_returns_401_without_a_token', async () => {
    const client = createEventRequestClient([ok(storedRow())]);

    const res = await readAsCoordinator(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it("SCRUM332_AC7_an_organiser_still_gets_404_for_someone_elses_event", async () => {
    // The Organiser's read is unchanged, and this time the Organiser carries
    // the role, which the SCRUM-14 tests' stub does not. Still 404, for the
    // reason in the block comment above: for an Organiser, existence is the
    // secret.
    const client = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(404);
  });

  it("SCRUM332_AC7_a_coordinator_reads_through_its_own_route_not_the_organisers", async () => {
    // Pins the choice above. GET /:id does not branch on role, so a
    // coordinator asking it for an event they did not organise gets the
    // Organiser's answer, 404. If this starts returning 200, someone has put a
    // role branch into the Organiser's read.
    const client = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    ).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(404);
  });
});


describe('SCRUM-332: only the assigned coordinator changes an event over HTTP', () => {
  const askForClarification = (client, body, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
    request(appWith({ client, requireAuth }))
      .post(`/api/event-requests/${REQUEST_ID}/clarification`)
      .send(body);

  it('SCRUM332_AC7_only_the_assigned_coordinator_can_request_clarification', async () => {
    // A coordinator, so past coordinatorOnly, but the event is held by
    // NEW_COORDINATOR_ID. 403 from the service's read, with nothing written:
    // only the read is queued, so an attempted update would fail rather than
    // pass. Not a server fault, so nothing is logged.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.SUBMITTED, assigned_coordinator_id: NEW_COORDINATOR_ID })),
    ]);

    const res = await askForClarification(client, { note: 'Please confirm the attendance.' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/assigned/i);
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('SCRUM332_AC7_the_new_coordinator_can_request_clarification', async () => {
    // The coordinator the event was handed to can act on it, and the status
    // atomic clarification function is told to refuse unless the event is
    // still theirs, taken from the token.
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(storedRow({
        status: STATUS.PENDING_CLARIFICATION,
        clarification_note: 'Please confirm the attendance.',
        assigned_coordinator_id: NEW_COORDINATOR_ID,
      })),
    ]);

    const res = await askForClarification(
      client,
      { note: 'Please confirm the attendance.' },
      signedInWithRole(ROLE.EVENT_COORDINATOR, NEW_COORDINATOR_ID),
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.PENDING_CLARIFICATION);
    expect(client.calls[1].args.p_expected_coordinator).toBe(NEW_COORDINATOR_ID);
    expect(client.calls[1].args.p_changed_by).toBe(NEW_COORDINATOR_ID);
  });

  it('SCRUM332_AC7_takes_the_coordinator_from_the_token_not_the_body', async () => {
    // The body names the assigned coordinator. It is ignored: the route reads
    // only the note from the body, so the caller cannot claim to be someone
    // else. Same rule as SCRUM331_AC9_records_who_handed_it_over.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.SUBMITTED, assigned_coordinator_id: NEW_COORDINATOR_ID })),
    ]);

    const res = await askForClarification(client, {
      note: 'Please confirm the attendance.',
      coordinatorId: NEW_COORDINATOR_ID,
    });

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(1);

    consoleError.mockRestore();
  });

  it('SCRUM332_AC7_only_the_assigned_coordinator_can_decide_a_change_request', async () => {
    // 019 refuses with 42501 under a lock on the event. The route's job is to
    // answer 403 with 019's message, rather than the 500 it answers today
    // because the change request service does not map that code. A refusal
    // is not a fault, so nothing is logged for whoever is on call.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const changeRequestId = '44444444-4444-4444-8444-444444444444';
    const message = `only the coordinator assigned to event request ${REQUEST_ID} can decide its change requests`;
    const client = createEventRequestClient([dbError('42501', message)]);

    const res = await request(
      appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
    )
      .post(`/api/event-requests/change-requests/${changeRequestId}/decision`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(message);
    expect(consoleError).not.toHaveBeenCalled();

    // The function was asked, with the caller from the token as the person
    // it checks.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].args.p_processed_by).toBe(COORDINATOR_ID);

    consoleError.mockRestore();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-322 -- GET /:id/status-history over HTTP
// ---------------------------------------------------------------------------
/**
 * SCRUM-318 AC6: the Event Organiser and the assigned coordinator can view the
 * event's full status history, oldest first. Anyone else gets "not found".
 *
 * The route is open to any signed-in user and the service decides, so these
 * tests drive both together through real Express routing: who is signed in
 * comes from the fake authenticator, what is stored comes from the fake
 * client. Reads through createQueueFakeClient above, which has .in() for the
 * name lookup.
 */
describe('SCRUM-322: GET /:id/status-history', () => {
  const STRANGER_ID = '99999999-9999-4999-8999-999999999999';

  const heldEvent = (overrides = {}) =>
    storedRow({
      status: STATUS.UNDER_REVIEW,
      submitted_at: '2026-01-15T09:00:00+00:00',
      assigned_coordinator_id: COORDINATOR_ID,
      ...overrides,
    });

  const rows = () => [
    {
      previous_status: STATUS.DRAFT,
      new_status: STATUS.SUBMITTED,
      changed_by: ORGANISER_ID,
      reason: null,
      created_at: '2026-01-15T09:00:00+00:00',
    },
    {
      previous_status: STATUS.SUBMITTED,
      new_status: STATUS.UNDER_REVIEW,
      changed_by: COORDINATOR_ID,
      reason: 'Picked up for review.',
      created_at: '2026-01-16T09:00:00+00:00',
    },
  ];

  const people = () => [
    { id: ORGANISER_ID, full_name: 'Olivia Organiser' },
    { id: COORDINATOR_ID, full_name: 'Carlos Coordinator' },
  ];

  const readHistory = (client, requireAuth) =>
    request(appWith({ client, requireAuth })).get(`/api/event-requests/${REQUEST_ID}/status-history`);

  it('SCRUM322_AC6_shows_the_organiser_the_full_history_oldest_first', async () => {
    const client = createQueueFakeClient([ok(heldEvent()), ok(rows()), ok(people())]);

    const res = await readHistory(client, signedInAs(ORGANISER_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        previousStatus: STATUS.DRAFT,
        previousStatusLabel: 'Draft',
        newStatus: STATUS.SUBMITTED,
        newStatusLabel: 'Requested',
        changedByName: 'Olivia Organiser',
        changedAt: '2026-01-15T09:00:00+00:00',
        reason: null,
      },
      {
        previousStatus: STATUS.SUBMITTED,
        previousStatusLabel: 'Requested',
        newStatus: STATUS.UNDER_REVIEW,
        newStatusLabel: 'Under review',
        changedByName: 'Carlos Coordinator',
        changedAt: '2026-01-16T09:00:00+00:00',
        reason: 'Picked up for review.',
      },
    ]);
    expect(client.calls[1].order).toEqual([['created_at', { ascending: true }]]);
  });

  it('SCRUM322_AC6_shows_the_assigned_coordinator_the_full_history', async () => {
    const client = createQueueFakeClient([ok(heldEvent()), ok(rows()), ok(people())]);

    const res = await readHistory(client, signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM322_AC6_is_a_bare_array_with_labels_and_no_ids', async () => {
    const client = createQueueFakeClient([ok(heldEvent()), ok(rows()), ok(people())]);

    const res = await readHistory(client, signedInAs(ORGANISER_ID));

    expect(Array.isArray(res.body)).toBe(true);
    for (const entry of res.body) {
      expect(Object.keys(entry).sort()).toEqual([
        'changedAt', 'changedByName', 'newStatus', 'newStatusLabel',
        'previousStatus', 'previousStatusLabel', 'reason',
      ]);
    }
  });

  it('SCRUM322_AC6_returns_an_empty_list_for_an_event_with_no_history', async () => {
    const client = createQueueFakeClient([ok(storedRow({ status: STATUS.DRAFT })), ok([])]);

    const res = await readHistory(client, signedInAs(ORGANISER_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['an unrelated organiser', signedInAs(STRANGER_ID), heldEvent()],
    ['a coordinator the event is not assigned to', signedInWithRole(ROLE.EVENT_COORDINATOR, NEW_COORDINATOR_ID), heldEvent()],
    ['the previous coordinator after a handover', signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID), heldEvent({ assigned_coordinator_id: NEW_COORDINATOR_ID })],
    ['a coordinator, for a draft', signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID), storedRow({ status: STATUS.DRAFT })],
  ])('SCRUM322_gives_%s not found and reads no history', async (_label, auth, event) => {
    const client = createQueueFakeClient([ok(event)]);

    const res = await readHistory(client, auth);

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM322_answers_a_missing_event_exactly_as_it_answers_a_refusal', async () => {
    // Same status and same body, so a caller cannot tell an event that does not
    // exist from one they may not read.
    const refused = await readHistory(
      createQueueFakeClient([ok(heldEvent())]),
      signedInAs(STRANGER_ID),
    );
    const missing = await readHistory(
      createQueueFakeClient([ok(null)]),
      signedInAs(STRANGER_ID),
    );

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(refused.body);
  });

  it('SCRUM322_takes_the_user_from_the_token_not_the_query', async () => {
    const client = createQueueFakeClient([ok(heldEvent())]);

    const res = await request(appWith({ client, requireAuth: signedInAs(STRANGER_ID) }))
      .get(`/api/event-requests/${REQUEST_ID}/status-history`)
      .query({ userId: ORGANISER_ID, organiserId: ORGANISER_ID });

    expect(res.status).toBe(404);
  });

  it('SCRUM322_returns_401_and_never_queries_without_a_token', async () => {
    const client = createQueueFakeClient([]);

    const res = await readHistory(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-333 -- GET /api/event-requests/mine, a coordinator's "My events"
// ---------------------------------------------------------------------------
// SCRUM-327 AC11: each coordinator has a list of the events assigned to them,
// grouped by status, earliest event first.
//
// Behind coordinatorOnly, like GET /queue, and for a related reason: neither
// list is narrowed to an Organiser, so the role is what decides who may ask.
// Unlike the queue, this one is narrowed to the caller, as the assigned
// coordinator, and the caller comes from the token.
//
// GET /queue is untouched. It is the only view of work nobody holds yet, so
// "My events" sits beside it rather than replacing it; which one the
// dashboard opens on is a frontend choice.
//
// The service tests carry the arguments for the statuses covered, the order,
// and the organiser's name. These tests are about the transport: the gate,
// the scoping, the shape, and the path.
//
// The route fakes answer two calls per successful list: the events, then the
// organisers' names from profiles (see the service tests for why that is a
// second read rather than a join).

/** GET /mine, as COORDINATOR_ID unless told otherwise. */
const listMine = (client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
  request(appWith({ client, requireAuth })).get('/api/event-requests/mine');

/** Two events, two Organisers, both assigned to COORDINATOR_ID. */
const myEventRows = () => [
  storedRow({ id: 'mine-1', organiser_id: ORGANISER_ID, status: STATUS.APPROVED, assigned_coordinator_id: COORDINATOR_ID }),
  storedRow({ id: 'mine-2', organiser_id: OTHER_ORGANISER_ID, status: STATUS.SUBMITTED, assigned_coordinator_id: COORDINATOR_ID }),
];

const organiserNames = () => [
  { id: ORGANISER_ID, full_name: 'Aisha Rahman' },
  { id: OTHER_ORGANISER_ID, full_name: 'Daniel Lim' },
];

describe('SCRUM-333: a coordinator reads their own events over HTTP', () => {
  it('SCRUM333_AC11_returns_200_and_a_bare_array_for_a_coordinator', async () => {
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client);

    // A bare array, like GET / and GET /queue. The frontend groups it by
    // status; grouping is presentation, and a server-side grouping would be a
    // shape no other list in this API has.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM333_AC11_lists_only_the_coordinators_own_events', async () => {
    // Mirrors SCRUM14_AC1_scopes_the_query_to_the_token_not_the_query_string.
    // The query string names another coordinator, and the read is still
    // narrowed to the one in the token. Otherwise any coordinator could read
    // any other's list just by asking for it.
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    await request(appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }))
      .get('/api/event-requests/mine')
      .query({ coordinatorId: NEW_COORDINATOR_ID, assignedCoordinatorId: NEW_COORDINATOR_ID });

    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].filters).toEqual([['assigned_coordinator_id', COORDINATOR_ID]]);
  });

  it('SCRUM333_AC11_a_reassigned_event_follows_its_new_coordinator', async () => {
    // After a handover from COORDINATOR_ID to NEW_COORDINATOR_ID, the event
    // is on the new coordinator's list and off the old one's.
    //
    // Asserted through the filter, not the rows. The fake returns whatever
    // rows it is given, so a test that fed it the "right" rows and checked
    // they came back would only check the fixture against itself. What
    // actually decides which list an event is on is the database applying
    // assigned_coordinator_id = caller, and 018 moves that column on a
    // handover. So the honest assertion is that each caller's read carries
    // their own id, and nobody else's.
    const asNew = createQueueFakeClient([ok([]), ok([])]);
    const asOld = createQueueFakeClient([ok([]), ok([])]);

    await listMine(asNew, signedInWithRole(ROLE.EVENT_COORDINATOR, NEW_COORDINATOR_ID));
    await listMine(asOld, signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID));

    expect(asNew.calls[0].filters).toEqual([['assigned_coordinator_id', NEW_COORDINATOR_ID]]);
    expect(asOld.calls[0].filters).toEqual([['assigned_coordinator_id', COORDINATOR_ID]]);
  });

  it('SCRUM333_AC11_carries_the_status_display_on_every_row', async () => {
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client);

    // Same projection as the queue's rows and the Organiser's list, so the
    // status badges, and the status groups the frontend builds, come from one
    // vocabulary.
    for (const row of res.body) {
      expect(row.statusDisplay).toBeDefined();
      expect(row.statusDisplay.status).toBe(row.status);
      expect(row.statusDisplay.label).toBe(STATUS_DISPLAY[row.status].label);
      expect(row.statusDisplay.group).toBe(STATUS_DISPLAY[row.status].group);
    }
  });

  it('SCRUM333_AC11_carries_the_organisers_name', async () => {
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client);

    // Survives serialisation, beside the id it names.
    expect(res.body.map((row) => [row.organiserId, row.organiserName])).toEqual([
      [ORGANISER_ID, 'Aisha Rahman'],
      [OTHER_ORGANISER_ID, 'Daniel Lim'],
    ]);
  });

  it('SCRUM333_AC11_answers_an_empty_list_with_200_and_not_404', async () => {
    // Nothing assigned is the good state, not a missing resource. With no
    // events there is no second read, so only one answer is queued.
    const client = createQueueFakeClient([ok([])]);

    const res = await listMine(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM333_AC11_does_not_read_the_mine_path_as_a_request_id', async () => {
    // '/mine' is one segment, like '/queue', so declared after GET /:id
    // Express would match it with id === 'mine' and send the caller to the
    // Organiser's read. Mirrors SCRUM45_AC1_does_not_read_the_queue_path_as_a_
    // request_id, and asserted from the outside: a 200, a read narrowed to the
    // coordinator, and no id filter.
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client);

    expect(res.status).toBe(200);
    expect(client.calls[0].filters).toEqual([['assigned_coordinator_id', COORDINATOR_ID]]);
    expect(client.calls[0].filters).not.toContainEqual(['id', 'mine']);
  });

  it('SCRUM333_AC11_an_organiser_is_refused_with_403_and_never_queries', async () => {
    // coordinatorOnly answers before the handler runs. An Organiser has no
    // assigned events; their own list is GET /.
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM333_AC11_a_caller_with_no_role_is_refused', async () => {
    // Closed by default, as for the queue: signedInAs sets no role, which is
    // also what requireAuth resolves for an account with no profiles row.
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client, signedInAs(COORDINATOR_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM333_AC11_returns_401_without_a_token_and_never_queries', async () => {
    const client = createQueueFakeClient([ok(myEventRows()), ok(organiserNames())]);

    const res = await listMine(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-334 -- GET /coordinators, and an event's assignment history
// ---------------------------------------------------------------------------
// Named after SCRUM-327's criteria:
//   AC9  -- every handover records who made it, and the note
//   AC10 -- the Organiser's screen shows the event's assignment history
//
// GET /coordinators is behind coordinatorOnly. It is the first endpoint in
// this API that lists users, so the first that could be used to enumerate
// staff, and no Organiser or attendee feature needs it: only the reassign
// picker does. coordinatorOnly fails closed. A future story that needs it
// elsewhere can widen the gate and give its reason.
//
// The history is two routes, not one route that branches on role:
//
//   GET /:id/assignments         the Organiser's: their own event only,
//                                someone else's is a 404, and no notes.
//   GET /:id/assignments/review  a coordinator's: any event past draft, behind
//                                coordinatorOnly, with notes.
//
// This is the split SCRUM-332 made for the event itself (GET /:id beside
// GET /:id/review), and the one this router already had for change requests
// (GET /:id/change-requests beside GET /:id/change-requests/review). The
// reasons are the same. Who may call each route can be read off its
// declaration. And it fails closed: a role branch inside one handler that got
// its condition wrong would hand every Organiser every event's history,
// notes included, while a route behind requireRole answers 403 before its
// handler runs. A single URL was the other option. It would be one fewer
// route, but it would be the one place in this router where an authorisation
// decision is made inside a handler, with no reason it should be done here
// and not for GET /:id.
//
// The history is its own endpoint rather than part of the event reads. Folded
// in, it would put a growing array inside every event read, /mine and /queue
// included, where nothing shows it. Change requests are separate for the same
// reason.

/** A third coordinator, holding nothing in these fixtures. */
const THIRD_COORDINATOR_ID = '88888888-8888-4888-8888-888888888888';

/** One event's history, as PostgREST returns it: an automatic assignment, then a handover. */
const historyRows = () => [
  {
    id: 'history-1',
    event_request_id: REQUEST_ID,
    previous_coordinator_id: null,
    new_coordinator_id: COORDINATOR_ID,
    assigned_by: null,
    handover_note: null,
    created_at: '2026-01-15T09:00:00+00:00',
  },
  {
    id: 'history-2',
    event_request_id: REQUEST_ID,
    previous_coordinator_id: COORDINATOR_ID,
    new_coordinator_id: NEW_COORDINATOR_ID,
    assigned_by: COORDINATOR_ID,
    handover_note: HANDOVER_NOTE,
    created_at: '2026-01-20T09:00:00+00:00',
  },
];

const historyNames = () => [
  { id: COORDINATOR_ID, full_name: 'Priya Nair' },
  { id: NEW_COORDINATOR_ID, full_name: 'Marcus Tan' },
];

describe('SCRUM-334: the coordinator list over HTTP', () => {
  const listCoordinatorsAs = (client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
    request(appWith({ client, requireAuth })).get('/api/event-requests/coordinators');

  it('SCRUM334_AC9_a_coordinator_lists_every_coordinator', async () => {
    const client = createQueueFakeClient([ok(historyNames())]);

    const res = await listCoordinatorsAs(client);

    // A bare array of { id, fullName }, like every list in this API.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: COORDINATOR_ID, fullName: 'Priya Nair' },
      { id: NEW_COORDINATOR_ID, fullName: 'Marcus Tan' },
    ]);
  });

  it('SCRUM334_AC9_does_not_read_the_coordinators_path_as_a_request_id', async () => {
    // '/coordinators' is one segment, like '/queue' and '/mine', so declared
    // after GET /:id Express would match it with id === 'coordinators' and
    // answer from the Organiser's read. Asserted from the outside: a 200, and
    // the one read is of profiles by role, not of an event by id.
    const client = createQueueFakeClient([ok(historyNames())]);

    const res = await listCoordinatorsAs(client);

    expect(res.status).toBe(200);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('profiles');
    expect(client.calls[0].filters).toEqual([['role', 'event_coordinator']]);
  });

  it('SCRUM334_AC9_an_organiser_is_refused_the_coordinator_list_and_never_queries', async () => {
    const client = createQueueFakeClient([ok(historyNames())]);

    const res = await listCoordinatorsAs(client, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM334_AC9_a_caller_with_no_role_is_refused_the_coordinator_list', async () => {
    // Closed by default, as for the queue and "My events".
    const client = createQueueFakeClient([ok(historyNames())]);

    const res = await listCoordinatorsAs(client, signedInAs(ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM334_AC9_the_coordinator_list_returns_401_without_a_token', async () => {
    const client = createQueueFakeClient([ok(historyNames())]);

    const res = await listCoordinatorsAs(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe("SCRUM-334: the Organiser's view of the assignment history over HTTP", () => {
  const organiserHistory = (client, requireAuth = signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID)) =>
    request(appWith({ client, requireAuth })).get(`/api/event-requests/${REQUEST_ID}/assignments`);

  it('SCRUM334_AC10_the_organiser_sees_who_and_when', async () => {
    const client = createQueueFakeClient([
      ok(storedRow({ assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);

    const res = await organiserHistory(client);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[1]).toMatchObject({
      previousCoordinatorName: 'Priya Nair',
      newCoordinatorName: 'Marcus Tan',
      assignedByName: 'Priya Nair',
      automatic: false,
      createdAt: '2026-01-20T09:00:00+00:00',
    });
    expect(res.body[0].automatic).toBe(true);

    // Ownership first, then the history, then the names. The event read is
    // the proof the Organiser may see this history at all, as on GET
    // /:id/change-requests; the history read takes no owner.
    expect(client.calls.map((call) => call.table))
      .toEqual(['event_requests', 'event_request_assignment_history', 'profiles']);
    expect(client.calls[0].filters).toEqual([['id', REQUEST_ID]]);
    expect(client.calls[1].order[0]).toEqual(['created_at', { ascending: true }]);
  });

  it('SCRUM334_AC10_withholds_the_handover_note_from_the_organiser', async () => {
    // The note is written by one coordinator for another, so it never
    // reaches the Organiser. Absent, not null, so the screen can tell "not
    // sent to you" from "none was written" (see the service tests).
    const client = createQueueFakeClient([
      ok(storedRow({ assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);

    const res = await organiserHistory(client);

    expect(res.status).toBe(200);
    for (const entry of res.body) {
      expect('handoverNote' in entry).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(HANDOVER_NOTE);
  });

  it("SCRUM334_AC10_a_different_organiser_gets_404", async () => {
    // Someone else's event, answered exactly as a missing one, as every
    // Organiser read in this router does: for an Organiser, whether an id
    // exists is itself the secret. The history is never read.
    const foreignClient = createQueueFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);
    const missingClient = createQueueFakeClient([ok(null)]);

    const foreign = await organiserHistory(foreignClient);
    const missing = await organiserHistory(missingClient);

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(foreignClient.calls).toHaveLength(1);
  });

  it("SCRUM334_AC10_a_coordinator_uses_their_own_route_not_the_organisers", async () => {
    // Pins the two-route choice. This route does not branch on role, so a
    // coordinator who did not organise the event gets the Organiser's answer,
    // 404, and reads the history through /assignments/review instead.
    const client = createQueueFakeClient([
      ok(storedRow({ organiser_id: OTHER_ORGANISER_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);

    const res = await organiserHistory(client, signedInWithRole(ROLE.EVENT_COORDINATOR));

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM334_AC10_the_organisers_history_returns_401_without_a_token', async () => {
    const client = createQueueFakeClient([ok(storedRow()), ok(historyRows()), ok(historyNames())]);

    const res = await organiserHistory(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe("SCRUM-334: a coordinator's view of the assignment history over HTTP", () => {
  const coordinatorHistory = (client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
    request(appWith({ client, requireAuth })).get(`/api/event-requests/${REQUEST_ID}/assignments/review`);

  it('SCRUM334_AC9_the_assigned_coordinator_sees_the_history_with_notes', async () => {
    const client = createQueueFakeClient([
      ok(storedRow({ assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);

    const res = await coordinatorHistory(client, signedInWithRole(ROLE.EVENT_COORDINATOR, NEW_COORDINATOR_ID));

    // The person the note was written for.
    expect(res.status).toBe(200);
    expect(res.body[1].handoverNote).toBe(HANDOVER_NOTE);
    expect(res.body[0].handoverNote).toBeNull();
    expect(client.calls.map((call) => call.table))
      .toEqual(['event_requests', 'event_request_assignment_history', 'profiles']);
    expect(client.calls[1].order[0]).toEqual(['created_at', { ascending: true }]);
  });

  it('SCRUM334_AC9_any_coordinator_sees_the_history_with_notes', async () => {
    // A coordinator who holds nothing here still gets the notes. Three
    // reasons:
    //  - They can already read the event (GET /:id/review, SCRUM-332), and
    //    the history is part of it.
    //  - The note's audience is the coordinator team, not one person. The
    //    Organiser is the reader it must be kept from, and the role gate does
    //    that.
    //  - Limiting notes to the current assignee would hide every note from the
    //    coordinator who wrote it, since writing one means handing the event
    //    away, and from whoever takes the event next, who needs the trail.
    const client = createQueueFakeClient([
      ok(storedRow({ assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(historyRows()),
      ok(historyNames()),
    ]);

    const res = await coordinatorHistory(client, signedInWithRole(ROLE.EVENT_COORDINATOR, THIRD_COORDINATOR_ID));

    expect(res.status).toBe(200);
    expect(res.body[1].handoverNote).toBe(HANDOVER_NOTE);
  });

  it('SCRUM334_AC9_a_draft_has_no_history_for_a_coordinator', async () => {
    // The event is read through the coordinator read, so a draft is a 404
    // here as it is on GET /:id/review: no coordinator learns a draft exists.
    const client = createQueueFakeClient([ok(storedRow({ status: STATUS.DRAFT })), ok([]), ok([])]);

    const res = await coordinatorHistory(client);

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM334_AC10_an_organiser_is_refused_the_coordinator_history_and_never_queries', async () => {
    // Even the owning Organiser: this is the view with notes. Their view is
    // GET /:id/assignments.
    const client = createQueueFakeClient([ok(storedRow()), ok(historyRows()), ok(historyNames())]);

    const res = await coordinatorHistory(client, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM334_AC9_the_coordinator_history_returns_401_without_a_token', async () => {
    const client = createQueueFakeClient([ok(storedRow()), ok(historyRows()), ok(historyNames())]);

    const res = await coordinatorHistory(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-325 -- a refused transition over HTTP
// ---------------------------------------------------------------------------
describe('SCRUM-325 AC3: a refused transition is a 409 that names the current status', () => {
  it.each([STATUS.APPROVED, STATUS.CONFIRMED, STATUS.COMPLETED, STATUS.CANCELLED, STATUS.REJECTED])(
    'SCRUM325_AC3_refuses_a_clarification_request_for_an_event_that_is_%s_and_writes_nothing',
    async (status) => {
      const client = createEventRequestClient([
        ok(storedRow({ status, assigned_coordinator_id: COORDINATOR_ID })),
      ]);

      const res = await request(appWith({
        client,
        requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID),
      }))
        .post(`/api/event-requests/${REQUEST_ID}/clarification`)
        .send({ note: 'Please clarify.' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain(`'${status}'`);
      // Only the read happened: no status function was called, so no history.
      expect(client.calls.map((call) => call.operation)).toEqual(['select']);
    },
  );
});


// ---------------------------------------------------------------------------
// SCRUM-19 -- POST /:id/start-review and POST /:id/decision
// ---------------------------------------------------------------------------
// SCRUM-346, SCRUM-119 and SCRUM-121. The coordinator starts reviewing a
// submitted request, then approves or rejects it. Both routes are behind
// coordinatorOnly, like every coordinator write in this router, with no
// ownership pre-check: whether the caller is this event's assigned
// coordinator, and its reviewer, is what 029's functions check under the row
// lock, the only point where the answer cannot change before the write. So
// each route's job is to pass on what was asked, take the caller from the
// token, and turn the function's refusals into status codes.
//
// Why /start-review and /decision, and not POST /:id/review. GET /:id/review
// already exists: it is the coordinator's read of one event (SCRUM-332). Two
// verbs on one path for unrelated actions, one reading and one changing the
// status, would read as one resource and mislead whoever adds the next route.
// /start-review says what it does. /decision cannot collide with the change
// request decision route either: that is /change-requests/:id/decision, three
// segments to this one's two.

/** POST to one of the two routes, as COORDINATOR_ID unless told otherwise. */
const postAsCoordinator = (client, path, body = {}, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR)) =>
  request(appWith({ client, requireAuth }))
    .post(`/api/event-requests/${REQUEST_ID}/${path}`)
    .send(body);

/** The row start_event_review returns: under review, the caller as reviewer. */
const underReviewRow = () => storedRow({
  status: STATUS.UNDER_REVIEW,
  assigned_coordinator_id: COORDINATOR_ID,
  reviewing_coordinator_id: COORDINATOR_ID,
});

/** The row decide_event_request returns. */
const decidedRow = (decision, note) => storedRow({
  status: decision,
  assigned_coordinator_id: COORDINATOR_ID,
  reviewing_coordinator_id: COORDINATOR_ID,
  decision,
  decision_note: note,
  decided_by: COORDINATOR_ID,
  decided_at: '2026-01-15T09:00:00+00:00',
});

describe('SCRUM-19: a coordinator starts reviewing a request over HTTP', () => {
  it('SCRUM19_AC1_the_assigned_coordinator_starts_the_review', async () => {
    // 200 and the whole request, carrying its reviewer and statusDisplay, so
    // the screen can redraw from the response. The body names someone else as
    // the coordinator, and is ignored: the caller is always the token's user.
    const client = createEventRequestClient([ok(underReviewRow())]);

    const res = await postAsCoordinator(client, 'start-review', { coordinatorId: OTHER_ORGANISER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.UNDER_REVIEW);
    expect(res.body.reviewingCoordinatorId).toBe(COORDINATOR_ID);
    expect(res.body.statusDisplay.status).toBe(STATUS.UNDER_REVIEW);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].fn).toBe('start_event_review');
    expect(client.calls[0].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_coordinator_id: COORDINATOR_ID,
    });
  });

  it('SCRUM19_AC1_the_start_review_path_is_not_read_as_an_id', async () => {
    // The request reaches the function with the id from the URL, and nothing
    // read 'start-review' as an id on the way: no select at all, and the id
    // sent is the event's.
    const client = createEventRequestClient([ok(underReviewRow())]);

    await postAsCoordinator(client, 'start-review');

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
    expect(client.calls[0].args.p_event_request_id).toBe(REQUEST_ID);
  });

  it('SCRUM19_AC1_an_organiser_cannot_start_a_review_and_nothing_is_queried', async () => {
    const client = createEventRequestClient([ok(underReviewRow())]);

    const res = await postAsCoordinator(client, 'start-review', {}, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC1_starting_a_review_returns_401_without_a_token', async () => {
    const client = createEventRequestClient([ok(underReviewRow())]);

    const res = await postAsCoordinator(client, 'start-review', {}, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC1_only_the_assigned_coordinator_starts_the_review', async () => {
    // A coordinator, so past coordinatorOnly, but not this event's. Only the
    // function can tell, under its lock, and its 42501 becomes a 403 with its
    // message: the caller can already see the event, so a 404 would be false.
    const message = `only the coordinator assigned to event request ${REQUEST_ID} can start reviewing it`;
    const client = createEventRequestClient([dbError('42501', message)]);

    const res = await postAsCoordinator(client, 'start-review');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(message);
  });

  it('SCRUM19_AC1_a_request_that_is_not_submitted_cannot_be_put_under_review', async () => {
    const client = createEventRequestClient([
      dbError('55000', `event request ${REQUEST_ID} has status approved, and only a submitted request can be put under review`),
    ]);

    const res = await postAsCoordinator(client, 'start-review');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has status approved/);
  });
});


describe('SCRUM-19: a coordinator decides a request over HTTP', () => {
  it('SCRUM19_AC7_the_assigned_coordinator_approves', async () => {
    // All five arguments. p_decided_by is the token's user, whatever the body
    // says. p_decided_at is the server's clock: the route injects nothing, so
    // the service's default `now` is used, and it is checked here to be a
    // real instant close to the request rather than a fixed value.
    const client = createEventRequestClient([ok(decidedRow('approved', 'Approved as submitted.'))]);
    const before = Date.now();

    const res = await postAsCoordinator(client, 'decision', {
      decision: 'approved',
      decisionNote: 'Approved as submitted.',
      decidedBy: OTHER_ORGANISER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.statusDisplay.status).toBe('approved');
    expect(client.calls).toHaveLength(1);
    const [rpc] = client.calls;
    expect(rpc.fn).toBe('decide_event_request');
    expect(rpc.args).toMatchObject({
      p_event_request_id: REQUEST_ID,
      p_decision: 'approved',
      p_decision_note: 'Approved as submitted.',
      p_decided_by: COORDINATOR_ID,
    });
    expect(Object.keys(rpc.args).sort()).toEqual(
      ['p_decided_at', 'p_decided_by', 'p_decision', 'p_decision_note', 'p_event_request_id'],
    );
    const decidedAt = new Date(rpc.args.p_decided_at).getTime();
    expect(Math.abs(decidedAt - before)).toBeLessThan(60_000);
  });

  it('SCRUM19_AC9_the_response_carries_the_recorded_decision', async () => {
    // A rejection with its reason. The response carries what AC9 records:
    // the outcome, the reason, who decided and when, so the coordinator's
    // screen and the Organiser's read show the same thing.
    const reason = 'Venue capacity cannot meet the expected attendance.';
    const client = createEventRequestClient([ok(decidedRow('rejected', reason))]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'rejected', decisionNote: reason });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      decision: 'rejected',
      decisionNote: reason,
      decidedBy: COORDINATOR_ID,
      decidedAt: '2026-01-15T09:00:00+00:00',
    });
  });

  it('SCRUM19_AC5_a_rejection_with_no_reason_is_a_400_naming_the_field', async () => {
    // Refused by the service before the database, with details naming the
    // field so the form can show the message beside it.
    const client = createEventRequestClient([]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'rejected' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['decisionNote']);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC6_refuses_an_approval_when_the_start_date_has_passed', async () => {
    // 029's AC6 refusal is 55000, a 409, and its message tells the coordinator
    // what to do instead.
    const message = `event request ${REQUEST_ID} cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request`;
    const client = createEventRequestClient([dbError('55000', message)]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/start date/);
  });

  it('SCRUM19_AC1_only_the_assigned_coordinator_decides', async () => {
    const message = `only the coordinator assigned to event request ${REQUEST_ID} can decide it`;
    const client = createEventRequestClient([dbError('42501', message)]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'approved' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(message);
  });

  it('SCRUM19_AC3_refuses_a_decision_on_a_request_awaiting_clarification', async () => {
    const client = createEventRequestClient([
      dbError('55000', `event request ${REQUEST_ID} has status pending_clarification, and only a request under review can be decided`),
    ]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending_clarification/);
  });

  it('SCRUM19_AC7_the_decision_path_is_not_read_as_an_id', async () => {
    const client = createEventRequestClient([ok(decidedRow('approved', null))]);

    await postAsCoordinator(client, 'decision', { decision: 'approved' });

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
    expect(client.calls[0].args.p_event_request_id).toBe(REQUEST_ID);
  });

  it('SCRUM19_AC1_an_organiser_cannot_decide_and_nothing_is_queried', async () => {
    const client = createEventRequestClient([ok(decidedRow('approved', null))]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'approved' }, signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC1_deciding_returns_401_without_a_token', async () => {
    const client = createEventRequestClient([ok(decidedRow('approved', null))]);

    const res = await postAsCoordinator(client, 'decision', { decision: 'approved' }, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-485 AC5: the new roles are refused by this file's coordinator gate
// ---------------------------------------------------------------------------
// The other route suites carry a table of refused roles per gate, and the two
// new roles were added to those. coordinatorOnly here had only single-role
// refusals, so this is a sample of it rather than every route: the proof that
// every coordinatorOnly route refuses both roles is requireRole's own test
// (SCRUM485_AC5_the_coordinator_gate_refuses_%s), because every route here
// shares the one gate. A read, a write, and /coordinators, the list SCRUM-486's
// assignment picker will read: whether a Lead may be assigned events is an open
// question, so as of SCRUM-485 they are refused it like any non-coordinator.
describe('SCRUM-485 AC5: the coordinator gate on /api/event-requests refuses the new roles', () => {
  const ROUTES = [
    ['GET /queue', (app) => request(app).get('/api/event-requests/queue')],
    ['GET /coordinators', (app) => request(app).get('/api/event-requests/coordinators')],
    ['POST /:id/start-review', (app) => request(app).post(`/api/event-requests/${REQUEST_ID}/start-review`).send({})],
  ];
  const CASES = [ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER]
    .flatMap((role) => ROUTES.map(([route, call]) => [route, role, call]));

  it.each(CASES)('SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing', async (_route, role, call) => {
    // Nothing queued: a query that slipped past the gate would fail with "no
    // result queued" instead of passing by accident.
    const client = createEventRequestClient([]);

    const res = await call(appWith({ client, requireAuth: signedInWithRole(role, COORDINATOR_ID) }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators' });
    expect(client.calls).toHaveLength(0);
  });
});
describe('SCRUM-491: GET /hold-candidates, the hold form event picker', () => {
  const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const COORD_ID = '44444444-4444-4444-8444-444444444444';
  const staff = (req, _res, next) => {
    req.user = { id: STAFF_ID, role: 'venue_staff' };
    next();
  };

  it('SCRUM491_AC2_lists_approved_events_with_their_coordinator_for_venue_staff', async () => {
    const client = createFakeClient([
      ok([{
        id: REQUEST_ID,
        event_name: 'IS212 Industry Night',
        proposed_start: '2026-06-01T09:00:00+00:00',
        proposed_end: '2026-06-01T17:00:00+00:00',
        expected_attendance: 120,
        assigned_coordinator_id: COORD_ID,
      }]),
      ok([{ id: COORD_ID, full_name: 'Casey Coord' }]),
    ]);

    const res = await request(appWith({ client, requireAuth: staff })).get('/api/event-requests/hold-candidates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: REQUEST_ID,
      eventName: 'IS212 Industry Night',
      proposedStart: '2026-06-01T09:00:00+00:00',
      proposedEnd: '2026-06-01T17:00:00+00:00',
      expectedAttendance: 120,
      assignedCoordinatorId: COORD_ID,
      assignedCoordinatorName: 'Casey Coord',
    }]);
    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].filters).toContainEqual(['status', 'approved']);
  });

  it('a failed read is 500 without the driver message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createFakeClient([{ data: null, error: { code: 'XX000', message: 'secret' } }]);

    const res = await request(appWith({ client, requireAuth: staff })).get('/api/event-requests/hold-candidates');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    spy.mockRestore();
  });

  it('is declared before /:id, so it is never read as an id', async () => {
    const client = createFakeClient([ok([])]);
    const res = await request(appWith({ client, requireAuth: staff })).get('/api/event-requests/hold-candidates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each(['event_coordinator', 'event_organiser', 'technical_support_staff', 'attendee'])(
    'SCRUM491_AC1_403_for_%s',
    async (role) => {
      const client = createFakeClient([]);
      const requireAuth = (req, _res, next) => {
        req.user = { id: STAFF_ID, role };
        next();
      };

      const res = await request(appWith({ client, requireAuth })).get('/api/event-requests/hold-candidates');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'This action is restricted to Venue Staff' });
      expect(client.calls).toHaveLength(0);
    },
  );
});


// ---------------------------------------------------------------------------
// SCRUM-488 AC5 and AC6 -- the safety statuses reach every consumer as labels
// ---------------------------------------------------------------------------
// Each route below already sends the shared statusDisplay, so these tests pin
// the words themselves, written out, over the routes that feed SCRUM-14's
// Organiser views, a coordinator's My events and the status history. The labels
// are provisional until SCRUM-549's decision is confirmed.
describe('SCRUM-488 AC5, AC6: the safety statuses over HTTP', () => {
  const SAFETY = [
    [STATUS.SAFETY_REVIEW, 'Safety check', 'UNDER_REVIEW'],
    [STATUS.SAFETY_APPROVED, 'Safety approved', 'APPROVED'],
  ];
  const SAFETY_OFFICER_ID = '77777777-7777-4777-8777-777777777777';
  const heldIn = (status, overrides = {}) => storedRow({
    status,
    submitted_at: '2026-01-15T09:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  });

  it.each(SAFETY)('SCRUM488_AC5_the_organiser_reads_an_event_in_%s_as_%s', async (status, label, group) => {
    const client = createFakeClient([ok(heldIn(status))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(status);
    expect(res.body.statusDisplay).toMatchObject({ status, label, group });
    expect(res.body.statusDisplay.description).not.toMatch(/_|safety_/);
  });

  it.each(SAFETY)('SCRUM488_AC5_the_status_endpoint_answers_%s_as_%s', async (status, label, group) => {
    const client = createFakeClient([ok(heldIn(status))]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/status`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status, label, group });
    expect(res.body.description).not.toMatch(/_/);
  });

  it('SCRUM488_AC5_the_organisers_list_labels_events_in_both_safety_statuses_beside_the_others', async () => {
    const client = createQueueFakeClient([ok([
      heldIn(STATUS.SAFETY_REVIEW, { id: 'e-1' }),
      heldIn(STATUS.SAFETY_APPROVED, { id: 'e-2' }),
      heldIn(STATUS.APPROVED, { id: 'e-3' }),
      heldIn(STATUS.CONFIRMED, { id: 'e-4' }),
    ]), ok([{ id: COORDINATOR_ID, full_name: 'Carlos Coordinator' }])]);

    const res = await request(appWith({ client })).get('/api/event-requests');

    expect(res.body.map((row) => [row.id, row.statusDisplay.label])).toEqual([
      ['e-1', 'Safety check'],
      ['e-2', 'Safety approved'],
      ['e-3', 'Planning'],
      ['e-4', 'Confirmed'],
    ]);
  });

  it('SCRUM488_AC6_my_events_keeps_events_in_both_safety_statuses_and_labels_them', async () => {
    // No status filter: the read is narrowed to the coordinator and nothing else.
    const rows = [
      heldIn(STATUS.SAFETY_REVIEW, { id: 'mine-1', organiser_id: ORGANISER_ID }),
      heldIn(STATUS.SAFETY_APPROVED, { id: 'mine-2', organiser_id: ORGANISER_ID }),
      heldIn(STATUS.SUBMITTED, { id: 'mine-3', organiser_id: ORGANISER_ID }),
    ];
    const client = createQueueFakeClient([ok(rows), ok([{ id: ORGANISER_ID, full_name: 'Aisha Rahman' }])]);

    const res = await request(appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }))
      .get('/api/event-requests/mine');

    expect(client.calls[0].filters).toEqual([['assigned_coordinator_id', COORDINATOR_ID]]);
    expect(client.calls[0].inFilters).toEqual([]);
    expect(res.body.map((row) => [row.id, row.status, row.statusDisplay.label, row.statusDisplay.group])).toEqual([
      ['mine-1', 'safety_review', 'Safety check', 'UNDER_REVIEW'],
      ['mine-2', 'safety_approved', 'Safety approved', 'APPROVED'],
      ['mine-3', 'submitted', 'Requested', 'AWAITING_REVIEW'],
    ]);
  });

  it('SCRUM488_AC6_the_status_history_labels_both_safety_statuses_with_reasons_oldest_first', async () => {
    const rows = [
      { previous_status: STATUS.APPROVED, new_status: STATUS.SAFETY_REVIEW, changed_by: COORDINATOR_ID, reason: 'Venue and equipment are arranged.', created_at: '2026-02-01T09:00:00+00:00' },
      { previous_status: STATUS.SAFETY_REVIEW, new_status: STATUS.SAFETY_APPROVED, changed_by: SAFETY_OFFICER_ID, reason: null, created_at: '2026-02-02T09:00:00+00:00' },
      { previous_status: STATUS.SAFETY_APPROVED, new_status: STATUS.APPROVED, changed_by: COORDINATOR_ID, reason: 'Attendance doubled.', created_at: '2026-02-03T09:00:00+00:00' },
    ];
    const client = createQueueFakeClient([
      ok(heldIn(STATUS.APPROVED)),
      ok(rows),
      ok([{ id: COORDINATOR_ID, full_name: 'Carlos Coordinator' }, { id: SAFETY_OFFICER_ID, full_name: 'Sam Safety' }]),
    ]);

    const res = await request(appWith({ client, requireAuth: signedInAs(ORGANISER_ID) }))
      .get(`/api/event-requests/${REQUEST_ID}/status-history`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        previousStatus: 'approved', previousStatusLabel: 'Planning',
        newStatus: 'safety_review', newStatusLabel: 'Safety check',
        changedByName: 'Carlos Coordinator', changedAt: '2026-02-01T09:00:00+00:00',
        reason: 'Venue and equipment are arranged.',
      },
      {
        previousStatus: 'safety_review', previousStatusLabel: 'Safety check',
        newStatus: 'safety_approved', newStatusLabel: 'Safety approved',
        changedByName: 'Sam Safety', changedAt: '2026-02-02T09:00:00+00:00',
        reason: null,
      },
      {
        previousStatus: 'safety_approved', previousStatusLabel: 'Safety approved',
        newStatus: 'approved', newStatusLabel: 'Planning',
        changedByName: 'Carlos Coordinator', changedAt: '2026-02-03T09:00:00+00:00',
        reason: 'Attendance doubled.',
      },
    ]);
    expect(client.calls[1].order).toEqual([['created_at', { ascending: true }]]);
  });
});
