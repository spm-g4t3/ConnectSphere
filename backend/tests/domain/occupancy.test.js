/**
 * Tests for the occupied part every occupancy mapper shares.
 */

import { describe, it, expect } from 'vitest';

import { toOccupiedPeriod } from '../../src/domain/occupancy.js';

describe('toOccupiedPeriod', () => {
  it('reads the padded period and the minutes from the row, in camelCase', () => {
    expect(toOccupiedPeriod({
      occupied_starts_at: '2026-11-02T08:30:00Z',
      occupied_ends_at: '2026-11-02T12:15:00Z',
      setup_minutes: 30,
      turnaround_minutes: 15,
      booking_id: 'ignored',
    })).toEqual({
      occupiedStartsAt: '2026-11-02T08:30:00Z',
      occupiedEndsAt: '2026-11-02T12:15:00Z',
      setupMinutes: 30,
      turnaroundMinutes: 15,
    });
  });

  it('leaves a field the row does not carry undefined, so JSON drops it', () => {
    expect(JSON.stringify(toOccupiedPeriod({}))).toBe('{}');
  });
});
