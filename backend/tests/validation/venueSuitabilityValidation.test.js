/**
 * Tests for validateSuitabilityQuery.
 *
 * SCRUM-190, a subtask of SCRUM-188. The route tests cover the refusals end to
 * end; these pin what the validator hands on: ids lower-cased, a blank layout
 * as null, missing lists as [], nothing the caller must not choose, and every
 * fault reported at once.
 */

import { describe, it, expect } from 'vitest';

import { validateSuitabilityQuery } from '../../src/validation/venueSuitabilityValidation.js';
import { ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const BASE = { eventRequestId: EVENT_ID, venueId: VENUE_ID };

const faultsOf = (input) => {
  try {
    validateSuitabilityQuery(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err.details;
  }
  throw new Error('expected a ValidationError');
};

describe('SCRUM188_AC1 validateSuitabilityQuery', () => {
  it('SCRUM188_AC1_returns_only_the_coordinators_choices_with_defaults', () => {
    expect(
      validateSuitabilityQuery({ ...BASE, startsAt: 'x', expectedAttendance: 5, userId: 'someone' }),
    ).toEqual({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: null,
      accessibility: [],
      facilities: [],
    });
  });

  it('SCRUM188_AC1_normalises_ids_layout_and_codes', () => {
    expect(
      validateSuitabilityQuery({
        eventRequestId: ` ${EVENT_ID.toUpperCase()} `,
        venueId: VENUE_ID.toUpperCase(),
        layout: ' u_shape ',
        accessibility: [' wheelchair_access '],
        facilities: ['projector', 'wifi'],
      }),
    ).toEqual({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: 'u_shape',
      accessibility: ['wheelchair_access'],
      facilities: ['projector', 'wifi'],
    });
  });

  it.each([undefined, null, '', '   '])('SCRUM188_AC1_layout_%j_is_none_asked_for', (layout) => {
    expect(validateSuitabilityQuery({ ...BASE, layout }).roomLayoutCode).toBeNull();
  });

  it.each([null, undefined, 'text', 7, []])('SCRUM188_AC1_refuses_%j_as_the_input', (input) => {
    expect(() => validateSuitabilityQuery(input)).toThrow(ValidationError);
  });

  it('SCRUM188_AC1_reports_every_fault_at_once', () => {
    expect(
      faultsOf({ venueId: 'nope', layout: ['theatre', 'banquet'], accessibility: 'ramp', facilities: [''] }),
    ).toEqual([
      { field: 'eventRequestId', message: 'is required' },
      { field: 'venueId', message: 'must be a valid venue id' },
      { field: 'layout', message: 'must be a single layout code' },
      { field: 'accessibility', message: 'must be an array of codes' },
      { field: 'facilities', message: 'entry 0 must be a non-empty code' },
    ]);
  });

  it.each(['Theatre', 'u-shape', '1row', 'a'.repeat(51)])('SCRUM188_AC1_refuses_layout_%s', (layout) => {
    expect(faultsOf({ ...BASE, layout })).toEqual([
      { field: 'layout', message: 'must be a room layout code, such as theatre or u_shape' },
    ]);
  });

  it('SCRUM188_AC1_a_malformed_event_id_is_named', () => {
    expect(faultsOf({ ...BASE, eventRequestId: 'not-an-id' })).toEqual([
      { field: 'eventRequestId', message: 'must be a valid event id' },
    ]);
  });
});

describe('SCRUM525_AC3 validateSuitabilityQuery reads ?attendance=', () => {
  // The route test (B-AC3-05) covers 0, -5, 1.5, abc and blank end to end.
  // These are the text shapes only the validator can tell apart: ones
  // Number() would happily read as a whole number, so a looser rule (a
  // Number() and isInteger check) would let them through.
  it.each([
    ['an exponent', '1e2'],
    ['a sign', '+5'],
    ['a repeated key', ['80', '90']],
    ['more than a safe integer', '9007199254740993'],
  ])('SCRUM525_AC3_attendance_as_%s_is_refused', (_label, attendance) => {
    expect(faultsOf({ ...BASE, attendance })).toEqual([
      { field: 'attendance', message: 'must be a whole number greater than zero' },
    ]);
  });

  it('SCRUM525_AC3_attendance_1_and_a_padded_80_are_read_as_numbers', () => {
    // 1 is the boundary beside the refused 0; the padding is trimmed, as the
    // layout's is, and the text becomes a number the capacity can be compared with.
    expect(validateSuitabilityQuery({ ...BASE, attendance: '1' }).expectedAttendance).toBe(1);
    expect(validateSuitabilityQuery({ ...BASE, attendance: ' 80 ' }).expectedAttendance).toBe(80);
  });
});
