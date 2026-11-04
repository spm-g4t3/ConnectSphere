/**
 * Tests for what Venue Staff send to resolve a flagged booking.
 *
 * SCRUM-266. The route tests cover the refusals end to end; these pin what the
 * validator hands on: the id lower-cased, the reason trimmed, and the same
 * 1000-character cap 076 puts on booking_resolutions.reason.
 */

import { describe, it, expect } from 'vitest';

import {
  validateFlaggedBookingEventId,
  validateFlaggedBookingId,
  validateResolution,
  RESOLUTION_REASON_MAX_LENGTH,
} from '../../src/validation/flaggedBookingValidation.js';
import { ValidationError } from '../../src/errors.js';

const BOOKING_ID = '44444444-4444-4444-8444-444444444444';

const refusalOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

describe('validateFlaggedBookingId', () => {
  it('SCRUM266_AC2_a_booking_id_is_trimmed_and_lower_cased', () => {
    expect(validateFlaggedBookingId(`  ${BOOKING_ID.toUpperCase()}  `)).toBe(BOOKING_ID);
  });

  it.each([undefined, null, '', 'nope', 42])('SCRUM266_AC2_the_id_%j_is_refused', (id) => {
    const err = refusalOf(() => validateFlaggedBookingId(id));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'id', message: 'must be a valid booking request id' }]);
  });
});

describe('validateFlaggedBookingEventId', () => {
  const EVENT_ID = '22222222-2222-4222-8222-222222222222';

  it('SCRUM266_AC1_an_event_id_is_trimmed_and_lower_cased', () => {
    expect(validateFlaggedBookingEventId(`  ${EVENT_ID.toUpperCase()}  `)).toBe(EVENT_ID);
  });

  it.each([undefined, null, '', 'nope', 42])('SCRUM266_AC1_the_event_id_%j_is_refused', (id) => {
    const err = refusalOf(() => validateFlaggedBookingEventId(id));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid event request id' }]);
  });
});

describe('validateResolution', () => {
  it('SCRUM266_AC5_the_cap_matches_the_database', () => {
    expect(RESOLUTION_REASON_MAX_LENGTH).toBe(1000);
  });

  it('SCRUM266_AC5_returns_only_the_trimmed_reason', () => {
    expect(validateResolution({ reason: '  Block moved  ', status: 'approved', callerId: 'x' })).toEqual({
      reason: 'Block moved',
    });
  });

  it.each([undefined, null, 'Block moved', 42, ['Block moved']])(
    'SCRUM266_AC5_the_input_%j_is_not_an_object_and_is_refused',
    (input) => {
      const err = refusalOf(() => validateResolution(input));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('Invalid resolution -- expected an object');
    },
  );

  it.each([
    ['no reason', {}],
    ['a null reason', { reason: null }],
    ['an empty reason', { reason: '' }],
    ['a blank reason', { reason: '   ' }],
  ])('SCRUM266_AC5_%s_is_refused_as_required', (_label, input) => {
    const err = refusalOf(() => validateResolution(input));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'reason', message: 'is required' }]);
    expect(err.message).toBe('Invalid resolution -- reason: is required');
  });

  it.each([42, true, { text: 'x' }, ['x']])('SCRUM266_AC5_a_reason_of_%j_must_be_text', (reason) => {
    const err = refusalOf(() => validateResolution({ reason }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'reason', message: 'must be text' }]);
  });

  it('SCRUM266_AC5_a_reason_over_1000_characters_is_refused', () => {
    const err = refusalOf(() => validateResolution({ reason: 'x'.repeat(1001) }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'reason', message: 'must be 1000 characters or fewer' }]);
  });

  it('SCRUM266_AC5_a_reason_of_1000_characters_after_trimming_is_accepted', () => {
    expect(validateResolution({ reason: `  ${'x'.repeat(1000)}  ` }).reason).toHaveLength(1000);
  });

  // Postgres counts code points; a UTF-16 length would refuse this at 2000.
  it('SCRUM266_AC5_the_length_counts_code_points_not_utf16_units', () => {
    const emoji = '\u{1F600}';
    expect(validateResolution({ reason: emoji.repeat(1000) }).reason).toBe(emoji.repeat(1000));
    expect(refusalOf(() => validateResolution({ reason: emoji.repeat(1001) }))).toBeInstanceOf(ValidationError);
  });
});
