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
// SCRUM-127: a separate import so the existing one is left as it was.
import { validateUpdateBlock } from '../../src/validation/venueBlockValidation.js';
// SCRUM-130: a separate import so the existing ones are left as they were.
import {
  BLOCK_WINDOW_MAX_DAYS,
  validateBlockWindow,
  validatePeriod,
} from '../../src/validation/venueBlockValidation.js';

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


describe('SCRUM17_AC4 validateUpdateBlock', () => {
  const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const ID_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

  /** Run validateUpdateBlock and return the thrown error, or null. */
  function updateErrorFrom(input, options = { now: NOW }) {
    try {
      validateUpdateBlock(input, options);
      return null;
    } catch (err) {
      return err;
    }
  }

  function updateDetailsFrom(input, options) {
    const err = updateErrorFrom(input, options);
    expect(err).toBeInstanceOf(ValidationError);
    return err.details;
  }

  const update = (input) => validateUpdateBlock(input, { now: NOW });

  describe('nothing to amend', () => {
    it.each([
      ['empty', {}],
      ['override only', { confirmOverride: true, acknowledgedBookingIds: [ID_A] }],
      ['confirmOverride false only', { confirmOverride: false }],
      ['unknown keys only', { userId: 'x' }],
      ['several unknown keys', { userId: 'x', venueId: ID_A, removedAt: null }],
    ])('SCRUM17_AC4_refuses_a_patch_with_no_fields (%s)', (_label, input) => {
      const err = updateErrorFrom(input);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('Invalid venue block details -- no changes supplied');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'startsAt'],
      ['a number', 42],
      ['an array', [{ reason: 'maintenance' }]],
      ['an empty array', []],
    ])('SCRUM17_AC4_refuses_a_non_object (%s)', (_label, input) => {
      const err = updateErrorFrom(input);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('Invalid venue block details -- expected an object');
    });
  });

  describe('fields that cannot be cleared', () => {
    it.each(['startsAt', 'endsAt', 'reason'])(
      'SCRUM17_AC4_null_%s_is_refused_as_cannot_be_cleared',
      (field) => {
        expect(updateDetailsFrom({ [field]: null })).toEqual([
          { field, message: 'cannot be cleared' },
        ]);
      },
    );
  });

  describe('a single field', () => {
    it('SCRUM17_AC4_startsAt_alone_is_accepted_and_the_rest_keep', () => {
      expect(update({ startsAt: ' 2026-10-01T08:00:00+08:00 ' })).toEqual({
        startsAt: '2026-10-01T08:00:00+08:00',
        endsAt: null,
        reason: null,
        notes: null,
        notesSupplied: false,
        confirmOverride: false,
        acknowledgedBookingIds: [],
      });
    });

    it('SCRUM17_AC4_endsAt_alone_is_accepted', () => {
      const result = update({ endsAt: '2026-10-02T17:00:00+08:00' });
      expect(result.endsAt).toBe('2026-10-02T17:00:00+08:00');
      expect(result.startsAt).toBeNull();
      expect(result.reason).toBeNull();
      expect(result.notesSupplied).toBe(false);
    });

    it('SCRUM17_AC4_reason_alone_is_accepted', () => {
      const result = update({ reason: 'renovation' });
      expect(result.reason).toBe('renovation');
      expect(result.startsAt).toBeNull();
      expect(result.endsAt).toBeNull();
      expect(result.notesSupplied).toBe(false);
    });

    it('refuses an unknown reason with the vocabulary message', () => {
      expect(updateDetailsFrom({ reason: 'party' })).toEqual([
        { field: 'reason', message: REASON_MESSAGE },
      ]);
    });

    it('a start in the past is accepted, as on create', () => {
      expect(update({ startsAt: '2026-01-01T00:00:00Z' }).startsAt).toBe('2026-01-01T00:00:00Z');
    });

    it('unknown keys beside a real field are ignored', () => {
      const result = update({ reason: 'safety', userId: 'x' });
      expect(result).not.toHaveProperty('userId');
      expect(result.reason).toBe('safety');
    });
  });

  describe('notes', () => {
    it.each([
      ['null', null],
      ['empty', ''],
      ['blank', '   '],
    ])('SCRUM17_AC4_notes_%s_clears_them', (_label, notes) => {
      const result = update({ notes });
      expect(result.notesSupplied).toBe(true);
      expect(result.notes).toBeNull();
    });

    it('SCRUM17_AC4_omitted_notes_are_kept', () => {
      const result = update({ reason: 'maintenance' });
      expect(result.notesSupplied).toBe(false);
      expect(result.notes).toBeNull();
    });

    it('SCRUM17_AC4_notes_text_is_trimmed_and_supplied', () => {
      const result = update({ notes: '  New projector  ' });
      expect(result.notesSupplied).toBe(true);
      expect(result.notes).toBe('New projector');
    });

    it('SCRUM17_AC4_notes_over_1000_code_points_are_refused', () => {
      expect(update({ notes: 'a'.repeat(1000) }).notes).toHaveLength(1000);
      expect(updateDetailsFrom({ notes: 'a'.repeat(1001) })).toEqual([
        { field: 'notes', message: 'must be 1000 characters or fewer' },
      ]);
    });

    it('SCRUM17_AC4_an_emoji_counts_as_one_character', () => {
      const thousandEmoji = '\u{1F600}'.repeat(1000);
      expect(thousandEmoji.length).toBe(2000);
      expect(update({ notes: thousandEmoji }).notes).toBe(thousandEmoji);
      expect(updateDetailsFrom({ notes: '\u{1F600}'.repeat(1001) })).toEqual([
        { field: 'notes', message: 'must be 1000 characters or fewer' },
      ]);
    });

    it('refuses non-text notes', () => {
      expect(updateDetailsFrom({ notes: 42 })).toEqual([
        { field: 'notes', message: 'must be text' },
      ]);
    });
  });

  describe('the period', () => {
    it('SCRUM17_AC4_endsAt_in_the_past_is_refused', () => {
      expect(updateDetailsFrom({ endsAt: '2026-09-22T23:59:59Z' })).toEqual([
        { field: 'endsAt', message: 'must be in the future' },
      ]);
    });

    it('SCRUM17_AC4_endsAt_equal_to_now_is_refused', () => {
      expect(updateDetailsFrom({ endsAt: NOW.toISOString() })).toEqual([
        { field: 'endsAt', message: 'must be in the future' },
      ]);
    });

    it('judges the future against the injected now', () => {
      const endsAt = '2026-09-23T00:00:01Z';
      expect(update({ endsAt }).endsAt).toBe(endsAt);
      expect(
        updateDetailsFrom({ endsAt }, { now: new Date('2026-09-23T00:00:02Z') }),
      ).toEqual([{ field: 'endsAt', message: 'must be in the future' }]);
    });

    it('SCRUM17_AC4_both_times_reversed_are_refused', () => {
      expect(
        updateDetailsFrom({
          startsAt: '2026-10-01T17:00:00+08:00',
          endsAt: '2026-10-01T09:00:00+08:00',
        }),
      ).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
    });

    it('both times equal are refused', () => {
      expect(
        updateDetailsFrom({
          startsAt: '2026-10-01T09:00:00+08:00',
          endsAt: '2026-10-01T01:00:00Z',
        }),
      ).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC4_endsAt_alone_is_not_compared_with_any_start', () => {
      // Earlier than the stored start of every fixture block; only the
      // database can see the stored start, so the validator must not judge it.
      const endsAt = '2026-09-23T00:00:01Z';
      expect(update({ endsAt }).endsAt).toBe(endsAt);
    });

    it('a malformed time is refused with the timestamp message', () => {
      expect(updateDetailsFrom({ startsAt: '2026-10-01' })).toEqual([
        { field: 'startsAt', message: 'must include a time of day, not a date on its own' },
      ]);
    });
  });

  describe('reason other', () => {
    it('SCRUM17_AC4_reason_other_with_notes_cleared_is_refused', () => {
      for (const notes of [null, '', '   ']) {
        expect(updateDetailsFrom({ reason: 'other', notes })).toEqual([
          { field: 'notes', message: 'is required when the reason is other' },
        ]);
      }
    });

    it('SCRUM17_AC4_reason_other_alone_is_accepted_for_the_database_to_judge', () => {
      const result = update({ reason: 'other' });
      expect(result.reason).toBe('other');
      expect(result.notesSupplied).toBe(false);
    });

    it('reason other with notes is accepted', () => {
      const result = update({ reason: 'other', notes: 'Film shoot' });
      expect(result.reason).toBe('other');
      expect(result.notes).toBe('Film shoot');
    });

    it('clearing notes alone is accepted (the stored reason is unknown here)', () => {
      expect(update({ notes: null }).notesSupplied).toBe(true);
    });
  });

  describe('SCRUM17_AC3 override pairing on an amendment', () => {
    it('SCRUM17_AC3_override_without_ids_is_refused', () => {
      expect(updateDetailsFrom({ reason: 'safety', confirmOverride: true })).toEqual([
        { field: 'acknowledgedBookingIds', message: 'must list the bookings being overridden' },
      ]);
    });

    it('SCRUM17_AC3_ids_without_override_are_refused', () => {
      expect(updateDetailsFrom({ reason: 'safety', acknowledgedBookingIds: [ID_A] })).toEqual([
        { field: 'acknowledgedBookingIds', message: 'can only be sent with confirmOverride' },
      ]);
    });

    it('SCRUM17_AC3_ids_are_lowercased_and_deduped', () => {
      const result = update({
        endsAt: '2026-10-02T17:00:00+08:00',
        confirmOverride: true,
        acknowledgedBookingIds: [ID_B.toUpperCase(), ID_A, ID_B, ID_A.toUpperCase()],
      });
      expect(result.confirmOverride).toBe(true);
      expect(result.acknowledgedBookingIds).toEqual([ID_B, ID_A]);
    });

    it('SCRUM17_AC3_string_true_is_refused', () => {
      expect(
        updateDetailsFrom({
          reason: 'safety',
          confirmOverride: 'true',
          acknowledgedBookingIds: [ID_A],
        }),
      ).toEqual([{ field: 'confirmOverride', message: 'must be true or false' }]);
    });

    it('override fields default to false and []', () => {
      const result = update({ reason: 'safety' });
      expect(result.confirmOverride).toBe(false);
      expect(result.acknowledgedBookingIds).toEqual([]);
    });
  });

  describe('every fault at once', () => {
    it('SCRUM17_AC4_reports_every_fault_together', () => {
      const err = updateErrorFrom({
        startsAt: null,
        endsAt: '2026-09-01T00:00:00Z',
        reason: 'party',
        notes: 'x'.repeat(1001),
        confirmOverride: true,
      });
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([
        { field: 'startsAt', message: 'cannot be cleared' },
        { field: 'endsAt', message: 'must be in the future' },
        { field: 'reason', message: REASON_MESSAGE },
        { field: 'notes', message: 'must be 1000 characters or fewer' },
        { field: 'acknowledgedBookingIds', message: 'must list the bookings being overridden' },
      ]);
      expect(err.message).toMatch(/^Invalid venue block details -- startsAt: cannot be cleared; /);
    });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): the block window the venue calendar reads
// through, and the full period findBlockedVenueIds is asked about.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 block read windows', () => {
  const DAY_MS = 86_400_000;
  const FROM = '2026-01-01T00:00:00.000Z';
  const at = (ms) => new Date(Date.parse(FROM) + ms).toISOString();

  function thrown(fn) {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  }

  it('SCRUM17_AC2_BLOCK_WINDOW_MAX_DAYS_is_400', () => {
    expect(BLOCK_WINDOW_MAX_DAYS).toBe(400);
  });

  describe('validateBlockWindow', () => {
    it.each([
      ['no argument', undefined],
      ['an empty object', {}],
      ['both undefined', { from: undefined, to: undefined }],
      ['both blank', { from: '', to: '  ' }],
      ['both null', { from: null, to: null }],
    ])('SCRUM17_AC2_no_window_for_%s_is_null', (_label, input) => {
      expect(validateBlockWindow(input)).toBeNull();
    });

    it('SCRUM17_AC2_a_valid_window_comes_back_trimmed_as_from_and_to', () => {
      expect(
        validateBlockWindow({ from: ' 2026-10-01T00:00:00+08:00 ', to: '2026-11-01T00:00:00+08:00  ' }),
      ).toEqual({ from: '2026-10-01T00:00:00+08:00', to: '2026-11-01T00:00:00+08:00' });
    });

    it('SCRUM17_AC2_exactly_400_days_passes', () => {
      expect(validateBlockWindow({ from: FROM, to: at(400 * DAY_MS) })).toEqual({
        from: FROM,
        to: at(400 * DAY_MS),
      });
    });

    it('SCRUM17_AC2_one_ms_over_400_days_fails_on_to', () => {
      const err = thrown(() => validateBlockWindow({ from: FROM, to: at(400 * DAY_MS + 1) }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'to', message: 'must be within 400 days of the start' }]);
      expect(err.message).toMatch(/^Invalid venue block details -- to: must be within 400 days/);
    });

    it('SCRUM17_AC2_a_missing_from_is_reported_on_from', () => {
      const err = thrown(() => validateBlockWindow({ to: FROM }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'from', message: 'is required when an end is given' }]);
    });

    it('SCRUM17_AC2_a_missing_to_is_reported_on_to', () => {
      const err = thrown(() => validateBlockWindow({ from: FROM, to: '' }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'to', message: 'is required when a start is given' }]);
    });

    it.each([
      ['equal', FROM, FROM],
      ['reversed', at(DAY_MS), FROM],
    ])('SCRUM17_AC2_an_%s_window_is_refused_on_to', (_label, from, to) => {
      const err = thrown(() => validateBlockWindow({ from, to }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_a_malformed_from_is_refused', () => {
      const err = thrown(() => validateBlockWindow({ from: '2026-10-01T00:00:00 08:00', to: FROM }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details.map((d) => d.field)).toEqual(['from']);
    });

    it('SCRUM17_AC2_a_past_window_is_accepted_(the_calendar_shows_the_past)', () => {
      expect(
        validateBlockWindow({ from: '2001-01-01T00:00:00Z', to: '2001-02-01T00:00:00Z' }),
      ).toEqual({ from: '2001-01-01T00:00:00Z', to: '2001-02-01T00:00:00Z' });
    });
  });

  describe('validatePeriod', () => {
    it('SCRUM17_AC2_a_full_period_comes_back_trimmed', () => {
      expect(
        validatePeriod({ startsAt: ' 2026-10-01T09:00:00+08:00', endsAt: '2026-10-01T17:00:00+08:00 ' }),
      ).toEqual({ startsAt: '2026-10-01T09:00:00+08:00', endsAt: '2026-10-01T17:00:00+08:00' });
    });

    it.each([
      ['no argument', undefined],
      ['an empty object', {}],
      ['both blank', { startsAt: '', endsAt: ' ' }],
      ['both null', { startsAt: null, endsAt: null }],
    ])('SCRUM17_AC2_neither_end_(%s)_reports_both_as_required', (_label, input) => {
      const err = thrown(() => validatePeriod(input));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([
        { field: 'startsAt', message: 'is required' },
        { field: 'endsAt', message: 'is required' },
      ]);
    });

    it('SCRUM17_AC2_a_one_sided_period_names_the_missing_end', () => {
      const err = thrown(() => validatePeriod({ startsAt: FROM }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'endsAt', message: 'is required when a start is given' }]);
    });

    it('SCRUM17_AC2_a_reversed_period_is_refused_on_endsAt', () => {
      const err = thrown(() => validatePeriod({ startsAt: at(DAY_MS), endsAt: FROM }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_a_period_has_no_cap', () => {
      expect(validatePeriod({ startsAt: FROM, endsAt: '2030-01-01T00:00:00Z' })).toEqual({
        startsAt: FROM,
        endsAt: '2030-01-01T00:00:00Z',
      });
    });
  });
});
