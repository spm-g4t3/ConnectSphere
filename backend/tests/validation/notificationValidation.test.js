/**
 * Tests for notification input validation.
 *
 * SCRUM-128 (part of SCRUM-17, AC3). validateNotificationId guards the one
 * input the notification routes read, the :id in PATCH /:id/read, so a
 * malformed id is a readable 400 without a database round trip.
 */

import { describe, it, expect } from 'vitest';

import { validateNotificationId } from '../../src/validation/notificationValidation.js';
import { ValidationError } from '../../src/errors.js';

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function errorFrom(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('validateNotificationId', () => {
  it('SCRUM17_AC3_accepts_a_uuid_and_returns_it_unchanged', () => {
    expect(validateNotificationId(ID)).toBe(ID);
  });

  it('accepts upper case, returned as given', () => {
    expect(validateNotificationId(ID.toUpperCase())).toBe(ID.toUpperCase());
  });

  it.each([
    ['empty', ''],
    ['not a uuid', 'not-a-uuid'],
    ['one character short', ID.slice(0, -1)],
    ['one character long', `${ID}0`],
    ['no hyphens', ID.replace(/-/g, '')],
    ['a non-hex character', `g${ID.slice(1)}`],
    ['surrounding whitespace', ` ${ID} `],
    ['a trailing newline', `${ID}\n`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { id: ID }],
    ['an array', [ID]],
  ])('SCRUM17_AC3_rejects_a_malformed_id (%s)', (_label, id) => {
    const err = errorFrom(() => validateNotificationId(id));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([
      { field: 'notificationId', message: 'must be a notification id' },
    ]);
    expect(err.message).toBe(
      'Invalid notification details -- notificationId: must be a notification id',
    );
  });
});
