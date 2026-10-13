// SCRUM-495 (AC3): remaining places and which registrations hold one.

import { describe, it, expect } from 'vitest';

import {
  ACTIVE_REGISTRATION_STATUS,
  availability,
  holdsAPlace,
} from '../../src/domain/registrationAvailability.js';

describe('SCRUM495_AC3 availability', () => {
  it.each([
    [10, 0, 10, false],
    [10, 3, 7, false],
    [10, 9, 1, false],
    [10, 10, 0, true],
    [1, 1, 0, true],
  ])('capacity %i with %i registered has %i left (full: %s)', (capacity, count, placesLeft, isFull) => {
    expect(availability(capacity, count)).toEqual({ placesLeft, isFull });
  });

  it.each([11, 12, 500])('never goes negative: %i registered against a capacity of 10', (count) => {
    expect(availability(10, count)).toEqual({ placesLeft: 0, isFull: true });
  });

  it.each([null, undefined])('treats a capacity of %s as no limit, however many are registered', (capacity) => {
    expect(availability(capacity, 0)).toEqual({ placesLeft: null, isFull: false });
    expect(availability(capacity, 10_000)).toEqual({ placesLeft: null, isFull: false });
  });
});

describe('SCRUM495_AC3 which registrations hold a place', () => {
  it('counts a registered one', () => {
    expect(holdsAPlace({ status: ACTIVE_REGISTRATION_STATUS })).toBe(true);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted', '', undefined, null])('does not count status %j', (status) => {
    expect(holdsAPlace({ status })).toBe(false);
  });

  it('does not count a missing registration', () => {
    expect(holdsAPlace(undefined)).toBe(false);
  });
});
