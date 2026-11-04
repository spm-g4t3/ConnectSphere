/**
 * SCRUM-492 (SCRUM-564): the Released booking status in the domain vocabulary.
 * That the list still matches the SQL enum, 088 included, is
 * bookingStatus.test.js's SCRUM17_AC3_booking_statuses_match_the_sql_enum.
 */

import { describe, it, expect } from 'vitest';

import {
  BOOKING_STATUS,
  getBookingStatusDisplay,
  isBookingStatus,
} from '../../src/domain/bookingStatus.js';

describe('SCRUM-492: the Released status', () => {
  it('SCRUM492_AC2_released_is_a_booking_status_last_in_the_enum_order', () => {
    // AC2-05.
    expect(BOOKING_STATUS.RELEASED).toBe('released');
    expect(Object.values(BOOKING_STATUS).at(-1)).toBe('released');
    expect(isBookingStatus('released')).toBe(true);
  });

  it('SCRUM492_AC2_released_reads_as_released_in_its_own_group', () => {
    expect(getBookingStatusDisplay('released')).toEqual({
      status: 'released',
      label: 'Released',
      group: 'RELEASED',
      description: 'The coordinator released this venue, so it no longer holds the venue for this event.',
    });
  });
});
