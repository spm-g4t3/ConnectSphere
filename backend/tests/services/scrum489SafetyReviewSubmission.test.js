/**
 * SCRUM-489 (SCRUM-555, SCRUM-556): the service half of the readiness read and
 * the safety-check submission. What the database does is proved in
 * tests/db/scrum489SafetyReviewSubmissionDatabase.test.js; these pin what this
 * layer refuses before the rpc, and what it turns each refusal into.
 */

import { describe, it, expect } from 'vitest';

import { getEventReadiness, submitForSafetyReview } from '../../src/services/eventRequestService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/errors.js';

/** Records each rpc and answers queued { data, error } pairs in order. */
function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (queue.length === 0) throw new Error(`fake client: no result queued for rpc ${fn}`);
      return Promise.resolve(queue.shift());
    },
  };
}

const ok = (data) => ({ data, error: null });
const dbError = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';

const OUTSTANDING = [
  { key: 'venue', met: false, detail: 'Awaiting approval', bookingId: 'b1', venueName: 'Room 2' },
  { key: 'date', met: false, detail: "The event's start has passed" },
];

const row = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: '11111111-1111-4111-8111-111111111111',
  event_name: 'IS212 Industry Night',
  status: 'safety_review',
  assigned_coordinator_id: COORDINATOR_ID,
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-14T03:00:00+00:00',
  submitted_at: '2026-10-02T03:00:00+00:00',
  ...overrides,
});

const submit = (client, overrides = {}) =>
  submitForSafetyReview({ client, eventRequestId: EVENT_ID, coordinatorId: COORDINATOR_ID, ...overrides });


describe('SCRUM-489 AC3: the readiness read', () => {
  it('SCRUM489_AC3_the_checklist_is_one_rpc_of_event_readiness', async () => {
    const checklist = { eventRequestId: EVENT_ID, ready: false, items: OUTSTANDING };
    const client = createFakeClient([ok(checklist)]);

    await expect(getEventReadiness({ client, eventRequestId: EVENT_ID, noEquipmentConfirmed: true })).resolves.toEqual(checklist);

    expect(client.calls).toEqual([{
      fn: 'event_readiness',
      args: { p_event_request_id: EVENT_ID, p_no_equipment_confirmed: true },
    }]);
  });

  it.each([
    ['an id that is not a uuid', { eventRequestId: 'not-a-uuid' }, 'id'],
    ['a noEquipmentConfirmed that is not a boolean', { eventRequestId: EVENT_ID, noEquipmentConfirmed: 'yes' }, 'noEquipmentConfirmed'],
  ])('SCRUM489_AC3_%s_is_refused_with_400_before_any_rpc', async (_label, options, field) => {
    // AC3-07, AC4-06.
    const client = createFakeClient([]);

    const err = await errorFrom(getEventReadiness({ client, ...options }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual([field]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM489_AC2_an_unknown_event_is_a_404', async () => {
    const client = createFakeClient([dbError('P0002', `event request ${EVENT_ID} not found`)]);

    expect(await errorFrom(getEventReadiness({ client, eventRequestId: EVENT_ID }))).toBeInstanceOf(NotFoundError);
  });
});


describe('SCRUM-489: submitting for the safety check', () => {
  it('SCRUM489_AC6_a_submission_is_one_rpc_with_the_caller_the_trimmed_note_and_the_confirmation', async () => {
    // AC5-04, AC6-04: the event comes back in camelCase, in Safety review.
    const client = createFakeClient([ok(row())]);

    const updated = await submit(client, { note: '  East doors.  ', noEquipmentConfirmed: true });

    expect(client.calls).toEqual([{
      fn: 'submit_event_for_safety_review',
      args: {
        p_event_request_id: EVENT_ID,
        p_coordinator_id: COORDINATOR_ID,
        p_note: 'East doors.',
        p_no_equipment_confirmed: true,
      },
    }]);
    expect(updated).toMatchObject({ id: EVENT_ID, status: 'safety_review', assignedCoordinatorId: COORDINATOR_ID });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['only whitespace', '   '],
  ])('SCRUM489_AC5_a_note_that_is_%s_is_sent_as_null', async (_label, note) => {
    // AC5-03.
    const client = createFakeClient([ok(row())]);

    await submit(client, { note });

    expect(client.calls[0].args.p_note).toBeNull();
  });

  it('SCRUM489_AC5_a_note_of_exactly_2000_characters_is_sent', async () => {
    // AC5-01.
    const client = createFakeClient([ok(row())]);

    await submit(client, { note: 'x'.repeat(2000) });

    expect(client.calls[0].args.p_note).toHaveLength(2000);
  });

  it.each([
    ['an id that is not a uuid', { eventRequestId: 'not-a-uuid' }, 'id'],
    ['a note over 2,000 characters', { note: 'x'.repeat(2001) }, 'note'],
    ['a note that is not text', { note: 42 }, 'note'],
    ['a noEquipmentConfirmed that is not a boolean', { noEquipmentConfirmed: 'true' }, 'noEquipmentConfirmed'],
  ])('SCRUM489_AC5_%s_is_refused_with_400_before_any_rpc', async (_label, overrides, field) => {
    // AC1-09, AC4-06, AC5-02, AC5-05: the database's own rules, applied first.
    const client = createFakeClient([]);

    const err = await errorFrom(submit(client, overrides));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details.map((d) => d.field)).toEqual([field]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM489_AC3_not_ready_is_a_409_with_every_outstanding_line', async () => {
    // AC3-02: by the code and the hint, never the message.
    const client = createFakeClient([dbError('PT409', 'This event is not ready for the safety check.', {
      hint: 'EVENT_NOT_READY', details: JSON.stringify(OUTSTANDING),
    })]);

    const err = await errorFrom(submit(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('EVENT_NOT_READY');
    expect(err.conflicts).toEqual(OUTSTANDING);
  });

  it.each([
    ['not JSON', 'venue, date'],
    ['JSON but not a list', '{"key":"venue"}'],
    ['missing', undefined],
  ])('SCRUM489_AC3_a_detail_that_is_%s_is_still_a_409_with_no_conflicts', async (_label, details) => {
    // AC3-03: never a 500.
    const client = createFakeClient([dbError('PT409', 'This event is not ready for the safety check.', { hint: 'EVENT_NOT_READY', details })]);

    const err = await errorFrom(submit(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EVENT_NOT_READY');
    expect(err.conflicts).toEqual([]);
  });

  it.each([
    ['42501', ForbiddenError, 403],
    ['55000', ConflictError, 409],
    ['22023', ValidationError, 400],
    ['P0002', NotFoundError, 404],
    ['40001', ConflictError, 409],
  ])('SCRUM489_AC1_the_functions_%s_arrives_as_its_status', async (code, type, status) => {
    // AC1-02, AC1-04: the function's own message passes through.
    const client = createFakeClient([dbError(code, 'This event can be submitted for the safety check only while it is Approved. It is Safety review.')]);

    const err = await errorFrom(submit(client));

    expect(err).toBeInstanceOf(type);
    expect(err.status).toBe(status);
  });
});
