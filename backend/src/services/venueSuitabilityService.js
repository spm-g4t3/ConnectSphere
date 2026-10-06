/**
 * Venue suitability checking (N10, SCRUM-188).
 *
 * SCRUM-252 needs a suitability result to attach to a booking request, and to
 * decide whether the coordinator must confirm before submitting. N10 is not
 * built: SCRUM-189 (extract SCRUM-20's matching rules into a shared service)
 * and SCRUM-190 (the check endpoint) are still To Do, and nothing in this
 * repository computes suitability. This module is the one place that gap is
 * recorded.
 *
 * Until N10 lands the check fails closed. It refuses with a 503 rather than
 * answering "suitable" or inventing a result from the few criteria the venue
 * search happens to know, because a made-up pass would put an unchecked venue
 * in front of Venue Staff as a checked one. The booking request endpoint
 * therefore cannot submit in production until this function is replaced.
 *
 * The contract the booking request service relies on, for N10 to meet:
 *
 *   checkVenueSuitability({ eventRequestId, venueId, roomLayoutCode, client })
 *     -> Promise<{
 *          suitable: boolean,   // true only if every criterion is met
 *          criteria: Array<{    // each criterion, met or not
 *            criterion: string, // capacity, operating hours, layout,
 *                               // accessibility, facilities, availability
 *            met: boolean,
 *            detail?: string,   // the values compared, e.g.
 *                               // "Capacity 80 < expected attendance 150"
 *          }>,
 *        }>
 *
 * It must be computed on the server from the stored event and venue, never
 * from anything the browser sends. The booking request service stores the
 * result with the request. The availability criterion is also re-checked, with
 * locks, when the request is written, so a result that was true a moment ago
 * cannot let a conflicting request through.
 *
 * Deliberately free of database calls and imports other than errors.js, so the
 * booking request tests run without credentials.
 */

import { ServiceUnavailableError } from '../errors.js';

/**
 * @param {object} _input
 * @param {string} _input.eventRequestId
 * @param {string} _input.venueId
 * @param {string|null} _input.roomLayoutCode
 * @param {object} [_input.client]
 * @returns {Promise<{suitable: boolean, criteria: object[]}>}
 * @throws {ServiceUnavailableError} always, until N10 (SCRUM-190) is built
 */
export async function checkVenueSuitability(_input) {
  throw new ServiceUnavailableError(
    'Venue suitability checking is not available yet, so a venue cannot be requested',
  );
}
