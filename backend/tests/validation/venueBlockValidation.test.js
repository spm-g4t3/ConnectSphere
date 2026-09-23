/**
 * Tests for venue block input validation.
 *
 * SCRUM-126 (part of SCRUM-17). AC1: "a block is created with venue,
 * start/end datetime, reason category". Every rule the validator enforces is
 * pinned here, with `now` injected so the future-end rule is deterministic.
 */

import { describe, it, expect } from 'vitest';

import {
  validateCreateBlock,
  validateBlockId,
} from '../../src/validation/venueBlockValidation.js';
import { ValidationError } from '../../src/errors.js';

const NOW = new Date('2026-09-23T00:00:00Z');

const REASON_MESSAGE =
  'must be one of: maintenance, renovation, safety, internal_activity, other';

function validBlock(overrides = {}) {
  return {
    startsAt: '2026-10-01T09:00:00+08:00',
    endsAt: '2026-10-01T17:00:00+08:00',
    reason: 'maintenance',
    ...overrides,
  };
}

/** Run the validator and return the thrown error, or null if it passed. */
function errorFrom(input, options = { now: NOW }) {
  try {
    validateCreateBlock(input, options);
    return null;
  } catch (err) {
    return err;
  }
}

/** The details of the thrown ValidationError; fails the test if none was thrown. */
function detailsFrom(input, options) {
  const err = errorFrom(input, options);
  expect(err).toBeInstanceOf(ValidationError);
  return err.details;
}


describe('SCRUM17_AC1 a valid block', () => {
  it('SCRUM17_AC1_valid_block_comes_back_normalised', () => {
    const result = validateCreateBlock(
      validBlock({
        startsAt: '  2026-10-01T09:00:00+08:00 ',
        notes: '  Replacing the projector  ',
      }),
      { now: NOW },
    );

    expect(result).toEqual({
      startsAt: '2026-10-01T09:00:00+08:00',
      endsAt: '2026-10-01T17:00:00+08:00',
      reason: 'maintenance',
      notes: 'Replacing the projector',
      confirmOverride: false,
      acknowledgedBookingIds: [],
    });
  });

  it('gives null notes when none were sent', () => {
    expect(validateCreateBlock(validBlock(), { now: NOW }).notes).toBeNull();
  });

  it.each(['maintenance', 'renovation', 'safety', 'internal_activity', 'other'])(
    'SCRUM17_AC1_accepts_reason_%s',
    (reason) => {
      const result = validateCreateBlock(validBlock({ reason, notes: 'why' }), { now: NOW });
      expect(result.reason).toBe(reason);
    },
  );

  it('ignores unknown keys such as venueId', () => {
    const result = validateCreateBlock(validBlock({ venueId: 'x' }), { now: NOW });
    expect(Object.keys(result).sort()).toEqual([
      'acknowledgedBookingIds',
      'confirmOverride',
      'endsAt',
      'notes',
      'reason',
      'startsAt',
    ]);
  });
});


describe('SCRUM17_AC1 reason category', () => {
  it.each(['MAINTENANCE', 'toString', 'constructor', 'holiday', '', 42])(
    'SCRUM17_AC1_rejects_unknown_reason %s',
    (reason) => {
      expect(detailsFrom(validBlock({ reason }))).toEqual([
        { field: 'reason', message: REASON_MESSAGE },
      ]);
    },
  );

  it.each([undefined, null])('SCRUM17_AC1_reason_is_required (%s)', (reason) => {
    expect(detailsFrom(validBlock({ reason }))).toEqual([
      { field: 'reason', message: 'is required' },
    ]);
  });
});


describe('SCRUM17_AC1 start and end', () => {
  it.each(['startsAt', 'endsAt'])('SCRUM17_AC1_%s_is_required', (field) => {
    for (const value of [undefined, null]) {
      const details = detailsFrom(validBlock({ [field]: value }));
      expect(details).toContainEqual({ field, message: 'is required' });
    }
  });

  it('SCRUM17_AC1_timestamps_need_an_offset', () => {
    expect(
      detailsFrom(validBlock({ startsAt: '2026-10-01T09:00:00', endsAt: '2026-10-01' })),
    ).toEqual([
      { field: 'startsAt', message: 'must include a UTC offset, such as Z or +08:00' },
      { field: 'endsAt', message: 'must include a time of day, not a date on its own' },
    ]);
  });

  it('rejects 30 February and non-string timestamps through checkTimestamp', () => {
    expect(
      detailsFrom(validBlock({ startsAt: '2026-02-30T09:00:00Z', endsAt: 1780000000000 })),
    ).toEqual([
      {
        field: 'startsAt',
        message: 'is not a real date -- that month does not have that many days',
      },
      { field: 'endsAt', message: 'must be an ISO 8601 date and time, given as text' },
    ]);
  });

  it('SCRUM17_AC1_end_must_follow_start', () => {
    expect(
      detailsFrom(
        validBlock({ startsAt: '2026-10-02T09:00:00Z', endsAt: '2026-10-01T09:00:00Z' }),
      ),
    ).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
  });

  it('SCRUM17_AC1_equal_start_and_end_is_rejected', () => {
    // The same instant written in two offsets is still equal.
    expect(
      detailsFrom(
        validBlock({ startsAt: '2026-10-01T09:00:00+08:00', endsAt: '2026-10-01T01:00:00Z' }),
      ),
    ).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
  });

  it('does not judge the order when one side is missing', () => {
    expect(detailsFrom(validBlock({ startsAt: undefined }))).toEqual([
      { field: 'startsAt', message: 'is required' },
    ]);
  });

  it('SCRUM17_AC1_end_must_be_in_the_future', () => {
    expect(
      detailsFrom(
        validBlock({ startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-22T00:00:00Z' }),
      ),
    ).toEqual([{ field: 'endsAt', message: 'must be in the future' }]);
  });

  it('rejects an end exactly at now', () => {
    expect(
      detailsFrom(validBlock({ startsAt: '2026-09-01T00:00:00Z', endsAt: NOW.toISOString() })),
    ).toEqual([{ field: 'endsAt', message: 'must be in the future' }]);
  });

  it('reports both end faults together when a period is backwards and in the past', () => {
    expect(
      detailsFrom(
        validBlock({ startsAt: '2026-09-10T00:00:00Z', endsAt: '2026-09-05T00:00:00Z' }),
      ),
    ).toEqual([
      { field: 'endsAt', message: 'must be later than the start' },
      { field: 'endsAt', message: 'must be in the future' },
    ]);
  });

  it('SCRUM17_AC1_past_start_is_allowed_when_the_end_is_in_the_future', () => {
    const result = validateCreateBlock(
      validBlock({ startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-23T00:01:00Z' }),
      { now: NOW },
    );
    expect(result.startsAt).toBe('2026-09-01T00:00:00Z');
  });

  it('uses the real clock when now is not injected', () => {
    expect(() =>
      validateCreateBlock(
        validBlock({ startsAt: '2000-01-01T00:00:00Z', endsAt: '2001-01-01T00:00:00Z' }),
      ),
    ).toThrow(/must be in the future/);
  });
});


describe('SCRUM17_AC1 notes', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['whitespace', '   \n\t '],
  ])('SCRUM17_AC1_other_requires_notes (%s)', (_label, notes) => {
    expect(detailsFrom(validBlock({ reason: 'other', notes }))).toEqual([
      { field: 'notes', message: 'is required when the reason is other' },
    ]);
  });

  it('accepts other with notes', () => {
    expect(validateCreateBlock(validBlock({ reason: 'other', notes: 'Film shoot' }), { now: NOW }).notes)
      .toBe('Film shoot');
  });

  it('trims notes and turns blank notes into null', () => {
    expect(validateCreateBlock(validBlock({ notes: '  hi  ' }), { now: NOW }).notes).toBe('hi');
    expect(validateCreateBlock(validBlock({ notes: '   ' }), { now: NOW }).notes).toBeNull();
  });

  it('SCRUM17_AC1_notes_1000_characters_pass', () => {
    const notes = 'a'.repeat(1000);
    expect(validateCreateBlock(validBlock({ notes }), { now: NOW }).notes).toBe(notes);
  });

  it('SCRUM17_AC1_notes_1001_characters_fail', () => {
    expect(detailsFrom(validBlock({ notes: 'a'.repeat(1001) }))).toEqual([
      { field: 'notes', message: 'must be 1000 characters or fewer' },
    ]);
  });

  it('counts the limit after trimming', () => {
    const notes = `  ${'a'.repeat(1000)}  `;
    expect(validateCreateBlock(validBlock({ notes }), { now: NOW }).notes).toHaveLength(1000);
  });

  it('SCRUM17_AC1_notes_1000_emoji_pass (code points, as Postgres length() counts)', () => {
    const notes = '\u{1F6A7}'.repeat(1000); // 2000 UTF-16 units
    expect(notes.length).toBe(2000);
    expect(validateCreateBlock(validBlock({ notes }), { now: NOW }).notes).toBe(notes);
  });

  it('refuses 1001 emoji', () => {
    expect(detailsFrom(validBlock({ notes: '\u{1F6A7}'.repeat(1001) }))).toEqual([
      { field: 'notes', message: 'must be 1000 characters or fewer' },
    ]);
  });

  it.each([42, { text: 'x' }, ['x'], true])(
    'reports non-string notes once, even when the reason is other (%s)',
    (notes) => {
      expect(detailsFrom(validBlock({ reason: 'other', notes }))).toEqual([
        { field: 'notes', message: 'must be text' },
      ]);
    },
  );
});


describe('the whole form is reported at once', () => {
  it('SCRUM17_AC1_every_fault_is_reported_together', () => {
    const err = errorFrom({
      startsAt: '2026-10-01',
      reason: 'holiday',
      notes: 'x'.repeat(1001),
    });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([
      { field: 'startsAt', message: 'must include a time of day, not a date on its own' },
      { field: 'endsAt', message: 'is required' },
      { field: 'reason', message: REASON_MESSAGE },
      { field: 'notes', message: 'must be 1000 characters or fewer' },
    ]);
    expect(err.message).toBe(
      'Invalid venue block details -- ' +
        'startsAt: must include a time of day, not a date on its own; ' +
        'endsAt: is required; ' +
        `reason: ${REASON_MESSAGE}; ` +
        'notes: must be 1000 characters or fewer',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'block it'],
    ['an array', []],
    ['a number', 7],
  ])('SCRUM17_AC1_rejects_a_non_object: %s', (_label, input) => {
    const err = errorFrom(input);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Invalid venue block details -- expected an object');
  });
});


describe('SCRUM17_AC3 override fields', () => {
  const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const ID_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const ID_C = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  function uuidN(n) {
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  }

  it.each([
    ['missing', {}],
    ['null', { confirmOverride: null, acknowledgedBookingIds: null }],
  ])('SCRUM17_AC3_override_fields_default_to_false_and_empty (%s)', (_label, extra) => {
    const result = validateCreateBlock(validBlock(extra), { now: NOW });
    expect(result.confirmOverride).toBe(false);
    expect(result.acknowledgedBookingIds).toEqual([]);
  });

  it('accepts confirmOverride false with an empty list', () => {
    const result = validateCreateBlock(
      validBlock({ confirmOverride: false, acknowledgedBookingIds: [] }),
      { now: NOW },
    );
    expect(result.confirmOverride).toBe(false);
    expect(result.acknowledgedBookingIds).toEqual([]);
  });

  it('accepts an override with the acknowledged ids', () => {
    const result = validateCreateBlock(
      validBlock({ confirmOverride: true, acknowledgedBookingIds: [ID_A, ID_B] }),
      { now: NOW },
    );
    expect(result.confirmOverride).toBe(true);
    expect(result.acknowledgedBookingIds).toEqual([ID_A, ID_B]);
  });

  it.each(['true', 1, 0, 'false', {}, []])(
    'SCRUM17_AC3_confirmOverride_must_be_boolean (%s)',
    (confirmOverride) => {
      expect(detailsFrom(validBlock({ confirmOverride }))).toEqual([
        { field: 'confirmOverride', message: 'must be true or false' },
      ]);
    },
  );

  it.each([ID_A, 'x', 42, {}, true])(
    'SCRUM17_AC3_acknowledged_ids_must_be_an_array (%s)',
    (acknowledgedBookingIds) => {
      expect(
        detailsFrom(validBlock({ confirmOverride: true, acknowledgedBookingIds })),
      ).toEqual([{ field: 'acknowledgedBookingIds', message: 'must be a list of booking ids' }]);
    },
  );

  it('SCRUM17_AC3_acknowledged_ids_must_be_uuids (reported once)', () => {
    expect(
      detailsFrom(
        validBlock({
          confirmOverride: true,
          acknowledgedBookingIds: [ID_A, 'not-a-uuid', 42, null, `${ID_B}x`],
        }),
      ),
    ).toEqual([{ field: 'acknowledgedBookingIds', message: 'must contain only booking ids' }]);
  });

  it('SCRUM17_AC3_acknowledged_ids_are_deduped_and_lowercased', () => {
    const result = validateCreateBlock(
      validBlock({
        confirmOverride: true,
        acknowledgedBookingIds: [ID_B.toUpperCase(), ID_A, ID_B, ID_C, ID_A.toUpperCase()],
      }),
      { now: NOW },
    );
    expect(result.acknowledgedBookingIds).toEqual([ID_B, ID_A, ID_C]);
  });

  it('SCRUM17_AC3_override_requires_acknowledged_ids', () => {
    for (const extra of [
      { confirmOverride: true },
      { confirmOverride: true, acknowledgedBookingIds: [] },
      { confirmOverride: true, acknowledgedBookingIds: null },
    ]) {
      expect(detailsFrom(validBlock(extra))).toEqual([
        { field: 'acknowledgedBookingIds', message: 'must list the bookings being overridden' },
      ]);
    }
  });

  it('SCRUM17_AC3_acknowledged_ids_require_override', () => {
    for (const extra of [
      { acknowledgedBookingIds: [ID_A] },
      { confirmOverride: false, acknowledgedBookingIds: [ID_A] },
      { confirmOverride: null, acknowledgedBookingIds: [ID_A] },
    ]) {
      expect(detailsFrom(validBlock(extra))).toEqual([
        { field: 'acknowledgedBookingIds', message: 'can only be sent with confirmOverride' },
      ]);
    }
  });

  it('SCRUM17_AC3_acknowledged_ids_capped_at_500', () => {
    const five00 = Array.from({ length: 500 }, (_, i) => uuidN(i));
    expect(
      validateCreateBlock(
        validBlock({ confirmOverride: true, acknowledgedBookingIds: five00 }),
        { now: NOW },
      ).acknowledgedBookingIds,
    ).toHaveLength(500);

    const five01 = Array.from({ length: 501 }, (_, i) => uuidN(i));
    expect(
      detailsFrom(validBlock({ confirmOverride: true, acknowledgedBookingIds: five01 })),
    ).toEqual([{ field: 'acknowledgedBookingIds', message: 'must list 500 bookings or fewer' }]);
  });

  it('counts the cap before de-duplicating', () => {
    const repeated = Array.from({ length: 501 }, () => ID_A);
    expect(
      detailsFrom(validBlock({ confirmOverride: true, acknowledgedBookingIds: repeated })),
    ).toEqual([{ field: 'acknowledgedBookingIds', message: 'must list 500 bookings or fewer' }]);
  });

  it('reports a non-uuid and the cap together', () => {
    const ids = [...Array.from({ length: 500 }, (_, i) => uuidN(i)), 'bad'];
    expect(
      detailsFrom(validBlock({ confirmOverride: true, acknowledgedBookingIds: ids })),
    ).toEqual([
      { field: 'acknowledgedBookingIds', message: 'must contain only booking ids' },
      { field: 'acknowledgedBookingIds', message: 'must list 500 bookings or fewer' },
    ]);
  });

  it('skips the pairing rules when a field is malformed', () => {
    // A bad flag beside a list: only the bad flag is named.
    expect(
      detailsFrom(validBlock({ confirmOverride: 'yes', acknowledgedBookingIds: [ID_A] })),
    ).toEqual([{ field: 'confirmOverride', message: 'must be true or false' }]);

    // An override beside a bad list: only the bad list is named.
    expect(
      detailsFrom(validBlock({ confirmOverride: true, acknowledgedBookingIds: ['nope'] })),
    ).toEqual([{ field: 'acknowledgedBookingIds', message: 'must contain only booking ids' }]);

    // Both malformed: each named once.
    expect(detailsFrom(validBlock({ confirmOverride: 1, acknowledgedBookingIds: 'x' }))).toEqual([
      { field: 'confirmOverride', message: 'must be true or false' },
      { field: 'acknowledgedBookingIds', message: 'must be a list of booking ids' },
    ]);
  });

  it('SCRUM17_AC3_override_faults_reported_with_other_faults', () => {
    const err = errorFrom({
      startsAt: '2026-10-01',
      reason: 'holiday',
      confirmOverride: 'true',
      acknowledgedBookingIds: ['nope'],
    });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([
      { field: 'startsAt', message: 'must include a time of day, not a date on its own' },
      { field: 'endsAt', message: 'is required' },
      { field: 'reason', message: REASON_MESSAGE },
      { field: 'confirmOverride', message: 'must be true or false' },
      { field: 'acknowledgedBookingIds', message: 'must contain only booking ids' },
    ]);
    expect(err.message).toBe(
      'Invalid venue block details -- ' +
        'startsAt: must include a time of day, not a date on its own; ' +
        'endsAt: is required; ' +
        `reason: ${REASON_MESSAGE}; ` +
        'confirmOverride: must be true or false; ' +
        'acknowledgedBookingIds: must contain only booking ids',
    );
  });

  it('reports a pairing fault beside other faults', () => {
    expect(detailsFrom(validBlock({ reason: 'holiday', confirmOverride: true }))).toEqual([
      { field: 'reason', message: REASON_MESSAGE },
      { field: 'acknowledgedBookingIds', message: 'must list the bookings being overridden' },
    ]);
  });
});


describe('validateBlockId', () => {
  it('accepts a UUID and returns it unchanged', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(validateBlockId(id)).toBe(id);
    expect(validateBlockId(id.toUpperCase())).toBe(id.toUpperCase());
  });

  it.each(['', 'not-a-uuid', '3f2504e0-4f89-41d3-9a0c-0305e82c330', 42, null, undefined])(
    'rejects %s',
    (id) => {
      let err = null;
      try {
        validateBlockId(id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'blockId', message: 'must be a block id' }]);
      expect(err.message).toBe('Invalid venue block details -- blockId: must be a block id');
    },
  );
});
