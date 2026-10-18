/**
 * Service tests for the equipment request queue.
 *
 * SCRUM-284. Named SCRUM284_AC<n>_<what_it_checks>. The client is a test
 * double, so these are about what the service sends, what it refuses before the
 * database is called, and how the answer is reshaped. What the database does is
 * tested against Postgres in tests/db/equipmentRequestQueueDatabase.test.js.
 */

import { describe, it, expect, vi } from 'vitest';

const defaultClient = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient, supabaseAdmin: {} }));

import { getEquipmentRequestQueue, toQueueRow } from '../../src/services/equipmentQueueService.js';
import { ForbiddenError, ValidationError } from '../../src/errors.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const REVIEWER_ID = '66666666-6666-4666-8666-666666666666';
const VENUE_ID = '88888888-8888-4888-8888-888888888888';
const CALLER_ID = '77777777-7777-4777-8777-777777777777';

const row = (overrides = {}) => ({
  event_request_id: EVENT_ID,
  event_name: 'Annual Dinner',
  proposed_start: '2030-01-10T10:00:00+00:00',
  proposed_end: '2030-01-10T12:00:00+00:00',
  venues: [{ id: VENUE_ID, name: 'Hall A' }],
  coordinator_id: COORDINATOR_ID,
  coordinator_name: 'Rae Tan',
  item_count: 22,
  status: 'under_review',
  reviewer_id: REVIEWER_ID,
  reviewer_name: 'Sam Lee',
  flagged_count: 0,
  flag_reasons: [],
  ...overrides,
});

const ok = (data) => ({ data, error: null });

function fakeClient(answer = ok({ needs_action: [], requests: [] })) {
  return { rpc: vi.fn(async () => answer), from: vi.fn() };
}

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('what the service asks the database', () => {
  it('SCRUM284_AC2_calls_the_one_function_with_the_status_and_the_past_flag', async () => {
    const client = fakeClient();
    await getEquipmentRequestQueue({ status: 'arranged', includePast: 'true' }, { callerId: CALLER_ID, client });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('equipment_request_queue', {
      p_caller: CALLER_ID,
      p_status: 'arranged',
      p_include_past: true,
    });
  });

  it('SCRUM284_AC2_no_query_asks_for_every_status_without_past_events', async () => {
    const client = fakeClient();
    await getEquipmentRequestQueue({}, { callerId: CALLER_ID, client });
    expect(client.rpc).toHaveBeenCalledWith('equipment_request_queue', {
      p_caller: CALLER_ID,
      p_status: null,
      p_include_past: false,
    });
  });

  it('SCRUM284_AC2_reads_only_through_the_function_never_a_table', async () => {
    const client = fakeClient();
    await getEquipmentRequestQueue({}, { client });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('SCRUM284_AC2_a_bad_status_is_refused_before_the_database_is_called', async () => {
    const client = fakeClient();
    const err = await failure(getEquipmentRequestQueue({ status: 'nope' }, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('status');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM284_AC2_a_bad_includePast_is_refused_before_the_database_is_called', async () => {
    const client = fakeClient();
    const err = await failure(getEquipmentRequestQueue({ includePast: 'maybe' }, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('what the service gives back', () => {
  it('SCRUM284_AC3_a_row_is_renamed_to_camel_case_with_a_label_for_the_status', async () => {
    const client = fakeClient(ok({ needs_action: [], requests: [row()] }));
    const { requests } = await getEquipmentRequestQueue({}, { client });
    expect(requests).toEqual([
      {
        eventRequestId: EVENT_ID,
        eventName: 'Annual Dinner',
        proposedStart: '2030-01-10T10:00:00+00:00',
        proposedEnd: '2030-01-10T12:00:00+00:00',
        venues: [{ id: VENUE_ID, name: 'Hall A' }],
        coordinator: { id: COORDINATOR_ID, name: 'Rae Tan' },
        itemCount: 22,
        status: 'under_review',
        statusLabel: 'Under review',
        reviewer: { id: REVIEWER_ID, name: 'Sam Lee' },
        flaggedCount: 0,
        flagReasons: [],
      },
    ]);
  });

  it('SCRUM284_AC6_the_row_has_exactly_the_listed_fields_even_if_the_database_sent_more', () => {
    const shaped = toQueueRow(row({ organiser_id: 'secret', event_description: 'private', attendees: 400 }));
    expect(Object.keys(shaped).sort()).toEqual([
      'coordinator',
      'eventName',
      'eventRequestId',
      'flagReasons',
      'flaggedCount',
      'itemCount',
      'proposedEnd',
      'proposedStart',
      'reviewer',
      'status',
      'statusLabel',
      'venues',
    ]);
    expect(JSON.stringify(shaped)).not.toMatch(/secret|private|400/);
  });

  it('SCRUM284_AC3_every_venue_the_database_sent_comes_through_in_order', () => {
    const second = { id: 'v2', name: 'Room B' };
    const shaped = toQueueRow(row({ venues: [{ id: VENUE_ID, name: 'Hall A' }, second] }));
    expect(shaped.venues).toEqual([{ id: VENUE_ID, name: 'Hall A' }, second]);
  });

  it('SCRUM284_AC3_no_venue_no_reviewer_and_no_coordinator_become_empty_or_null', () => {
    const shaped = toQueueRow(
      row({ venues: [], reviewer_id: null, reviewer_name: null, coordinator_id: null, coordinator_name: null, status: 'pending_review' }),
    );
    expect(shaped.venues).toEqual([]);
    expect(shaped.reviewer).toBeNull();
    expect(shaped.coordinator).toBeNull();
  });

  it('SCRUM284_AC3_a_person_with_no_name_keeps_their_id_and_gets_a_null_name', () => {
    expect(toQueueRow(row({ reviewer_name: null })).reviewer).toEqual({ id: REVIEWER_ID, name: null });
  });

  it('SCRUM284_AC3_an_event_with_no_period_has_null_times', () => {
    const shaped = toQueueRow(row({ proposed_start: null, proposed_end: null }));
    expect(shaped.proposedStart).toBeNull();
    expect(shaped.proposedEnd).toBeNull();
  });

  it('SCRUM284_AC4_the_flag_reasons_come_through', () => {
    const shaped = toQueueRow(row({ flagged_count: 2, flag_reasons: ['Event dates changed', 'Quantity changed'] }));
    expect(shaped.flaggedCount).toBe(2);
    expect(shaped.flagReasons).toEqual(['Event dates changed', 'Quantity changed']);
  });

  it('SCRUM284_AC4_the_two_lists_stay_apart', async () => {
    const needs = row({ event_request_id: 'a' });
    const other = row({ event_request_id: 'b' });
    const client = fakeClient(ok({ needs_action: [needs], requests: [needs, other] }));
    const result = await getEquipmentRequestQueue({}, { client });
    expect(result.needsAction.map((r) => r.eventRequestId)).toEqual(['a']);
    expect(result.requests.map((r) => r.eventRequestId)).toEqual(['a', 'b']);
  });

  it('SCRUM284_AC2_the_status_choices_come_from_the_server_in_review_order', async () => {
    const { statuses } = await getEquipmentRequestQueue({}, { callerId: CALLER_ID, client: fakeClient() });
    expect(statuses).toEqual([
      { value: 'pending_review', label: 'Pending review' },
      { value: 'under_review', label: 'Under review' },
      { value: 'arranged', label: 'Arranged' },
      { value: 'cannot_be_fully_arranged', label: 'Cannot be fully arranged' },
      { value: 'cancelled', label: 'Cancelled' },
    ]);
  });

  it('SCRUM284_AC4_the_real_totals_are_passed_through_even_when_the_lists_are_cut', async () => {
    const client = fakeClient(ok({
      needs_action: [row()],
      needs_action_total: 350,
      needs_action_truncated: true,
      requests: [row()],
      requests_total: '512',
      requests_truncated: true,
    }));
    const result = await getEquipmentRequestQueue({}, { callerId: CALLER_ID, client });
    expect(result).toMatchObject({ needsActionTotal: 350, requestsTotal: 512 });
  });

  it('SCRUM284_AC2_a_cut_list_is_marked_truncated', async () => {
    const client = fakeClient(ok({ needs_action: [], needs_action_truncated: true, requests: [], requests_truncated: true }));
    const result = await getEquipmentRequestQueue({}, { callerId: CALLER_ID, client });
    expect(result).toMatchObject({ needsActionTruncated: true, requestsTruncated: true });
  });

  it.each([null, undefined, {}])('SCRUM284_AC2_an_answer_of_%j_gives_two_empty_lists_not_truncated', async (data) => {
    const client = fakeClient(ok(data));
    expect(await getEquipmentRequestQueue({}, { callerId: CALLER_ID, client })).toMatchObject({
      needsAction: [],
      needsActionTotal: 0,
      needsActionTruncated: false,
      requests: [],
      requestsTotal: 0,
      requestsTruncated: false,
    });
  });

  it('SCRUM284_AC3_an_unknown_status_label_falls_back_to_the_status_itself', () => {
    expect(toQueueRow(row({ status: 'something_new' })).statusLabel).toBe('something_new');
  });
});

describe('a row with the optional parts missing', () => {
  const bare = toQueueRow({ event_request_id: EVENT_ID, event_name: 'Annual Dinner', status: 'pending' });

  it('SCRUM284_AC2_missing_times_and_people_come_back_as_null_and_missing_venues_as_empty', () => {
    expect(bare.proposedStart).toBeNull();
    expect(bare.proposedEnd).toBeNull();
    expect(bare.venues).toEqual([]);
    expect(bare.coordinator).toBeNull();
    expect(bare.reviewer).toBeNull();
  });

  it('SCRUM284_AC2_missing_counts_are_zero_and_missing_reasons_are_an_empty_list', () => {
    expect(bare.itemCount).toBe(0);
    expect(bare.flaggedCount).toBe(0);
    expect(bare.flagReasons).toEqual([]);
  });

  it('SCRUM284_AC2_a_venue_or_person_with_no_name_keeps_its_id_and_a_null_name', () => {
    const r = toQueueRow(row({ venues: [{ id: VENUE_ID }], coordinator_name: undefined, reviewer_name: undefined }));
    expect(r.venues).toEqual([{ id: VENUE_ID, name: null }]);
    expect(r.coordinator).toEqual({ id: COORDINATOR_ID, name: null });
    expect(r.reviewer).toEqual({ id: REVIEWER_ID, name: null });
  });
});

describe('how the database refuses', () => {
  it('SCRUM284_AC1_42501_becomes_a_ForbiddenError', async () => {
    const client = fakeClient({ data: null, error: { code: '42501', message: 'Only technical support staff can see the equipment request queue' } });
    const err = await failure(getEquipmentRequestQueue({}, { callerId: CALLER_ID, client }));
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM284_AC1_a_missing_caller_is_sent_as_null_for_the_database_to_refuse', async () => {
    const client = fakeClient();
    await getEquipmentRequestQueue({}, { client });
    expect(client.rpc).toHaveBeenCalledWith('equipment_request_queue', expect.objectContaining({ p_caller: null }));
  });

  it('SCRUM284_AC2_22023_becomes_a_ValidationError', async () => {
    const client = fakeClient({ data: null, error: { code: '22023', message: 'Unknown status x' } });
    const err = await failure(getEquipmentRequestQueue({}, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Unknown status x');
  });

  it('SCRUM284_AC2_a_failure_with_no_message_still_says_what_went_wrong', async () => {
    const client = fakeClient({ data: null, error: { code: 'XX000' } });
    const err = await failure(getEquipmentRequestQueue({}, { client }));
    expect(err.message).toBe('Unexpected database error');
  });

  it('SCRUM284_AC6_any_other_failure_is_left_untyped_so_it_is_a_500', async () => {
    const client = fakeClient({ data: null, error: { code: 'XX000', message: 'boom' } });
    const err = await failure(getEquipmentRequestQueue({}, { client }));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });
});

describe('the default client', () => {
  it('SCRUM284_AC2_uses_the_shared_Supabase_client_when_none_is_passed', async () => {
    defaultClient.rpc.mockResolvedValueOnce(ok({ needs_action: [], requests: [] }));
    expect(await getEquipmentRequestQueue({}, { callerId: CALLER_ID })).toMatchObject({ needsAction: [], requests: [] });
    expect(defaultClient.rpc).toHaveBeenCalledWith('equipment_request_queue', {
      p_caller: CALLER_ID,
      p_status: null,
      p_include_past: false,
    });
  });
});
