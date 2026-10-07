/**
 * Venue occupancy reads.
 *
 * SCRUM-139, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * findOccupancies reads, for a set of venues, the bookings and active blocks
 * that could clash with a requested period, and hands them back grouped by
 * venue. It decides nothing: domain/venueOccupancy.js's isVenueFree is the
 * rule, and findVenuesForEvent applies it.
 *
 * The query narrows, the pure rule decides. Once setup and turnaround are
 * added (Week 7), a booking can clash with a request without touching the
 * request's own period -- a booking ending 12:00 with 45 minutes' turnaround
 * clashes with a request starting 13:14 after its 30 minutes' setup. Each
 * venue has its own minutes, and pushing that into PostgREST would mean a
 * per-venue filter the query language cannot express. So the read is widened
 * on both sides by MAX_BUFFER_MINUTES, the largest setup plus the largest
 * turnaround any venue can have: a superset of every possible clash for every
 * venue. isVenueFree then applies each venue's exact minutes in JavaScript,
 * where every boundary can be tested without a database (CI has none). The
 * extra rows the wider read returns are discarded there, never trusted.
 *
 * Both reads use the strict half-open overlap -- lt on starts_at, gt on
 * ends_at -- the same rule venue_blocks_no_overlap (011), the calendar and
 * findBlockedVenueIds use.
 *
 * Does not import venueService.js, which imports this module; the reverse
 * import would be circular. findBlockedVenueIds is left as it is: it answers
 * searchVenues' narrower question, unpadded, and returns ids only.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError } from '../errors.js';
import { MAX_BUFFER_MINUTES, OCCUPYING_BOOKING_STATUSES } from '../domain/venueOccupancy.js';

const MS_PER_MINUTE = 60 * 1000;

/** The columns isVenueFree reads, plus the venue to group by. */
const OCCUPANCY_COLUMNS = 'venue_id, starts_at, ends_at';

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Local, as every service's is, and the same shape as the calendar's. This
 * module only reads, and its inputs come from findVenuesForEvent after
 * validation, so a 22P02 means a value slipped past that -- still the caller's
 * input rather than a server fault.
 */
function translateError(error) {
  if (error.code === '22P02') {
    return new ValidationError(`A value was rejected by the database: ${error.message ?? ''}`);
  }
  return new Error(error.message || 'Unexpected database error');
}

/**
 * The bookings and active blocks that could clash with a period, per venue.
 *
 * @param {string[]} venueIds
 * @param {string|Date} startsAt  ISO 8601 with an offset, or a Date
 * @param {string|Date} endsAt
 * @returns {Promise<Map<string, {bookings: object[], blocks: object[]}>>}
 *   every requested id is a key, with empty arrays when nothing is near it;
 *   rows are { venue_id, starts_at, ends_at }. An empty id list answers an
 *   empty Map without a query.
 */
export async function findOccupancies(venueIds, startsAt, endsAt) {
  const occupancies = new Map();
  if (venueIds.length === 0) return occupancies;

  for (const id of venueIds) occupancies.set(id, { bookings: [], blocks: [] });

  const bufferMs = MAX_BUFFER_MINUTES * MS_PER_MINUTE;
  const from = new Date(new Date(startsAt).getTime() - bufferMs).toISOString();
  const to = new Date(new Date(endsAt).getTime() + bufferMs).toISOString();

  const [bookings, blocks] = await Promise.all([
    supabase
      .from('bookings')
      .select(OCCUPANCY_COLUMNS)
      .in('venue_id', venueIds)
      .in('status', OCCUPYING_BOOKING_STATUSES)
      .lt('starts_at', to)
      .gt('ends_at', from),
    supabase
      .from('venue_blocks')
      .select(OCCUPANCY_COLUMNS)
      .in('venue_id', venueIds)
      .is('removed_at', null)
      .lt('starts_at', to)
      .gt('ends_at', from),
  ]);

  if (bookings.error) throw translateError(bookings.error);
  if (blocks.error) throw translateError(blocks.error);

  // Every row's venue_id is one of venueIds -- the .in filter guarantees it --
  // so each lookup finds the entry seeded above.
  for (const row of bookings.data ?? []) occupancies.get(row.venue_id).bookings.push(row);
  for (const row of blocks.data ?? []) occupancies.get(row.venue_id).blocks.push(row);

  return occupancies;
}
