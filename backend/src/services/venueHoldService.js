/**
 * Venue hold service.
 *
 * SCRUM-491 "Place a Tentative Venue Hold with Expiry - Venue Staff".
 *
 * Venue Staff place a tentative hold on a venue for an Approved event while
 * its coordinator finalises it. A hold is written by place_venue_hold in
 * 040_venue_holds.sql rather than by a direct insert, for the reason 012
 * gives for block creation: the checks have to hold until the insert commits,
 * and supabase-js gives each call its own transaction. The function locks the
 * event and then the venue, checks the placer is Venue Staff, the event is
 * Approved with dates, the expiry is in the future, the venue is active, and
 * that the event holds no other active hold on it, and only then asks
 * venue_occupancy_conflicts() (032, extended in 040) whether anything else
 * occupies the event's period there (AC1-AC4).
 *
 * What this module adds around that function:
 *
 *  - Input is validated before any network call.
 *  - What the function raises or answers is turned into typed errors. A
 *    conflict outcome becomes HOLD_PERIOD_CONFLICT with the conflicting
 *    bookings, blocks and holds, each with its occupied period, mapped by
 *    bookingRequestService's toPeriodConflict so a hold conflict and a booking
 *    conflict read the same.
 *  - Two reads the hold screen needs: a venue's active holds, and the
 *    Approved events a hold can be placed for (the event picker).
 *
 * "Active" here is what 040 means by it: status 'active' and an expiry still
 * in the future. A hold past its expiry occupies nothing at once (AC7), so it
 * is not listed even before the expiry job has marked it expired.
 *
 * Who may call is the route's job (Venue Staff only). The function checks the
 * role again, so this module trusts no caller on it.
 *
 * Takes an optional client, resolved lazily, for the reason
 * bookingRequestService.js gives: routes/eventRequests.js imports this module,
 * and its tests do not mock config/supabaseClient.js. For the same reason this
 * module never imports venueService.js, which imports the client statically.
 */

import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../errors.js';
import { validateHoldTargetId, validatePlaceVenueHold } from '../validation/venueHoldValidation.js';
import { VENUE_HOLD_STATUS } from '../domain/venueHoldStatus.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { toPeriodConflict } from './bookingRequestService.js';

/** The shape gen_random_uuid() produces; what an existing hold's id looks like. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres codes that mean "the input was wrong", whoever caught it. */
const VALIDATION_CODES = new Set([
  '23514', // check constraint: an expiry not after the placing time
  '22023', // invalid_parameter_value: no expiry, or one not in the future
  '23502', // not null
  '22P02', // invalid text representation: a bad uuid reached the cast
  '22007', // invalid datetime format
  '22008', // datetime field overflow
]);

/** What a venue's hold list reads: the hold, with its event embedded. */
const HOLD_COLUMNS = `
  id, event_request_id, venue_id, placed_by, placed_at, expires_at, status, expired_at,
  event_requests(event_name, proposed_start, proposed_end)
`;

async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/**
 * Turn a raw Postgres error into a typed one.
 *
 * PT409 carries the reason in its hint (EVENT_NOT_APPROVED,
 * EVENT_DATES_MISSING, VENUE_RETIRED, HOLD_EXISTS), so a client can tell the
 * refusals apart without reading prose. HOLD_EXISTS carries the existing
 * hold's id in DETAIL, which becomes the conflict list; only a uuid is
 * trusted there.
 *
 * 23505 is the unique partial index on (event, venue) where active. The venue
 * lock makes it unreachable in practice; if a concurrent write did beat the
 * function's own check, it gets the same code that check uses.
 */
function translateError(error) {
  const code = error.code;
  const detail = error.message ?? '';

  if (VALIDATION_CODES.has(code)) {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  if (code === '23503') {
    return new ValidationError(`A referenced record does not exist: ${detail}`);
  }

  if (code === 'P0002') {
    return new NotFoundError(detail || 'Event request or venue not found');
  }

  // AC1: the placer is not Venue Staff. The route refuses first; this is the
  // function's own answer, kept for any other caller.
  if (code === '42501') {
    return new ForbiddenError(detail);
  }

  if (code === '23505') {
    return new ConflictError('This event already holds this venue', { code: 'HOLD_EXISTS' });
  }

  if (code === 'PT409') {
    const hint = error.hint ?? null;
    const holdId = typeof error.details === 'string' ? error.details.trim() : '';
    const conflicts =
      hint === 'HOLD_EXISTS' && UUID_PATTERN.test(holdId) ? [{ kind: 'hold', holdId }] : [];
    return new ConflictError(detail, { code: hint, conflicts });
  }

  return new Error(detail || 'Unexpected database error');
}

/**
 * PostgREST embeds a many-to-one as an object, but an array if it were ever
 * read as one-to-many. Read defensively, as bookingRequestService does.
 */
function one(embedded) {
  return Array.isArray(embedded) ? embedded[0] : embedded;
}

/**
 * A venue_holds row, in the camelCase every other service returns.
 *
 * @param {object} row  snake_case, from to_jsonb in place_venue_hold or from
 *                      PostgREST
 */
export function toVenueHold(row) {
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    venueId: row.venue_id,
    placedBy: row.placed_by,
    placedAt: row.placed_at,
    expiresAt: row.expires_at,
    status: row.status,
    expiredAt: row.expired_at ?? null,
  };
}

/** Names for people, by id. A person with no name gets null (equipmentReviewService). */
async function readNames(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await db.from('profiles').select('id, full_name').in('id', unique);
  if (error) throw translateError(error);

  return new Map((data ?? []).map((row) => [row.id, row.full_name ?? null]));
}

/**
 * Place a tentative hold on a venue for an Approved event (AC1-AC4).
 *
 * @param {string} venueId  from the path
 * @param {object} input    { eventRequestId, expiresAt }; see validatePlaceVenueHold
 * @param {string} userId   the placer, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the new active hold, shaped by toVenueHold
 * @throws {ValidationError} bad input, before any network call
 * @throws {NotFoundError}   no such event, or no such venue
 * @throws {ForbiddenError}  the placer is not Venue Staff
 * @throws {ConflictError}   by code: EVENT_NOT_APPROVED, EVENT_DATES_MISSING,
 *                           VENUE_RETIRED, HOLD_EXISTS (conflicts name the
 *                           existing hold), HOLD_PERIOD_CONFLICT (conflicts
 *                           are bookings, blocks and other events' holds, each
 *                           with its occupied period, shaped by toPeriodConflict)
 */
export async function placeVenueHold(venueId, input, userId, { client } = {}) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('A signed-in user is required to place a hold');
  }
  const venue = validateHoldTargetId(venueId);
  const hold = validatePlaceVenueHold(input);

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('place_venue_hold', {
    p_event_request_id: hold.eventRequestId,
    p_venue_id: venue,
    p_expires_at: hold.expiresAt,
    p_placed_by: userId,
  });

  if (error) throw translateError(error);

  // Something occupies the event's period at the venue; nothing was written.
  if (data?.outcome === 'conflict') {
    throw new ConflictError('The venue is not free for the whole of this event', {
      code: 'HOLD_PERIOD_CONFLICT',
      conflicts: (data.conflicts ?? []).map(toPeriodConflict),
    });
  }

  // An outcome this build does not know. Failing loudly beats reporting a
  // hold that may not exist.
  if (data?.outcome !== 'placed') {
    throw new Error(`Unexpected outcome from place_venue_hold: ${data?.outcome}`);
  }

  const placed = toVenueHold(data.hold);
  if (placed.status !== VENUE_HOLD_STATUS.ACTIVE) {
    throw new Error(`place_venue_hold returned a ${placed.status} hold, not an active one`);
  }
  return placed;
}

/**
 * A venue's active holds, soonest expiry first, each with its event's name and
 * period and the placer's name.
 *
 * Active means status 'active' and an expiry still ahead (see the header), so
 * a lapsed hold the job has not reached yet is not listed. An unknown venue is
 * a 404 rather than an empty list, which would look like a free venue.
 *
 * @param {string} venueId
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]  the clock, for tests
 * @returns {Promise<object[]>} possibly empty
 * @throws {ValidationError} a malformed id, before any network call
 * @throws {NotFoundError}   no such venue
 */
export async function listActiveVenueHolds(venueId, { client, now = new Date() } = {}) {
  const id = validateHoldTargetId(venueId);
  const db = await resolveClient(client);

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (venueError) throw translateError(venueError);
  if (!venue) throw new NotFoundError(`Venue ${id} not found`);

  const { data, error } = await db
    .from('venue_holds')
    .select(HOLD_COLUMNS)
    .eq('venue_id', id)
    .eq('status', VENUE_HOLD_STATUS.ACTIVE)
    .gt('expires_at', now.toISOString())
    .order('expires_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw translateError(error);

  const rows = data ?? [];
  const names = await readNames(db, rows.map((row) => row.placed_by));

  return rows.map((row) => {
    const event = one(row.event_requests) ?? {};
    return {
      ...toVenueHold(row),
      eventName: event.event_name ?? null,
      eventStartsAt: event.proposed_start ?? null,
      eventEndsAt: event.proposed_end ?? null,
      placedByName: names.get(row.placed_by) ?? null,
    };
  });
}

/**
 * The Approved events a hold can be placed for: the hold form's event picker.
 *
 * Each with its name, period, expected attendance and assigned coordinator,
 * soonest first. Names are read in a second query from profiles, as
 * equipmentReviewService does, because event_requests has no foreign key to
 * profiles for PostgREST to embed.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty
 */
export async function listHoldCandidates({ client } = {}) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select('id, event_name, proposed_start, proposed_end, expected_attendance, assigned_coordinator_id')
    .eq('status', STATUS.APPROVED)
    .order('proposed_start', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw translateError(error);

  const rows = data ?? [];
  const names = await readNames(db, rows.map((row) => row.assigned_coordinator_id));

  return rows.map((row) => ({
    id: row.id,
    eventName: row.event_name,
    proposedStart: row.proposed_start ?? null,
    proposedEnd: row.proposed_end ?? null,
    expectedAttendance: row.expected_attendance ?? null,
    assignedCoordinatorId: row.assigned_coordinator_id ?? null,
    assignedCoordinatorName: names.get(row.assigned_coordinator_id) ?? null,
  }));
}
