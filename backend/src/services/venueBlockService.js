/**
 * Venue block service.
 *
 * SCRUM-126, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC1: a block is created with a venue, a start and end date and time, and a
 * reason category. Creation goes through create_venue_block in
 * 011_venue_block_creation.sql rather than a direct insert, because the
 * retirement and overlap checks have to hold until the insert commits and
 * PostgREST gives each supabase-js call its own transaction -- the migration's
 * header has the full argument.
 *
 * Input is validated before any network call, so a malformed request never
 * costs a round trip. The function and the table constraints in 010 remain
 * the backstop, and translateError turns what they raise into typed errors.
 *
 * SCRUM-125 (AC3) adds booking conflicts. create_venue_block is redefined in
 * 012_venue_block_booking_conflicts.sql: a block over approved bookings is
 * created only when the caller confirms the override and acknowledges every
 * booking that still conflicts. Otherwise the RPC answers with the conflict
 * list, which this service raises as a ConflictError, BLOCK_BOOKING_CONFLICT.
 *
 * SCRUM-128 (AC3) completes the override. create_venue_block is redefined
 * again in 013_booking_review_notifications.sql: in the same transaction as
 * the insert, each overridden booking is set to flagged_for_review and every
 * Event Coordinator is notified. The created outcome now reports the bookings
 * actually flagged, which this service returns as flaggedBookings.
 *
 * No routes call this yet; SCRUM-127 adds them.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { validateVenueId } from '../validation/venueValidation.js';
import { validateCreateBlock, validateBlockId } from '../validation/venueBlockValidation.js';

/** Every column toBlock reads, so each read selects the same shape. */
const BLOCK_COLUMNS =
  'id, venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by, ' +
  'created_at, updated_at, removed_at, removed_by';

/** The shape gen_random_uuid() produces; what a clashing block's id looks like. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres codes that mean "the input was wrong", whoever caught it. */
const VALIDATION_CODES = new Set([
  '23514', // check constraint: times out of order, other without notes, notes too long
  '22023', // invalid_parameter_value, raised by create_venue_block's period checks
  '23502', // not null
  '22P02', // invalid text representation: a bad uuid or reason reached the cast
  '22007', // invalid datetime format
  '22008', // datetime field overflow
]);

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Deliberately no /not found/i fallback on the message, unlike venueService:
 * every not-found this service can meet is raised as no_data_found, so the
 * code alone decides, and a message that happens to contain the words cannot
 * turn an unrelated failure into a 404.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  if (VALIDATION_CODES.has(code)) {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // Foreign key. On venue_blocks the only user-supplied references are the
  // *_by columns; venue_id cannot fail here because the function locked the
  // venue row before inserting.
  if (code === '23503') {
    if (/_by/.test(`${detail} ${error.details ?? ''}`)) {
      return new ValidationError(`The editing user does not exist: ${detail}`);
    }
    return new ValidationError(`A referenced record does not exist: ${detail}`);
  }

  // raised by create_venue_block when the venue does not exist
  if (code === 'P0002') {
    return new NotFoundError(detail || 'Venue not found');
  }

  // raised by create_venue_block: VENUE_RETIRED or BLOCK_OVERLAPS_BLOCK, carried
  // in the hint so a client can tell them apart without reading prose.
  //
  // BLOCK_OVERLAPS_BLOCK carries the clashing block's id in DETAIL, which
  // PostgREST passes through as error.details. It becomes the conflict list,
  // so a client can point at the block rather than just say one exists. Only
  // a uuid is trusted there; anything else leaves the list empty.
  if (code === 'PT409') {
    const hint = error.hint ?? null;
    const blockId = typeof error.details === 'string' ? error.details.trim() : '';
    const conflicts =
      hint === 'BLOCK_OVERLAPS_BLOCK' && UUID_PATTERN.test(blockId) ? [{ blockId }] : [];
    return new ConflictError(detail, { code: hint, conflicts });
  }

  // venue_blocks_no_overlap in 010. Reached only if a concurrent write beat
  // the function's own overlap check, so it gets the same code that check uses.
  if (code === '23P01') {
    return new ConflictError('This period overlaps another block on this venue.', {
      code: 'BLOCK_OVERLAPS_BLOCK',
    });
  }

  return new Error(detail || 'Unexpected database error');
}

/**
 * A venue_blocks row, in the camelCase every other service returns.
 *
 * Exported because create_venue_block returns the row as jsonb, and the RPC
 * result and a table read must come back in exactly the same shape.
 *
 * @param {object} row  snake_case, from PostgREST or to_jsonb
 * @returns {object}
 */
export function toBlock(row) {
  return {
    id: row.id,
    venueId: row.venue_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
    notes: row.notes,
    createdBy: row.created_by,
    lastModifiedBy: row.last_modified_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
  };
}

/**
 * One overlapping approved booking, as create_venue_block reports it, in
 * camelCase.
 *
 * Exported so the conflict list and SCRUM-128's flagged bookings come back in
 * exactly the same shape: flag_bookings_for_block (013) returns the same
 * columns as venue_block_booking_conflicts (012) for that reason.
 *
 * @param {object} row  snake_case, from venue_block_booking_conflicts (012)
 *                      or flag_bookings_for_block (013)
 * @returns {{bookingId: string, eventRequestId: string, eventName: string,
 *            startsAt: string, endsAt: string}}
 */
export function toBookingConflict(row) {
  return {
    bookingId: row.booking_id,
    eventRequestId: row.event_request_id,
    eventName: row.event_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

/**
 * Block a venue for a period.
 *
 * @param {string} venueId
 * @param {object} input            see validateCreateBlock; includes the
 *                                  SCRUM-125 confirmOverride and
 *                                  acknowledgedBookingIds
 * @param {string|null} userId      the Venue Staff member creating the block
 * @param {object} [options]
 * @param {Date} [options.now]      injected for tests; see validateCreateBlock
 * @returns {Promise<{block: object, flaggedBookings: object[]}>} the created
 *          block, and the bookings the override flagged for review (shaped by
 *          toBookingConflict; [] when there were none). By the time this
 *          resolves those bookings are flagged_for_review and every Event
 *          Coordinator has a notification for each (013).
 * @throws {ValidationError} bad input, before any network call
 * @throws {NotFoundError}   no venue with that id
 * @throws {ConflictError}   venue retired (VENUE_RETIRED); the period overlaps
 *                           another block (BLOCK_OVERLAPS_BLOCK, conflicts
 *                           [{blockId}]); or it overlaps approved bookings
 *                           that were not all acknowledged
 *                           (BLOCK_BOOKING_CONFLICT, conflicts shaped by
 *                           toBookingConflict)
 */
export async function createVenueBlock(venueId, input, userId = null, { now } = {}) {
  validateVenueId(venueId);
  // An undefined `now` falls through to the validator's own default.
  const block = validateCreateBlock(input, { now });

  const { data, error } = await supabase.rpc('create_venue_block', {
    p_venue_id: venueId,
    p_starts_at: block.startsAt,
    p_ends_at: block.endsAt,
    p_reason: block.reason,
    p_notes: block.notes,
    p_user_id: userId,
    p_confirm_override: block.confirmOverride,
    p_acknowledged_booking_ids: block.acknowledgedBookingIds,
  });

  if (error) throw translateError(error);

  // Approved bookings overlap and were not all acknowledged; nothing was
  // written. If the caller had already confirmed, the list it confirmed is
  // stale -- a booking entered the period since -- and saying so tells the
  // Venue Staff member why they are being asked again.
  if (data?.outcome === 'conflict') {
    const message = block.confirmOverride
      ? 'The overlapping bookings have changed since you confirmed; review them again'
      : 'This period overlaps approved bookings';
    throw new ConflictError(message, {
      code: 'BLOCK_BOOKING_CONFLICT',
      conflicts: (data.conflicts ?? []).map(toBookingConflict),
    });
  }

  // Anything else is an outcome this build does not know. Failing loudly
  // beats reporting a block that may not exist.
  if (data?.outcome !== 'created') {
    throw new Error(`Unexpected outcome from create_venue_block: ${data?.outcome}`);
  }

  // flagged_bookings, not affected_bookings, and deliberately no fallback to
  // it. affected_bookings is the list the caller acknowledged; flagged_bookings
  // is what the database actually changed. Falling back would report bookings
  // as flagged against a database where 013 has not been applied and nothing
  // was flagged at all -- an empty list is the honest answer there.
  return {
    block: toBlock(data.block),
    flaggedBookings: (data.flagged_bookings ?? []).map(toBookingConflict),
  };
}

/**
 * A venue's active blocks, soonest first.
 *
 * Ended blocks are included; narrowing to a time window is SCRUM-130's job.
 * Removed blocks are not. An unknown venue answers [], as getVenueHistory
 * does, rather than paying a round trip to say it does not exist.
 *
 * @param {string} venueId
 * @returns {Promise<object[]>} possibly empty
 * @throws {ValidationError} when the id is malformed, before any network call
 */
export async function listVenueBlocks(venueId) {
  validateVenueId(venueId);

  const { data, error } = await supabase
    .from('venue_blocks')
    .select(BLOCK_COLUMNS)
    .eq('venue_id', venueId)
    .is('removed_at', null)
    .order('starts_at')
    .order('id');

  if (error) throw translateError(error);

  return (data ?? []).map(toBlock);
}

/**
 * One block, scoped to its venue.
 *
 * Scoped by both ids so a block id cannot be read through the wrong venue's
 * URL. Removed blocks are returned -- the audit trail still points at them.
 *
 * @param {string} venueId
 * @param {string} blockId
 * @returns {Promise<object>}
 * @throws {ValidationError} when either id is malformed
 * @throws {NotFoundError}   no such block on that venue
 */
export async function getVenueBlock(venueId, blockId) {
  validateVenueId(venueId);
  validateBlockId(blockId);

  const { data, error } = await supabase
    .from('venue_blocks')
    .select(BLOCK_COLUMNS)
    .eq('venue_id', venueId)
    .eq('id', blockId)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Block ${blockId} not found on venue ${venueId}`);

  return toBlock(data);
}
