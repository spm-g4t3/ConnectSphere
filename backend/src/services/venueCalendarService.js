/**
 * Venue calendar service.
 *
 * SCRUM-179, the backend subtask of SCRUM-178 (View Venue Availability
 * Calendar - Venue Staff).
 *
 * One read answers the calendar for a window: a venue's bookings and its
 * blocks, merged into a single list of entries, soonest first. Each entry
 * carries a `kind` -- 'booking' or 'block' -- so the frontend can lay both on
 * one grid without a second request or a client-side join.
 *
 * The window is required. listVenueBlocks treats a missing window as "every
 * block", which is right for a block list but not for a calendar: a calendar
 * always shows a range, and an unbounded read of a venue's bookings is
 * exactly what BLOCK_WINDOW_MAX_DAYS exists to prevent. Beyond "both ends
 * given", the window is validateBlockWindow's -- ISO 8601 with an offset, to
 * later than from, at most 400 days -- so the calendar and /:id/blocks cannot
 * drift apart on what a valid window is. Everything is checked before any
 * network call.
 *
 * Bookings are an allow-list of statuses: approved and flagged_for_review.
 * A flagged booking still holds the venue until a Coordinator resolves it
 * (SCRUM-128), so it is shown. A "not cancelled" filter would be shorter, but
 * it would show any status added later -- a pending one, say -- as booked
 * without anyone deciding it should be. Overlap is the same strict half-open
 * test listVenueBlocks uses, so an entry that only touches the window's edge
 * is not in it.
 *
 * Blocks come from listVenueBlocks unchanged in meaning: removed blocks are
 * left out, ended ones are kept. The calendar shows the past too.
 *
 * Deliberately NOT here:
 *
 *  - Display labels. The backend returns kinds, statuses and reasons; the
 *    frontend owns the wording ("Booked", "Blocked", "Booked – under review").
 *  - Tentative holds. SCRUM-16 has not built them, so there is nothing to
 *    read; when it does, they become a third kind.
 *  - Whether the venue is retired. getVenueById returns retired venues, and a
 *    retired venue's past bookings are exactly what SCRUM-15 AC3 keeps
 *    viewable, so the calendar answers for it too.
 *
 * Imports both venueService.js and venueBlockService.js. That is not circular:
 * venueService imports venueBlockService, and neither imports this module.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError } from '../errors.js';
import { validateVenueId } from '../validation/venueValidation.js';
import { validateBlockWindow } from '../validation/venueBlockValidation.js';
import { BOOKING_STATUS } from '../domain/bookingStatus.js';
import { getVenueById } from './venueService.js';
import { listVenueBlocks } from './venueBlockService.js';

/**
 * The booking statuses that occupy a venue on the calendar. An allow-list, so
 * a status added later is hidden until someone decides it belongs here.
 */
const CALENDAR_BOOKING_STATUSES = [BOOKING_STATUS.APPROVED, BOOKING_STATUS.FLAGGED_FOR_REVIEW];

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Local, as every service's is. This module only reads, and the inputs a read
 * could trip over -- the venue id and the window -- are validated before the
 * query, so a 22P02 here means a value slipped past that, and it is still the
 * caller's input rather than a server fault.
 */
function translateError(error) {
  if (error.code === '22P02') {
    return new ValidationError(`A value was rejected by the database: ${error.message ?? ''}`);
  }
  return new Error(error.message || 'Unexpected database error');
}

/** Is this window end missing, as checkTimeWindow decides it? */
function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * The calendar window, which unlike a block list's is required.
 *
 * The required check runs first because validateBlockWindow answers "neither
 * given" with null rather than an error, and only reports a missing end when
 * the other is present. Both missing ends are reported together, in the
 * {field, message} details every ValidationError carries.
 *
 * @returns {{from: string, to: string}}
 * @throws {ValidationError}
 */
function validateCalendarWindow({ from, to }) {
  const details = [];
  if (isMissing(from)) details.push({ field: 'from', message: 'is required' });
  if (isMissing(to)) details.push({ field: 'to', message: 'is required' });

  if (details.length > 0) {
    const summary = details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid calendar window -- ${summary}`, details);
  }

  return validateBlockWindow({ from, to });
}

/**
 * A bookings row, with its event request's name, as a calendar entry.
 *
 * eventName is read defensively: bookings.event_request_id is a many-to-one
 * reference, so PostgREST embeds event_requests as an object, but some
 * client and schema-cache setups return a one-element array instead. Either
 * way a missing name is null, not an error -- the booking still occupies the
 * venue.
 *
 * @param {object} row  snake_case, from PostgREST
 * @returns {{kind: 'booking', id: string, startsAt: string, endsAt: string,
 *            status: string, eventRequestId: string, eventName: string|null}}
 */
export function toBookingEntry(row) {
  const request = Array.isArray(row.event_requests) ? row.event_requests[0] : row.event_requests;
  return {
    kind: 'booking',
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    eventRequestId: row.event_request_id,
    eventName: request?.event_name ?? null,
  };
}

/**
 * A block, as listVenueBlocks returns it, as a calendar entry.
 *
 * Takes the camelCase block, not a row, so the calendar never reads
 * venue_blocks itself. Who created or removed it is left out: the calendar
 * shows that the venue is blocked and why, not the audit trail.
 *
 * @param {object} block  shaped by toBlock
 * @returns {{kind: 'block', id: string, startsAt: string, endsAt: string,
 *            reason: string, notes: string|null}}
 */
export function toBlockEntry(block) {
  return {
    kind: 'block',
    id: block.id,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    reason: block.reason,
    notes: block.notes,
  };
}

/**
 * Soonest first, then by id so equal starts keep a stable order. Compared as
 * instants: '10:00+08:00' is earlier than '03:00Z', which string order gets
 * wrong.
 */
function compareEntries(a, b) {
  const byStart = Date.parse(a.startsAt) - Date.parse(b.startsAt);
  if (byStart !== 0) return byStart;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * A venue's calendar for a window: its bookings and blocks, merged.
 *
 * @param {string} venueId
 * @param {object} [window]       required, both ends
 * @param {string} [window.from]  ISO 8601 with an offset
 * @param {string} [window.to]    ISO 8601 with an offset; later than from, and
 *                                within BLOCK_WINDOW_MAX_DAYS of it
 * @returns {Promise<object[]>} a bare array of entries shaped by
 *          toBookingEntry and toBlockEntry, soonest first; [] when nothing
 *          overlaps the window
 * @throws {ValidationError} a malformed id, or a missing, one-sided,
 *                           malformed, reversed or over-long window, before any
 *                           network call
 * @throws {NotFoundError}   no venue with that id
 */
export async function getVenueCalendar(venueId, { from, to } = {}) {
  validateVenueId(venueId);
  const window = validateCalendarWindow({ from, to });

  // First, and on its own: listVenueBlocks answers [] for an unknown venue,
  // and so would the bookings read, so without this an unknown venue would
  // look like a free one.
  await getVenueById(venueId);

  const [bookings, blocks] = await Promise.all([
    readBookings(venueId, window),
    listVenueBlocks(venueId, window),
  ]);

  return [...bookings.map(toBookingEntry), ...blocks.map(toBlockEntry)].sort(compareEntries);
}

/**
 * The venue's calendar bookings overlapping the window, as raw rows.
 *
 * Strict lt/gt, the same half-open overlap listVenueBlocks uses.
 */
async function readBookings(venueId, window) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, event_request_id, starts_at, ends_at, status, event_requests(event_name)')
    .eq('venue_id', venueId)
    .in('status', CALENDAR_BOOKING_STATUSES)
    .lt('starts_at', window.to)
    .gt('ends_at', window.from)
    .order('starts_at')
    .order('id');

  if (error) throw translateError(error);

  return data ?? [];
}
