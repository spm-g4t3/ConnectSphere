/**
 * Validation tests for the equipment request queue's query.
 *
 * SCRUM-285 for SCRUM-284. Named N22_ACn_<what_it_checks>. A value that is
 * present and wrong is refused with a message naming it, never ignored.
 */

import { describe, it, expect } from 'vitest';

import { checkQueueQuery } from '../../src/validation/equipmentQueueValidation.js';

describe('AC2: the status filter', () => {
  it.each(['pending_review', 'under_review', 'arranged', 'cannot_be_fully_arranged', 'cancelled'])(
    'N22_AC2_accepts_%s',
    (status) => {
      expect(checkQueueQuery({ status })).toEqual({ value: { status, includePast: false }, details: [] });
    },
  );

  it('N22_AC2_no_status_means_every_status', () => {
    expect(checkQueueQuery({}).value.status).toBeNull();
  });

  it('N22_AC2_an_empty_status_means_every_status', () => {
    expect(checkQueueQuery({ status: '' })).toEqual({ value: { status: null, includePast: false }, details: [] });
  });

  it.each(['arrange', 'ARRANGED', 'Pending review', ' arranged', 'done', '1', 'null'])(
    'N22_AC2_refuses_%j_and_names_the_field',
    (status) => {
      const result = checkQueueQuery({ status });
      expect(result.value).toBeNull();
      expect(result.details).toHaveLength(1);
      expect(result.details[0].field).toBe('status');
      expect(result.details[0].message).toContain('pending_review');
    },
  );

  it('N22_AC2_refuses_a_status_given_twice', () => {
    expect(checkQueueQuery({ status: ['arranged', 'cancelled'] }).details[0].field).toBe('status');
  });

  it('N22_AC2_refuses_a_status_that_is_an_object', () => {
    expect(checkQueueQuery({ status: { $ne: 'x' } }).details[0].field).toBe('status');
  });
});

describe('AC2: including past events', () => {
  it('N22_AC2_defaults_to_not_including_them', () => {
    expect(checkQueueQuery({}).value.includePast).toBe(false);
  });

  it('N22_AC2_true_includes_them', () => {
    expect(checkQueueQuery({ includePast: 'true' }).value.includePast).toBe(true);
  });

  it('N22_AC2_false_excludes_them', () => {
    expect(checkQueueQuery({ includePast: 'false' }).value.includePast).toBe(false);
  });

  it.each(['yes', '1', 'TRUE', 'True', 'on', ' true'])('N22_AC2_refuses_%j', (includePast) => {
    const result = checkQueueQuery({ includePast });
    expect(result.value).toBeNull();
    expect(result.details).toEqual([{ field: 'includePast', message: 'must be true or false' }]);
  });

  it('N22_AC2_refuses_includePast_given_twice', () => {
    expect(checkQueueQuery({ includePast: ['true', 'false'] }).details[0].field).toBe('includePast');
  });
});

describe('every fault is reported at once', () => {
  it('N22_a_bad_status_and_a_bad_includePast_are_both_named', () => {
    const fields = checkQueueQuery({ status: 'nope', includePast: 'maybe' }).details.map((d) => d.field);
    expect(fields).toEqual(['status', 'includePast']);
  });

  it('N22_unknown_parameters_are_ignored', () => {
    expect(checkQueueQuery({ sort: 'desc', page: '2' })).toEqual({ value: { status: null, includePast: false }, details: [] });
  });

  it.each([undefined, null, 'x', 5])('N22_a_query_that_is_%j_is_treated_as_empty', (query) => {
    expect(checkQueueQuery(query)).toEqual({ value: { status: null, includePast: false }, details: [] });
  });
});
