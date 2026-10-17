/**
 * Venue suitability checking (N10, SCRUM-188).
 *
 * SCRUM-190, a subtask of SCRUM-188 (Check Venue Suitability for an Event):
 * judge one venue against one event, criterion by criterion, and say for
 * each whether it is met and what was compared (AC2). Until this subtask the
 * function here was a placeholder that always refused with a 503, so a
 * booking request (SCRUM-252) could never be submitted in production.
 *
 * Six criteria, in SUITABILITY_CHECK_CRITERIA's order: the five attribute
 * criteria SCRUM-189 extracted from the venue search (capacity, operating
 * hours, layout, accessibility, facilities), then Availability.
 *
 * Why the attributes are JavaScript and availability is SQL. The attribute
 * rules are domain/venueMatching.js's evaluateCriteria, built from the same
 * predicates the search filters with, so a venue this check calls suitable is
 * one the search would return for the same request. Whether the venue is
 * free is venue_occupancy_conflicts() (032, holds added by 040), the one
 * definition the search (available_venue_ids), the block writers and
 * create_booking_request already share. The period rule has to live in SQL
 * because the writers enforce it inside their transactions; repeating it here
 * in JavaScript would be a second copy that could drift (SCRUM-484 AC4).
 *
 * Week 7, honoured through that one function:
 *  - Availability is judged on the occupied period: the event padded with
 *    the venue's setup before and turnaround after (p_pad_requested: true).
 *    Each conflict carries its own occupied period and the minutes, and the
 *    detail names which part of it is setup and which turnaround.
 *  - Another event's active, unexpired hold (SCRUM-491) makes the venue
 *    unavailable, and the detail gives the held period.
 *  - The event's own holds do not count against it (p_exclude_hold_event_id),
 *    and nor do its own bookings: an approved booking of this event at this
 *    venue must not make its own venue "unavailable" when SCRUM-192 checks it
 *    again. Those rows are dropped here, because the function has no
 *    parameter for them.
 *  - A venue block is never padded (SCRUM-484 AC6); it is described by its
 *    own period.
 *
 * Computed from stored data. The event's period is read from the stored
 * event, and the venue's attributes, hours and minutes from the stored venue.
 * The coordinator supplies the requirement codes -- layout, accessibility and
 * facilities -- because the event records its requirements as free text and
 * there is nothing stored to judge against.
 *
 * SCRUM-525: the coordinator may also supply the expected attendance, since
 * one event can now use several venues and each takes its own share. When
 * given it is the number Capacity is judged on; otherwise it is the event's.
 * The period is never the caller's: every booking of an event uses the
 * event's. All of these are echoed in the result's `checked`, so Venue Staff
 * reading the stored result see exactly what was assessed.
 *
 * The contract the booking request service relies on:
 *
 *   checkVenueSuitability({ eventRequestId, venueId, roomLayoutCode,
 *                           accessibility, facilities, expectedAttendance,
 *                           userId, client })
 *     -> Promise<{
 *          suitable: boolean,   // true only if every criterion is met
 *          criteria: Array<{ criterion, met, detail, conflicts? }>,
 *          checked: { startsAt, endsAt, expectedAttendance, layout,
 *                     accessibility, facilities },
 *        }>
 *
 * SCRUM-192 adds checkEventVenues(eventRequestId, { userId, client }): the
 * same check run again, live, for every venue the event has requested or
 * booked (SCRUM-188 AC6, Week 7). See that function for why it is computed on
 * view rather than stored.
 *
 * The answer can go stale the moment it is given. create_booking_request
 * checks the period again under its locks, so a result that was true a moment
 * ago cannot let a conflicting request through.
 *
 * Imports: venueService.js is loaded lazily, inside the check, because it
 * imports the Supabase client statically and that throws at import time with
 * no .env. bookingRequestService.js imports this module, and its tests and
 * every router built on it run without credentials, so a static import here
 * would take them all down at collection time. Nothing is imported from
 * bookingRequestService.js either: it imports this module, so its
 * toPeriodConflict cannot be borrowed without a circular import, and the
 * occupancy rows are mapped locally by toOccupancyConflict.
 */

import { AppError, ConflictError, ForbiddenError, ValidationError } from '../errors.js';
import {
  AVAILABILITY_CRITERION,
  SUITABILITY_CHECK_CRITERIA,
  evaluateCriteria,
  toVenueLocal,
} from '../domain/venueMatching.js';
import { BOOKING_STATUS, getBookingStatusDisplay } from '../domain/bookingStatus.js';
import { getEventRequestForCoordinator } from './eventRequestService.js';

/**
 * SCRUM-188 AC2: the sixth criterion's label, and every criterion the check
 * reports, in the order it reports them. SUITABILITY_CRITERIA stays the five
 * attribute labels, frozen, because evaluateCriteria destructures it.
 * SCRUM-193/194 moved both constants into domain/venueMatching.js, so the
 * booking request's validation can name the criteria without importing a
 * service; they are re-exported here, beside the SQL that judges
 * Availability, so every existing import keeps working.
 */
export { AVAILABILITY_CRITERION, SUITABILITY_CHECK_CRITERIA };

async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/**
 * One row of venue_occupancy_conflicts(), in camelCase.
 *
 * The same idea as bookingRequestService's toPeriodConflict, kept separate
 * because that module imports this one (see the header). occupiedStartsAt and
 * occupiedEndsAt are read from the row, never recomputed, so the padding
 * formula stays in SQL. For a booking or a hold they are its period padded by
 * the venue's setup and turnaround; for a block they equal its own period,
 * since a block is never padded, and setupMinutes/turnaroundMinutes are the
 * venue's minutes as 040 returns them on every row.
 *
 * @param {object} row  kind 'booking' | 'block' | 'hold', snake_case
 * @returns {{kind: string, id: string, eventName: string|null, reason: string|null,
 *   startsAt: string, endsAt: string, occupiedStartsAt: string, occupiedEndsAt: string,
 *   setupMinutes: number, turnaroundMinutes: number}}
 */
export function toOccupancyConflict(row) {
  return {
    kind: row.kind,
    id: row.id,
    eventName: row.event_name ?? null,
    reason: row.reason ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    occupiedStartsAt: row.occupied_starts_at,
    occupiedEndsAt: row.occupied_ends_at,
    setupMinutes: row.setup_minutes,
    turnaroundMinutes: row.turnaround_minutes,
  };
}

const DAY_ABBREVIATIONS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTH_ABBREVIATIONS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

/** A venue-local reading as 'HH:MM'; seconds dropped, as venueMatching does. */
function clockOf(local) {
  const whole = Math.floor(local.minutes);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** A venue-local reading as 'Wed 11 Nov'. */
function dayOf(local) {
  const [, month, day] = local.date.split('-').map(Number);
  return `${DAY_ABBREVIATIONS[local.dayOfWeek]} ${day} ${MONTH_ABBREVIATIONS[month - 1]}`;
}

/**
 * A period on the venue's (Singapore) clock: '09:30–12:45 on Wed 11 Nov', or,
 * when it crosses midnight, 'Wed 11 Nov 23:00 – Thu 12 Nov 01:00', since the
 * two times alone would read as a period running backwards.
 */
function formatPeriod(startsAt, endsAt) {
  const start = toVenueLocal(startsAt);
  const end = toVenueLocal(endsAt);
  if (start.date === end.date) return `${clockOf(start)}–${clockOf(end)} on ${dayOf(start)}`;
  return `${dayOf(start)} ${clockOf(start)} – ${dayOf(end)} ${clockOf(end)}`;
}

/** Two instants as 'HH:MM–HH:MM' on the venue's clock. */
function formatClockRange(startsAt, endsAt) {
  return `${clockOf(toVenueLocal(startsAt))}–${clockOf(toVenueLocal(endsAt))}`;
}

/**
 * A padded conflict's setup and turnaround, as the clock times each covers:
 * ' (setup 09:30–10:00, turnaround 12:00–12:45)'. A part of zero minutes
 * covers nothing and is left out; with neither there is nothing to add.
 */
function describePadding(conflict) {
  const parts = [];
  if (conflict.setupMinutes > 0) {
    parts.push(`setup ${formatClockRange(conflict.occupiedStartsAt, conflict.startsAt)}`);
  }
  if (conflict.turnaroundMinutes > 0) {
    parts.push(`turnaround ${formatClockRange(conflict.endsAt, conflict.occupiedEndsAt)}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * A period as 'Wed 11 Nov 10:00–12:00', or 'Wed 11 Nov 23:00 – Thu 12 Nov
 * 01:00' across midnight: the day first, for the stale-booking sentence
 * (SCRUM-193/194, B2), where two periods are read side by side.
 */
function formatDayPeriod(startsAt, endsAt) {
  const start = toVenueLocal(startsAt);
  const end = toVenueLocal(endsAt);
  if (start.date === end.date) return `${dayOf(start)} ${clockOf(start)}–${clockOf(end)}`;
  return `${dayOf(start)} ${clockOf(start)} – ${dayOf(end)} ${clockOf(end)}`;
}

/** An instant moved by a number of minutes, for the display of the padding. */
function shiftMinutes(instant, minutes) {
  return new Date(new Date(instant).getTime() + minutes * 60_000);
}

/**
 * The event's own occupied period and its parts, for an unmet Availability
 * (SCRUM-193/194, B4, Week 7 WK7-1): 'Needs 13:45–16:45 on Wed 11 Nov (setup
 * 13:45–14:15, turnaround 16:00–16:45)'. A part of zero minutes is left out.
 * Display only, like the "Free" line: venue_occupancy_conflicts() padded the
 * same period with the same minutes when it decided.
 */
function describeNeeds(event, venue) {
  const setup = venue.setupMinutes ?? 0;
  const turnaround = venue.turnaroundMinutes ?? 0;
  const occupiedStart = shiftMinutes(event.proposedStart, -setup);
  const occupiedEnd = shiftMinutes(event.proposedEnd, turnaround);

  const parts = [];
  if (setup > 0) parts.push(`setup ${formatClockRange(occupiedStart, event.proposedStart)}`);
  if (turnaround > 0) parts.push(`turnaround ${formatClockRange(event.proposedEnd, occupiedEnd)}`);
  const padding = parts.length > 0 ? ` (${parts.join(', ')})` : '';

  return `Needs ${formatPeriod(occupiedStart, occupiedEnd)}${padding}`;
}

/**
 * Whether a booking's own period still matches the event's (SCRUM-193/194,
 * B2). Compared as instants, so '+08:00' and 'Z' forms of one time agree.
 */
function bookingPeriodMoved(bookingPeriod, event) {
  if (!bookingPeriod) return false;
  return (
    new Date(bookingPeriod.startsAt).getTime() !== new Date(event.proposedStart).getTime() ||
    new Date(bookingPeriod.endsAt).getTime() !== new Date(event.proposedEnd).getTime()
  );
}

/** One conflict in words; see describeAvailability. */
function describeConflict(conflict) {
  if (conflict.kind === 'block') {
    // Unpadded (SCRUM-484 AC6): the block's own period, which is also its
    // occupied one. 'internal_activity' reads as 'internal activity'.
    const reason = conflict.reason ? ` (${conflict.reason.replaceAll('_', ' ')})` : '';
    return `Blocked${reason} ${formatPeriod(conflict.startsAt, conflict.endsAt)}`;
  }

  const verb = conflict.kind === 'hold' ? 'Held' : 'Booked';
  const name = conflict.eventName ?? 'another event';
  return (
    `${verb} for ${name} ${formatPeriod(conflict.occupiedStartsAt, conflict.occupiedEndsAt)}` +
    describePadding(conflict)
  );
}

/**
 * The Availability criterion's detail (SCRUM-188 AC2, Week 7).
 *
 * Free: the event's occupied period, and the setup and turnaround it
 * includes -- 'Free 09:30–12:45 on Wed 11 Nov (incl. 30 min setup, 45 min
 * turnaround)'. The padding is added here for display only; whether the venue
 * is free was decided by venue_occupancy_conflicts(), which padded the same
 * period with the same minutes.
 *
 * Not free: the event's own occupied period and its parts (SCRUM-193/194,
 * B4), then one phrase per conflict, joined with '; ', each with the period
 * it occupies --
 *   'Needs 13:45–16:45 on Wed 11 Nov (setup 13:45–14:15, turnaround
 *    16:00–16:45). ' followed by
 *   booking  'Booked for Gala Night 09:30–12:45 on Wed 11 Nov
 *            (setup 09:30–10:00, turnaround 12:00–12:45)'
 *   hold     'Held for Gala Night …' the same way (SCRUM-491)
 *   block    'Blocked (maintenance) 10:00–14:00 on Wed 11 Nov', unpadded
 *
 * A booking whose own period no longer matches the event's (SCRUM-193/194,
 * B2; options.bookingPeriod) opens with 'Booking covers Wed 11 Nov
 * 10:00–12:00; the event is now Thu 12 Nov 10:00–12:00', followed by '. ' and
 * the conflicts text above when there are any.
 *
 * Every time is on the venue's Singapore clock (toVenueLocal), the clock its
 * opening hours are written in, whatever zone the server runs in.
 *
 * @param {object[]} conflicts  toOccupancyConflict's shape, already narrowed
 *                              to what counts against the event
 * @param {{proposedStart: string, proposedEnd: string}} event
 * @param {{setupMinutes: number, turnaroundMinutes: number}} venue
 * @param {object} [options]
 * @param {{startsAt: string, endsAt: string}|null} [options.bookingPeriod]
 *   the booking's own stored period, when rechecking a booking
 * @returns {string}
 */
export function describeAvailability(conflicts, event, venue, { bookingPeriod = null } = {}) {
  const sentences = [];
  if (bookingPeriodMoved(bookingPeriod, event)) {
    sentences.push(
      `Booking covers ${formatDayPeriod(bookingPeriod.startsAt, bookingPeriod.endsAt)}; ` +
        `the event is now ${formatDayPeriod(event.proposedStart, event.proposedEnd)}`,
    );
  }
  if (conflicts.length > 0) {
    sentences.push(`${describeNeeds(event, venue)}. ${conflicts.map(describeConflict).join('; ')}`);
  }
  if (sentences.length > 0) return sentences.join('. ');

  const setup = venue.setupMinutes ?? 0;
  const turnaround = venue.turnaroundMinutes ?? 0;
  const occupiedStart = shiftMinutes(event.proposedStart, -setup);
  const occupiedEnd = shiftMinutes(event.proposedEnd, turnaround);

  const parts = [];
  if (setup > 0) parts.push(`${setup} min setup`);
  if (turnaround > 0) parts.push(`${turnaround} min turnaround`);
  const padding = parts.length > 0 ? ` (incl. ${parts.join(', ')})` : '';

  return `Free ${formatPeriod(occupiedStart, occupiedEnd)}${padding}`;
}

/** A code list as the check uses it: [] when none, never undefined or null. */
function asList(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Judge one venue against one event (SCRUM-188 AC1, AC2; SCRUM-190).
 *
 * Steps, each refusing before the next runs:
 *  1. The event, read for a coordinator: an unknown event, or a draft, is a
 *     NotFoundError (getEventRequestForCoordinator).
 *  2. When userId is given, the caller must be the event's assigned
 *     coordinator. The endpoint always gives it; so does the booking request.
 *  3. The event must have both ends of its period (EVENT_DATES_MISSING, the
 *     code create_booking_request uses), or there is nothing to judge. There
 *     must also be an expected attendance -- the caller's, else the event's
 *     -- or Capacity would be judged against nothing (EVENT_ATTENDANCE_MISSING,
 *     SCRUM-193/194 B1; judgeVenue enforces it).
 *  4. The requirement codes must exist (400, assertKnownCodes), so a typo
 *     reads as the request's fault rather than as the venue "missing" it.
 *  5. The venue, with its attributes: unknown is a NotFoundError, and a
 *     retired one is VENUE_RETIRED, because the AC only covers active venues.
 *  6. The five attribute criteria (evaluateCriteria), then Availability
 *     (venue_occupancy_conflicts()).
 *
 * Capacity is judged against the expected attendance given for this venue,
 * or the event's when none is given (SCRUM-525, completing the SCRUM-188
 * roadmap's Week 7 note: each booking has an attendance of its own). The
 * number judged is echoed as checked.expectedAttendance.
 *
 * A venue that is not suitable is an answer, not an error: suitable false,
 * with the criteria saying why.
 *
 * @param {object} input
 * @param {string} input.eventRequestId
 * @param {string} input.venueId
 * @param {string|null} [input.roomLayoutCode]  null or absent: no layout asked for
 * @param {string[]} [input.accessibility]      absent: none asked for
 * @param {string[]} [input.facilities]         absent: none asked for
 * @param {number} [input.expectedAttendance]   SCRUM-525: the attendance for
 *                                              this venue; absent or null: the
 *                                              event's
 * @param {string} [input.userId]               the caller, from the JWT
 * @param {object} [input.client]               a Supabase client
 * @returns {Promise<{suitable: boolean, criteria: object[], checked: object}>}
 * @throws {NotFoundError}   no such event (or a draft), or no such venue
 * @throws {ForbiddenError}  userId is not the event's assigned coordinator
 * @throws {ValidationError} a requirement code that does not exist
 * @throws {ConflictError}   EVENT_DATES_MISSING, EVENT_ATTENDANCE_MISSING or
 *                           VENUE_RETIRED
 * @throws {Error}           the availability read failed
 */
export async function checkVenueSuitability({
  eventRequestId,
  venueId,
  roomLayoutCode = null,
  accessibility,
  facilities,
  expectedAttendance,
  userId,
  client,
} = {}) {
  const db = await resolveClient(client);

  const event = await getEventRequestForCoordinator(eventRequestId, { client: db });
  assertCheckable(event, userId);

  return judgeVenue(
    event,
    {
      venueId,
      roomLayoutCode,
      accessibility,
      facilities,
      expectedAttendance: expectedAttendance ?? event.expectedAttendance ?? null,
    },
    db,
  );
}

/**
 * Steps 2 and 3 of checkVenueSuitability, shared with checkEventVenues: the
 * caller must be the event's assigned coordinator (when userId is given), and
 * the event must have both ends of its period, or there is nothing to judge.
 *
 * SCRUM-525: the attendance is no longer checked here. It belongs to each
 * venue now (a booking's own, else the event's), so an event with none can
 * still be judged for a venue that has one; judgeVenue checks the number it is
 * actually given.
 */
function assertCheckable(event, userId) {
  if (userId !== undefined && userId !== null && event.assignedCoordinatorId !== userId) {
    throw new ForbiddenError(
      `Only the coordinator assigned to event request ${event.id} can check a venue for it.`,
    );
  }

  if (!event.proposedStart || !event.proposedEnd) {
    throw new ConflictError(
      'This event has no start or end yet, so no venue can be checked against it',
      { code: 'EVENT_DATES_MISSING' },
    );
  }
}

/**
 * Steps 4 to 6 of checkVenueSuitability: judge one venue against an event
 * already read and already cleared by assertCheckable.
 *
 * SCRUM-192: private, so the one-venue check and checkEventVenues share every
 * rule without the event being read again for each booking. Both entry points
 * call this and nothing else judges, so there is no second copy to drift.
 *
 * SCRUM-193/194 (B2): bookingPeriod, given only by checkEventVenues, is the
 * booking's own stored period. When it no longer matches the event's, the
 * booking does not cover the event as it now stands, so Availability is not
 * met whatever the occupancy says, and its detail says so.
 *
 * SCRUM-525: expectedAttendance is the number Capacity is judged on, already
 * resolved by the caller -- the request's or booking's own, else the event's.
 *
 * SCRUM-193/194 (B1, AC3), moved here from assertCheckable by SCRUM-525:
 * without an attendance, meetsCapacity compares the capacity with null, which
 * JavaScript reads as 0, so every venue "met" Capacity -- a pass the search
 * (which requires an attendance) would never give. Refused like a missing date
 * instead. Checked here because this is where the number is used, so neither
 * entry point can reach Capacity without one; and first, so nothing is read
 * for a venue that cannot be judged.
 *
 * @param {object} event  the stored event, in camelCase
 * @param {{venueId: string, roomLayoutCode?: string|null, accessibility?: string[],
 *          facilities?: string[], expectedAttendance?: number|null,
 *          bookingPeriod?: {startsAt: string, endsAt: string}|null}}
 *        requirements
 * @param {object} db     a resolved Supabase client
 * @throws {ConflictError} EVENT_ATTENDANCE_MISSING, or VENUE_RETIRED
 */
async function judgeVenue(
  event,
  {
    venueId,
    roomLayoutCode = null,
    accessibility,
    facilities,
    expectedAttendance = null,
    bookingPeriod = null,
  },
  db,
) {
  // Strictly null or undefined: 0 is a number, judged like any other (every
  // capacity holds it, so Capacity is met), never treated as missing.
  if (expectedAttendance === null || expectedAttendance === undefined) {
    throw new ConflictError(
      'There is no expected attendance for this venue or its event, so its Capacity cannot be judged',
      { code: 'EVENT_ATTENDANCE_MISSING' },
    );
  }

  const layout = roomLayoutCode ?? null;
  const requested = {
    accessibility: asList(accessibility),
    facilities: asList(facilities),
  };

  // Lazy, for the reason the header gives.
  const { getVenueById, assertKnownCodes } = await import('./venueService.js');

  // Only what was asked for: an empty list or no layout needs no lookup.
  await assertKnownCodes(
    {
      layout: layout ?? undefined,
      accessibility: requested.accessibility.length > 0 ? requested.accessibility : undefined,
      facilities: requested.facilities.length > 0 ? requested.facilities : undefined,
    },
    { client: db, label: 'Invalid suitability check' },
  );

  const venue = await getVenueById(venueId, { client: db });
  if (venue.retiredAt) {
    throw new ConflictError(`Venue ${venue.id} is retired, so it cannot host an event`, {
      code: 'VENUE_RETIRED',
    });
  }

  const attributeCriteria = evaluateCriteria(venue, {
    startsAt: event.proposedStart,
    endsAt: event.proposedEnd,
    expectedAttendance,
    layout: layout ?? undefined,
    accessibility: requested.accessibility,
    facilities: requested.facilities,
  });

  const { data, error } = await db.rpc('venue_occupancy_conflicts', {
    p_venue_id: venue.id,
    p_starts_at: event.proposedStart,
    p_ends_at: event.proposedEnd,
    p_pad_requested: true,
    p_exclude_hold_event_id: event.id,
  });
  if (error) throw new Error(error.message || 'The venue availability check failed');

  // The event's own holds were excluded by the function; its own bookings are
  // dropped here (see the header).
  const conflicts = (data ?? [])
    .filter((row) => !(row.kind === 'booking' && row.event_request_id === event.id))
    .map(toOccupancyConflict);

  const availability = {
    criterion: AVAILABILITY_CRITERION,
    met: conflicts.length === 0 && !bookingPeriodMoved(bookingPeriod, event),
    detail: describeAvailability(conflicts, event, venue, { bookingPeriod }),
    conflicts,
  };

  const criteria = [...attributeCriteria, availability];

  return {
    suitable: criteria.every((criterion) => criterion.met),
    criteria,
    checked: {
      startsAt: event.proposedStart,
      endsAt: event.proposedEnd,
      expectedAttendance,
      layout,
      accessibility: requested.accessibility,
      facilities: requested.facilities,
    },
  };
}


/**
 * The booking statuses that still hold, or may yet hold, a venue for the
 * event: a request awaiting Venue Staff (pending or conflicting), an approved
 * booking, and one a venue change has flagged. Rejected, withdrawn and
 * cancelled ones no longer claim the venue, so there is nothing to recheck.
 */
export const LIVE_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.CONFLICTING,
  BOOKING_STATUS.APPROVED,
  BOOKING_STATUS.FLAGGED_FOR_REVIEW,
]);

/** What checkEventVenues reads of each booking, with its venue embedded. */
const EVENT_BOOKING_COLUMNS =
  'id, venue_id, status, starts_at, ends_at, room_layout_code, expected_attendance, ' +
  'suitability_result, suitability_overridden, created_at, venues(name, location)';

/**
 * PostgREST embeds a many-to-one as an object, but an array if it were ever
 * read as one-to-many. Read defensively, as bookingRequestService does.
 */
function one(embedded) {
  return Array.isArray(embedded) ? embedded[0] : embedded;
}

/** The names of the criteria a result did not meet, in the order it gave them. */
function unmetOf(criteria) {
  return asList(criteria)
    .filter((criterion) => criterion && criterion.met === false)
    .map((criterion) => criterion.criterion);
}

/**
 * The verdict stored when the booking was requested, as { suitable, unmet },
 * or null for a row that stored none (requests before SCRUM-190, or a
 * malformed value), so the screen can tell "never judged" from "was fine".
 */
function atRequestOf(stored) {
  if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.criteria)) return null;
  return {
    suitable: stored.suitable === true,
    unmet: unmetOf(stored.criteria),
  };
}

/**
 * Recheck every venue the event has requested or booked (SCRUM-188 AC6,
 * Week 7; SCRUM-192).
 *
 * Why this is computed on view and not stored. AC6 asks that a change to the
 * event's date, time or attendance, or to the venue's details, recheck the
 * venue and show any failure on the event; Week 7 adds a change to the venue's
 * setup or turnaround time. Those changes arrive by four unrelated paths: the
 * draft PATCH, a clarification amendment, process_change_request, and
 * update_venue. None shares a hook with the others, so a stored recheck would
 * need a trigger on each and could still miss one. Judging live, whenever the
 * event is viewed, covers every path at once, and the answer can never be
 * stale. The stored suitability_result is left alone as the request-time
 * record, and is reported beside the live answer as atRequest.
 *
 * Each booking is judged by judgeVenue -- the same rules as the one-venue
 * check -- with:
 *  - the event's current period, so a moved date is what gets judged,
 *    whatever the booking was made against;
 *  - the booking's own expected attendance (SCRUM-525, 051), or the event's
 *    current one when the booking has none (a row older than 051 on an event
 *    that had no attendance then). A booking's own number wins (R15), so a
 *    change to the event's attendance re-judges only bookings without one;
 *    changing a booking's number is SCRUM-395's;
 *  - the booking's own room layout;
 *  - the accessibility and facility codes the coordinator chose when
 *    requesting, read from suitability_result.checked. Rows stored before
 *    SCRUM-190 have no checked, and fall back to none asked for.
 * The check already drops the event's own bookings from availability, so a
 * booking never conflicts with itself.
 *
 * newlyUnmet names the criteria unmet now that were met at request time, so
 * the screen can say what changed rather than repeat what the coordinator
 * already overrode. With no stored verdict, every unmet criterion is new.
 *
 * SCRUM-193/194 (B2): each booking's own period (starts_at, ends_at) is read
 * too and returned as bookingStartsAt/bookingEndsAt. create_booking_request
 * copied the event's period into the booking, and nothing moves it when the
 * event later moves, so a booking can cover a period the event no longer
 * has. Such a booking is reported with Availability not met (see judgeVenue)
 * and so counts in newlyUnmet; the stored booking is not changed here.
 *
 * Each item also carries, at the top level, the booking's roomLayoutCode, the
 * expectedAttendance applied (its own, else the event's, else null) and
 * attendanceSource ('booking', 'event' or null), so the screen can list them
 * (AC5) and mark a fallback as the event's (R14) even when the recheck failed.
 *
 * Errors: the event-wide ones (no such event, not the assigned coordinator,
 * EVENT_DATES_MISSING) and a failed bookings read refuse the whole request,
 * as the one-venue check does. Anything that goes wrong for one booking
 * belongs to that booking (SCRUM-193/194, B3/B7): its item carries current:
 * null, newlyUnmet [] and an error, and the others still return --
 *   EVENT_ATTENDANCE_MISSING     SCRUM-525 (R12): neither the booking nor the
 *                                event has an attendance; another booking with
 *                                its own number is still judged
 *   VENUE_RETIRED                the venue was retired
 *   STORED_REQUIREMENTS_INVALID  the stored accessibility or facility codes
 *                                are not a list of codes, or a code is no
 *                                longer known; the check is not run with
 *                                some codes silently dropped
 *   RECHECK_FAILED               anything else: the venue cannot be read, the
 *                                availability read failed, ...
 *
 * An event with no live bookings is [], not a 404, for the same reason the
 * venue search answers [].
 *
 * @param {string} eventRequestId
 * @param {object} [options]
 * @param {string} [options.userId]  the caller, from the JWT
 * @param {object} [options.client]  a Supabase client
 * @returns {Promise<Array<{bookingId: string, venueId: string, venueName: string|null,
 *   venueLocation: string|null, status: string, statusDisplay: object,
 *   bookingStartsAt: string|null, bookingEndsAt: string|null,
 *   roomLayoutCode: string|null, expectedAttendance: number|null,
 *   attendanceSource: 'booking'|'event'|null,
 *   suitabilityOverridden: boolean,
 *   current: {suitable: boolean, criteria: object[], checked: object}|null,
 *   atRequest: {suitable: boolean, unmet: string[]}|null,
 *   newlyUnmet: string[], error: {code: string, message: string}|null}>>}
 *   oldest booking first
 * @throws {NotFoundError}   no such event, or a draft
 * @throws {ForbiddenError}  userId is not the event's assigned coordinator
 * @throws {ConflictError}   EVENT_DATES_MISSING
 * @throws {Error}           the bookings read failed
 */
export async function checkEventVenues(eventRequestId, { userId, client } = {}) {
  const db = await resolveClient(client);

  const event = await getEventRequestForCoordinator(eventRequestId, { client: db });
  assertCheckable(event, userId);

  const { data, error } = await db
    .from('bookings')
    .select(EVENT_BOOKING_COLUMNS)
    .eq('event_request_id', event.id)
    .in('status', LIVE_BOOKING_STATUSES)
    .order('created_at');
  if (error) throw new Error(error.message || "The event's bookings could not be read");

  return Promise.all((data ?? []).map((booking) => recheckBooking(event, booking, db)));
}

/** Thrown inside recheckBooking for codes stored in a shape that cannot be judged. */
class StoredRequirementsError extends Error {}

/**
 * The accessibility and facility codes stored with a booking's result, as
 * the recheck judges them (SCRUM-193/194, B3).
 *
 * No stored result, or one without `checked` (stored before SCRUM-190), or a
 * list that is absent or null: none asked for, as before. Anything else that
 * is not a list of non-empty strings cannot be judged, and is refused rather
 * than dropped, since judging fewer codes than were asked for could report a
 * venue as suitable when it is not.
 */
function storedCodes(stored) {
  const checked = typeof stored === 'object' && stored !== null ? stored.checked : undefined;
  if (checked === undefined || checked === null) return { accessibility: [], facilities: [] };
  if (typeof checked !== 'object' || Array.isArray(checked)) {
    throw new StoredRequirementsError('the stored checked value is not an object');
  }

  const codes = {};
  for (const field of ['accessibility', 'facilities']) {
    const value = checked[field];
    if (value === undefined || value === null) {
      codes[field] = [];
    } else if (
      Array.isArray(value) &&
      value.every((code) => typeof code === 'string' && code.trim() !== '')
    ) {
      codes[field] = value;
    } else {
      throw new StoredRequirementsError(`${field} is not a list of codes`);
    }
  }
  return codes;
}

/** One booking's failure as its item's error; see checkEventVenues. */
function toItemError(err, booking) {
  // SCRUM-525: a booking with no attendance anywhere is that booking's
  // problem now, not the event's (R12), so it is named as such.
  if (
    err instanceof ConflictError &&
    (err.code === 'VENUE_RETIRED' || err.code === 'EVENT_ATTENDANCE_MISSING')
  ) {
    return { code: err.code, message: err.message };
  }
  // A ValidationError here can only come from assertKnownCodes: the stored
  // codes include one no longer in its lookup table.
  if (err instanceof StoredRequirementsError || err instanceof ValidationError) {
    return {
      code: 'STORED_REQUIREMENTS_INVALID',
      message:
        'The requirement codes stored with this request cannot be checked ' +
        `(${err instanceof ValidationError ? summariseDetails(err) : err.message})`,
    };
  }
  // Untyped means unanticipated: logged for whoever is on call, and never
  // passed on, as handleError does for a whole request.
  if (!(err instanceof AppError)) {
    console.error(`Recheck of booking ${booking.id} failed:`, err);
  }
  return {
    code: 'RECHECK_FAILED',
    message:
      err instanceof AppError
        ? err.message
        : 'This venue could not be rechecked just now; try again later',
  };
}

function summariseDetails(err) {
  const details = Array.isArray(err.details) ? err.details : [];
  if (details.length === 0) return err.message;
  return details.map(({ field, message }) => `${field}: ${message}`).join('; ');
}

/** One booking of checkEventVenues, rechecked; see there. Never throws. */
async function recheckBooking(event, booking, db) {
  const venue = one(booking.venues) ?? {};
  const stored = booking.suitability_result ?? null;
  const atRequest = atRequestOf(stored);
  const bookingStartsAt = booking.starts_at ?? null;
  const bookingEndsAt = booking.ends_at ?? null;
  // SCRUM-525 (R15): the booking's own number wins; the event's is only the
  // fallback for a booking that has none.
  const ownAttendance = booking.expected_attendance ?? null;
  const expectedAttendance = ownAttendance ?? event.expectedAttendance ?? null;

  // Everything the list shows that does not need the recheck is set here,
  // before the try, so an item whose recheck fails still shows it (AC5).
  const item = {
    bookingId: booking.id,
    venueId: booking.venue_id,
    venueName: venue.name ?? null,
    venueLocation: venue.location ?? null,
    status: booking.status,
    statusDisplay: getBookingStatusDisplay(booking.status),
    bookingStartsAt,
    bookingEndsAt,
    roomLayoutCode: booking.room_layout_code ?? null,
    expectedAttendance,
    attendanceSource:
      ownAttendance !== null ? 'booking' : expectedAttendance !== null ? 'event' : null,
    suitabilityOverridden: booking.suitability_overridden ?? false,
    current: null,
    atRequest,
    newlyUnmet: [],
    error: null,
  };

  try {
    const { accessibility, facilities } = storedCodes(stored);
    item.current = await judgeVenue(
      event,
      {
        venueId: booking.venue_id,
        roomLayoutCode: booking.room_layout_code ?? null,
        accessibility,
        facilities,
        expectedAttendance,
        // Compared only when both ends were read.
        bookingPeriod:
          bookingStartsAt && bookingEndsAt
            ? { startsAt: bookingStartsAt, endsAt: bookingEndsAt }
            : null,
      },
      db,
    );
  } catch (err) {
    item.error = toItemError(err, booking);
    return item;
  }

  const unmetAtRequest = new Set(atRequest ? atRequest.unmet : []);
  item.newlyUnmet = unmetOf(item.current.criteria).filter((name) => !unmetAtRequest.has(name));
  return item;
}
