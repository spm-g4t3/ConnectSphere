/**
 * Venue calendar service.
 *
 * SCRUM-179, the backend subtask of SCRUM-178 (View Venue Availability
 * Calendar - Venue Staff).
 *
 * One read answers the calendar for a window: a venue's bookings, its blocks
 * and (SCRUM-491) its tentative holds, merged into a single list of entries,
 * soonest first. Each entry carries a `kind` -- 'booking', 'block' or 'hold'
 * -- so the frontend can lay them on one grid without a second request or a
 * client-side join.
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
 * without anyone deciding it should be.
 *
 * SCRUM-484 (Week 7): bookings are read through venue_occupancy_conflicts()
 * (032), the one function that decides what occupies a venue (AC4), instead of
 * a PostgREST filter of our own. Its booking rows are exactly that allow-list,
 * so the calendar still shows what it showed -- but a booking is now in the
 * window when its OCCUPIED period is, padded with the venue's setup and
 * turnaround. A booking ending just before the window whose turnaround runs
 * into it now appears, because the venue really is taken then. The window
 * itself is not padded (p_pad_requested = false): it is a range of the
 * calendar, not an event. Overlap is still strict half-open, so an occupied
 * period that only touches the window's edge is not in it.
 *
 * Each booking entry carries its occupied period and the venue's minutes
 * (AC7), so the frontend can draw "Setup · Event · Turnaround" without
 * redoing the arithmetic. An entry is still placed by its event's own start:
 * the setup is part of the entry, not a separate one.
 *
 * Blocks come from listVenueBlocks unchanged in meaning: removed blocks are
 * left out, ended ones are kept. The calendar shows the past too.
 *
 * SCRUM-491 (AC6): tentative holds are the third kind, 'hold'. They come from
 * the same venue_occupancy_conflicts() call as bookings (040 added them to
 * it), so the calendar shows exactly the holds that occupy the venue: active
 * ones whose expiry has not passed. Each is placed by its event's own period,
 * padded like a booking, and names the holding event so the frontend can show
 * "Tentatively held" with the event's name. A hold past its expiry is gone
 * from the calendar at once (AC7), whether or not the expiry job has run.
 *
 * Deliberately NOT here:
 *
 *  - Display labels. The backend returns kinds, statuses and reasons; the
 *    frontend owns the wording ("Booked", "Blocked", "Booked – under review").
 *  - Whether the venue is retired. getVenueById returns retired venues, and a
 *    retired venue's past bookings are exactly what SCRUM-15 AC3 keeps
 *    viewable, so the calendar answers for it too.
 *
 * Imports both venueService.js and venueBlockService.js. That is not circular:
 * neither imports this module, and venueBlockService imports neither.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError } from '../errors.js';
import { validateVenueId } from '../validation/venueValidation.js';
import { validateBlockWindow } from '../validation/venueBlockValidation.js';
import { getVenueById } from './venueService.js';
import { listVenueBlocks } from './venueBlockService.js';

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
 * A booking row from venue_occupancy_conflicts() as a calendar entry.
 *
 * The function returns the event's name flat, joined in SQL, so there is no
 * PostgREST embed to unwrap. A missing name is still null, not an error -- the
 * booking occupies the venue either way.
 *
 * SCRUM-484 (AC7): occupiedStartsAt/occupiedEndsAt are the booking's period
 * padded with the venue's setup and turnaround, and setupMinutes and
 * turnaroundMinutes the minutes that padded it. Passed through as the
 * database computed them, never recomputed here.
 *
 * @param {object} row  snake_case, a kind = 'booking' row
 * @returns {{kind: 'booking', id: string, startsAt: string, endsAt: string,
 *            status: string, eventRequestId: string, eventName: string|null,
 *            occupiedStartsAt: string, occupiedEndsAt: string,
 *            setupMinutes: number, turnaroundMinutes: number}}
 */
export function toBookingEntry(row) {
  return {
    kind: 'booking',
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    eventRequestId: row.event_request_id,
    eventName: row.event_name ?? null,
    occupiedStartsAt: row.occupied_starts_at,
    occupiedEndsAt: row.occupied_ends_at,
    setupMinutes: row.setup_minutes,
    turnaroundMinutes: row.turnaround_minutes,
  };
}

/**
 * A hold row from venue_occupancy_conflicts() as a calendar entry (SCRUM-491,
 * AC6).
 *
 * startsAt and endsAt are the holding event's own period, and the occupied
 * fields that period padded with the venue's minutes, as for a booking. The
 * holding event's name comes flat from the function; a missing one is null,
 * not an error -- the hold occupies the venue either way.
 *
 * @param {object} row  snake_case, a kind = 'hold' row
 * @returns {{kind: 'hold', id: string, startsAt: string, endsAt: string,
 *            eventRequestId: string, eventName: string|null,
 *            occupiedStartsAt: string, occupiedEndsAt: string,
 *            setupMinutes: number, turnaroundMinutes: number}}
 */
export function toHoldEntry(row) {
  return {
    kind: 'hold',
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    eventRequestId: row.event_request_id,
    eventName: row.event_name ?? null,
    occupiedStartsAt: row.occupied_starts_at,
    occupiedEndsAt: row.occupied_ends_at,
    setupMinutes: row.setup_minutes,
    turnaroundMinutes: row.turnaround_minutes,
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

  const [occupying, blocks] = await Promise.all([
    readOccupying(venueId, window),
    listVenueBlocks(venueId, window),
  ]);

  return [
    ...occupying.filter((row) => row.kind === 'booking').map(toBookingEntry),
    ...occupying.filter((row) => row.kind === 'hold').map(toHoldEntry),
    ...blocks.map(toBlockEntry),
  ].sort(compareEntries);
}

/**
 * The venue's occupying bookings and active holds (SCRUM-491) whose occupied
 * period overlaps the window, as raw rows.
 *
 * Through venue_occupancy_conflicts() (032), so the calendar and every
 * availability check share one rule (AC4). p_pad_requested is false because
 * the window is not an event and has no setup or turnaround of its own; each
 * booking is still padded with the venue's minutes.
 *
 * Only kind = 'booking' and kind = 'hold' rows are kept. The function returns
 * blocks too, but the calendar reads blocks through listVenueBlocks: that
 * keeps their notes, which the shared function does not return, and keeps
 * ended blocks visible exactly as before. Order is left to getVenueCalendar's
 * sort. No event is excluded: the calendar shows every hold (the fifth
 * argument, 040, keeps its default).
 */
async function readOccupying(venueId, window) {
  const { data, error } = await supabase.rpc('venue_occupancy_conflicts', {
    p_venue_id: venueId,
    p_starts_at: window.from,
    p_ends_at: window.to,
    p_pad_requested: false,
  });

  if (error) throw translateError(error);

  return (data ?? []).filter((row) => row.kind === 'booking' || row.kind === 'hold');
}
