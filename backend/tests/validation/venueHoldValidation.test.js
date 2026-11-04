/**
 * Tests for the venue hold validators.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff).
 *
 * Acceptance criteria carried in the test names:
 *   AC2 -- a hold is for one event, with an expiry that is required and in
 *          the future
 *
 * The clock is passed in, so "in the future" is tested against a fixed now.
 */

import { describe, it, expect } from 'vitest';

import { validatePlaceVenueHold, validateHoldTargetId } from '../../src/validation/venueHoldValidation.js';
import { ValidationError } from '../../src/errors.js';


const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-10T02:00:00.000Z');
const LATER = '2026-10-10T12:00:00+08:00';

function errorFrom(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

const fields = (err) => err.details.map((d) => d.field);


describe('validatePlaceVenueHold', () => {
  it('SCRUM491_AC2_accepts_an_event_and_a_future_expiry', () => {
    expect(validatePlaceVenueHold({ eventRequestId: ` ${EVENT_ID.toUpperCase()} `, expiresAt: ` ${LATER} ` }, NOW)).toEqual({
      eventRequestId: EVENT_ID,
      expiresAt: LATER,
    });
  });

  it('defaults the clock to now', () => {
    const result = validatePlaceVenueHold({ eventRequestId: EVENT_ID, expiresAt: '2999-01-01T00:00:00Z' });
    expect(result.expiresAt).toBe('2999-01-01T00:00:00Z');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('refuses %s as the body', (_label, input) => {
    const err = errorFrom(() => validatePlaceVenueHold(input, NOW));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Invalid venue hold -- expected an object');
  });

  it.each([undefined, null, ''])('SCRUM491_AC2_expiry_is_required (%s)', (expiresAt) => {
    const err = errorFrom(() => validatePlaceVenueHold({ eventRequestId: EVENT_ID, expiresAt }, NOW));
    expect(err.details).toEqual([{ field: 'expiresAt', message: 'is required' }]);
  });

  it.each([
    ['now exactly', '2026-10-10T02:00:00Z'],
    ['a minute ago', '2026-10-10T09:59:00+08:00'],
  ])('SCRUM491_AC2_expiry_must_be_in_the_future (%s)', (_label, expiresAt) => {
    const err = errorFrom(() => validatePlaceVenueHold({ eventRequestId: EVENT_ID, expiresAt }, NOW));
    expect(err.details).toEqual([{ field: 'expiresAt', message: 'must be in the future' }]);
  });

  it.each([
    ['no offset', '2026-10-11T09:00:00', 'must include a UTC offset, such as Z or +08:00'],
    ['a date only', '2026-10-11', 'must include a time of day, not a date on its own'],
    ['a number', 1_800_000_000_000, 'must be an ISO 8601 date and time, given as text'],
  ])('refuses an expiry with %s', (_label, expiresAt, message) => {
    const err = errorFrom(() => validatePlaceVenueHold({ eventRequestId: EVENT_ID, expiresAt }, NOW));
    expect(err.details).toEqual([{ field: 'expiresAt', message }]);
  });

  it.each([undefined, null, ''])('SCRUM491_AC2_the_event_is_required (%s)', (eventRequestId) => {
    const err = errorFrom(() => validatePlaceVenueHold({ eventRequestId, expiresAt: LATER }, NOW));
    expect(err.details).toEqual([{ field: 'eventRequestId', message: 'is required' }]);
  });

  it('refuses an event id that is not an id', () => {
    const err = errorFrom(() => validatePlaceVenueHold({ eventRequestId: 'abc', expiresAt: LATER }, NOW));
    expect(err.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid event id' }]);
  });

  it('reports every fault at once', () => {
    const err = errorFrom(() => validatePlaceVenueHold({}, NOW));
    expect(fields(err)).toEqual(['eventRequestId', 'expiresAt']);
    expect(err.message).toBe('Invalid venue hold -- eventRequestId: is required; expiresAt: is required');
  });
});


describe('validateHoldTargetId', () => {
  it('returns the id trimmed and lower-cased', () => {
    expect(validateHoldTargetId(` ${EVENT_ID.toUpperCase()} `)).toBe(EVENT_ID);
  });

  it('refuses a malformed venue id under id', () => {
    const err = errorFrom(() => validateHoldTargetId('nope'));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Invalid venue id -- id: must be a valid venue id');
  });

  it('refuses a missing id with its own field and label', () => {
    const err = errorFrom(() => validateHoldTargetId(undefined, 'eventRequestId', 'event'));
    expect(err.details).toEqual([{ field: 'eventRequestId', message: 'is required' }]);
  });
});
