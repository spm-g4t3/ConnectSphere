/**
 * Tests for the availability result labels and how one is chosen.
 * SCRUM-23 (AC8). The labels are asserted as literal strings because the
 * review of an equipment request (SCRUM-290) and SCRUM-176 reuse them.
 */

import { describe, it, expect } from 'vitest';
import {
  AVAILABILITY_RESULT,
  NOT_FOUND_MESSAGE,
  RETIRED_MESSAGE,
  deriveAvailabilityResult,
} from '../../src/domain/equipmentAvailabilityResult.js';

describe('the result labels', () => {
  it('SCRUM23_AC8_uses_exactly_the_three_agreed_labels', () => {
    expect(AVAILABILITY_RESULT).toEqual({
      FULLY_AVAILABLE: 'Fully available',
      PARTIALLY_AVAILABLE: 'Partially available',
      UNAVAILABLE: 'Unavailable',
    });
  });

  it('SCRUM23_AC8_cannot_be_changed_at_runtime', () => {
    expect(Object.isFrozen(AVAILABILITY_RESULT)).toBe(true);
  });

  it('SCRUM23_AC11_has_a_message_each_for_a_missing_and_a_retired_type', () => {
    expect(NOT_FOUND_MESSAGE).toMatch(/not found/);
    expect(RETIRED_MESSAGE).toMatch(/retired/);
  });
});

describe('deriveAvailabilityResult', () => {
  it.each([
    ['exactly enough', 5, 5, 'Fully available'],
    ['more than enough', 8, 5, 'Fully available'],
    ['some but not enough', 3, 5, 'Partially available'],
    ['one short of enough', 4, 5, 'Partially available'],
    ['one unit available of many wanted', 1, 100, 'Partially available'],
    ['none', 0, 5, 'Unavailable'],
    ['over-committed (negative)', -3, 5, 'Unavailable'],
    ['one wanted and one available', 1, 1, 'Fully available'],
  ])('SCRUM23_AC8_%s', (_label, available, requested, expected) => {
    expect(deriveAvailabilityResult(available, requested)).toBe(expected);
  });
});
