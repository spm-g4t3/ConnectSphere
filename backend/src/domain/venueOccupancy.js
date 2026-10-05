/**
 * Is a venue free for an event?
 *
 * SCRUM-139, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * AC5: a venue is excluded when an existing booking or an active block
 * overlaps the requested period. Two periods overlap when
 *
 *     a.start < b.end && a.end > b.start
 *
 * with strict operators, so a period that ends exactly where the other begins
 * does not overlap. AC5's four boundary cases, against a request 10:00-12:00:
 *
 *  - a booking 08:00-10:00 ends at the request's start: no overlap, kept.
 *  - a booking 12:00-14:00 starts at the request's end: no overlap, kept.
 *  - a booking 08:00-10:01 runs one minute into it: overlap, excluded.
 *  - a booking 11:59-14:00 starts one minute before its end: overlap, excluded.
 *
 * This is the same half-open rule venue_blocks_no_overlap (011) and every
 * strict lt/gt read in the services use, so search and the database agree on
 * what touching means.
 *
 * AC6 and Week 7 (setup and turnaround). At a venue, an event occupies
 * [start - setup, end + turnaround), using that venue's own minutes -- and so
 * does the requested event, because it needs its own setup and turnaround
 * too. The customer's worked example: setup 30, turnaround 45, a booking
 * 10:00-12:00 occupies 09:30-12:45. A next request at the same venue pads its
 * own start back by 30 minutes, so the earliest it can start is 13:15 (padded
 * start 12:45, touching 12:45, no overlap); 13:14 is excluded.
 *
 * A block is a closure, not an event: it gets no setup or turnaround of its
 * own and is compared raw against the request's padded period, because the
 * event's setup and turnaround cannot fall inside a closure either.
 *
 * With both buffers at 0, every check here is exactly the plain AC5 rule.
 *
 * Operating hours are deliberately NOT here -- domain/venueMatching.js checks
 * them against the unpadded period (AC3 speaks of "the requested period").
 *
 * Pure: no database calls and no framework code, and the only imports are
 * other domain modules. venueOccupancyService.js reads the rows; this file
 * decides.
 *
 * Shapes:
 *  - venue: { setupMinutes, turnaroundMinutes }, as toVenueWithAttributes
 *    returns them.
 *  - request: { startsAt, endsAt }, ISO 8601 strings with an offset, or Dates.
 *  - bookings and blocks: rows { starts_at, ends_at } straight from PostgREST.
 */

import { BOOKING_STATUS } from './bookingStatus.js';
import { SETUP_MINUTES_OPTIONS } from './setupOptions.js';
import { TURNAROUND_MINUTES_OPTIONS } from './turnaroundOptions.js';

const MS_PER_MINUTE = 60 * 1000;

/**
 * The booking statuses that occupy a venue: approved AND flagged_for_review.
 *
 * Deliberately wider than AC5/AC6's word "approved". A flagged event still
 * holds its venue until the coordinator moves it -- Week 7 asks us to
 * "preserve the original event" rather than drop it. The block that flagged it
 * may since have been shortened or removed (015's header allows both), so the
 * booking can be the only thing left standing in that slot; counting approved
 * alone would then offer a venue that is in fact still held.
 *
 * The same allow-list the calendar uses (venueCalendarService.js), so the
 * calendar and the search never disagree on whether a slot is taken. An
 * allow-list rather than "not cancelled", so a status added later occupies
 * nothing until someone decides it should.
 *
 * Note for SCRUM-145's review: this goes beyond the acceptance criteria's
 * wording on purpose.
 */
export const OCCUPYING_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.APPROVED,
  BOOKING_STATUS.FLAGGED_FOR_REVIEW,
]);

/**
 * The widest any clash can reach beyond the request's own period, in minutes:
 * the largest setup option plus the largest turnaround option.
 *
 * Why the sum. With request [S, E) and a booking [bs, be), both padded with
 * the venue's setup and turnaround, they clash when
 *
 *     bs - setup < E + turn    <=>    bs < E + setup + turn
 *     be + turn  > S - setup   <=>    be > S - setup - turn
 *
 * so a clashing booking always starts before E + (setup + turn) and ends after
 * S - (setup + turn). Blocks are padded on one side only, so they sit inside
 * the same bound. The largest setup + turnaround any venue can have therefore
 * widens a read enough to catch every clash for every venue at once.
 *
 * Derived from the option lists rather than written as 240, so adding a
 * longer option widens the read with it.
 */
export const MAX_BUFFER_MINUTES =
  Math.max(...SETUP_MINUTES_OPTIONS) + Math.max(...TURNAROUND_MINUTES_OPTIONS);

/**
 * Do two periods overlap? The strict half-open rule, on epoch milliseconds.
 *
 * @param {number} aStart
 * @param {number} aEnd
 * @param {number} bStart
 * @param {number} bEnd
 * @returns {boolean}
 */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * The period an event occupies at a venue: [start - setup, end + turnaround).
 *
 * Instants, not wall-clock times, so the offset a timestamp was written with
 * never matters: '10:00+08:00' and '02:00Z' pad to the same period.
 *
 * @param {string|Date} startsAt  ISO 8601 with an offset, or a Date
 * @param {string|Date} endsAt
 * @param {number} setupMinutes
 * @param {number} turnaroundMinutes
 * @returns {{start: number, end: number}} epoch milliseconds
 */
export function paddedPeriod(startsAt, endsAt, setupMinutes, turnaroundMinutes) {
  return {
    start: new Date(startsAt).getTime() - setupMinutes * MS_PER_MINUTE,
    end: new Date(endsAt).getTime() + turnaroundMinutes * MS_PER_MINUTE,
  };
}

/**
 * AC5/AC6: is the venue free for the requested period?
 *
 * The caller passes only rows that occupy the venue -- bookings already
 * limited to OCCUPYING_BOOKING_STATUSES, blocks already limited to active
 * ones. This function decides only whether any of them clashes.
 *
 * Returns a boolean and nothing else, on purpose, like matchesAllCriteria:
 * SCRUM-145 checks that nothing diagnoses why a venue was left out, and
 * keeping the reason out of here makes that true by construction.
 *
 * @param {{setupMinutes: number, turnaroundMinutes: number}} venue
 * @param {{startsAt: string|Date, endsAt: string|Date}} request
 * @param {Array<{starts_at: string, ends_at: string}>} bookings
 * @param {Array<{starts_at: string, ends_at: string}>} blocks
 * @returns {boolean}
 */
export function isVenueFree(venue, request, bookings, blocks) {
  const { setupMinutes, turnaroundMinutes } = venue;
  const wanted = paddedPeriod(request.startsAt, request.endsAt, setupMinutes, turnaroundMinutes);

  const clashesWithBooking = bookings.some((booking) => {
    const held = paddedPeriod(booking.starts_at, booking.ends_at, setupMinutes, turnaroundMinutes);
    return overlaps(wanted.start, wanted.end, held.start, held.end);
  });
  if (clashesWithBooking) return false;

  // Raw: a block has no setup or turnaround of its own.
  return !blocks.some((block) =>
    overlaps(
      wanted.start,
      wanted.end,
      new Date(block.starts_at).getTime(),
      new Date(block.ends_at).getTime(),
    ),
  );
}
