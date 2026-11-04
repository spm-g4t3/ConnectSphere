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
  ])('SCRUM495_AC3_capacity_%i_with_%i_registered_has_%i_left_full_%s', (capacity, count, placesLeft, isFull) => {
    expect(availability(capacity, count)).toEqual({ placesLeft, isFull });
  });

  it.each([11, 12, 500])('SCRUM495_AC3_never_goes_negative_%i_registered_against_a_capacity_of_10', (count) => {
    expect(availability(10, count)).toEqual({ placesLeft: 0, isFull: true });
  });

  it.each([null, undefined])('SCRUM495_AC3_treats_a_capacity_of_%s_as_no_limit_however_many_are_registered', (capacity) => {
    expect(availability(capacity, 0)).toEqual({ placesLeft: null, isFull: false });
    expect(availability(capacity, 10_000)).toEqual({ placesLeft: null, isFull: false });
  });
});

describe('SCRUM495_AC3 which registrations hold a place', () => {
  it('SCRUM495_AC3_counts_a_registered_one', () => {
    expect(holdsAPlace({ status: ACTIVE_REGISTRATION_STATUS })).toBe(true);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted', '', undefined, null])('SCRUM495_AC3_does_not_count_status_%j', (status) => {
    expect(holdsAPlace({ status })).toBe(false);
  });

  it('SCRUM495_AC3_does_not_count_a_missing_registration', () => {
    expect(holdsAPlace(undefined)).toBe(false);
  });
});
