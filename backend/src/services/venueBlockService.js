/**
 * Venue block service.
 *
 * SCRUM-126, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC1: a block is created with a venue, a start and end date and time, and a
 * reason category. Creation goes through create_venue_block in
 * 012_venue_block_creation.sql rather than a direct insert, because the
 * retirement and overlap checks have to hold until the insert commits and
 * PostgREST gives each supabase-js call its own transaction -- the migration's
 * header has the full argument.
 *
 * Input is validated before any network call, so a malformed request never
 * costs a round trip. The function and the table constraints in 011 remain
 * the backstop, and translateError turns what they raise into typed errors.
 *
 * SCRUM-125 (AC3) adds booking conflicts. create_venue_block is redefined in
 * 013_venue_block_booking_conflicts.sql: a block over approved bookings is
 * created only when the caller confirms the override and acknowledges every
 * booking that still conflicts. Otherwise the RPC answers with the conflict
 * list, which this service raises as a ConflictError, BLOCK_BOOKING_CONFLICT.
 *
 * SCRUM-128 (AC3) completes the override. create_venue_block is redefined
 * again in 014_booking_review_notifications.sql: in the same transaction as
 * the insert, each overridden booking is set to flagged_for_review and every
 * Event Coordinator is notified. The created outcome now reports the bookings
 * actually flagged, which this service returns as flaggedBookings.
 *
 * SCRUM-127 (AC4) adds amending and removing, through update_venue_block and
 * remove_venue_block in 015_venue_block_amend_remove.sql, for the reason 012
 * gives for creation. An amendment can widen the period over approved
 * bookings, so it answers conflicts exactly as creation does, and on an
 * override flags them the same way. Removal is a soft delete that touches no
 * booking. The routes in routes/venues.js are the first callers.
 *
 * SCRUM-130 (AC2) adds the reads AC2's two halves need. listVenueBlocks takes
 * an optional window, for the venue calendar (SCRUM-178), and
 * findBlockedVenueIds answers which venues a period is blocked on, for venue
 * search -- today's /venues/search, and SCRUM-20/139 and SCRUM-16 after it.
 * Both use the half-open overlap venue_blocks_no_overlap uses: strict lt/gt,
 * so a block that only touches a window's edge is not in it.
 *
 * SCRUM-131 (AC4) adds getVenueBlockHistory: every creation, amendment and
 * removal, read from venue_block_history. Nothing here writes that table --
 * the trigger in 016_venue_block_history.sql does, off the same write the
 * functions above already make, so no RPC changes.
 *
 * This module never imports venueService.js. venueService imports
 * findBlockedVenueIds from here, and the reverse import would be circular.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { validateVenueId } from '../validation/venueValidation.js';
import {
  validateCreateBlock,
  validateUpdateBlock,
  validateBlockId,
  validateBlockWindow,
  validatePeriod,
} from '../validation/venueBlockValidation.js';

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
  '22023', // invalid_parameter_value: the period checks in create_ and update_venue_block
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

  // raised by create_venue_block when the venue does not exist, and by
  // update_venue_block and remove_venue_block (015) for a missing venue or a
  // block that is not on it
  if (code === 'P0002') {
    return new NotFoundError(detail || 'Venue not found');
  }

  // raised by create_venue_block: VENUE_RETIRED or BLOCK_OVERLAPS_BLOCK, carried
  // in the hint so a client can tell them apart without reading prose. 015
  // adds BLOCK_REMOVED and BLOCK_ENDED, which pass through the same way.
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

  // venue_blocks_no_overlap in 011. Reached only if a concurrent write beat
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
 * exactly the same shape: flag_bookings_for_block (014) returns the same
 * columns as venue_block_booking_conflicts (013) for that reason.
 *
 * @param {object} row  snake_case, from venue_block_booking_conflicts (013)
 *                      or flag_bookings_for_block (014)
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
 * The ConflictError for a {outcome: 'conflict'} answer.
 *
 * Shared by create and update so the stale-override message lives in one
 * place. Nothing was written. If the caller had already confirmed, the list
 * it confirmed is stale -- a booking entered the period since -- and saying
 * so tells the Venue Staff member why they are being asked again.
 *
 * @param {object} data              the RPC's jsonb result
 * @param {boolean} confirmOverride  what the caller sent, after validation
 * @returns {ConflictError} BLOCK_BOOKING_CONFLICT, conflicts shaped by
 *          toBookingConflict
 */
function conflictFromOutcome(data, confirmOverride) {
  const message = confirmOverride
    ? 'The overlapping bookings have changed since you confirmed; review them again'
    : 'This period overlaps approved bookings';
  return new ConflictError(message, {
    code: 'BLOCK_BOOKING_CONFLICT',
    conflicts: (data.conflicts ?? []).map(toBookingConflict),
  });
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
 *          Coordinator has a notification for each (014).
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
  // written.
  if (data?.outcome === 'conflict') {
    throw conflictFromOutcome(data, block.confirmOverride);
  }

  // Anything else is an outcome this build does not know. Failing loudly
  // beats reporting a block that may not exist.
  if (data?.outcome !== 'created') {
    throw new Error(`Unexpected outcome from create_venue_block: ${data?.outcome}`);
  }

  // flagged_bookings, not affected_bookings, and deliberately no fallback to
  // it. affected_bookings is the list the caller acknowledged; flagged_bookings
  // is what the database actually changed. Falling back would report bookings
  // as flagged against a database where 014 has not been applied and nothing
  // was flagged at all -- an empty list is the honest answer there.
  return {
    block: toBlock(data.block),
    flaggedBookings: (data.flagged_bookings ?? []).map(toBookingConflict),
  };
}

/**
 * A venue's active blocks, soonest first.
 *
 * Ended blocks are included, and so is a window wholly in the past: the
 * calendar shows the past too, so there is deliberately no "now" filter.
 * Removed blocks are not. An unknown venue answers [], as getVenueHistory
 * does, rather than paying a round trip to say it does not exist.
 *
 * SCRUM-130: with a from/to window, only blocks overlapping [from, to). The
 * id and the window are both checked before any query, so a bad request costs
 * no round trip.
 *
 * @param {string} venueId
 * @param {object} [window]        see validateBlockWindow; both or neither
 * @param {string} [window.from]   ISO 8601 with an offset
 * @param {string} [window.to]     ISO 8601 with an offset
 * @returns {Promise<object[]>} possibly empty
 * @throws {ValidationError} when the id or window is malformed, before any
 *                           network call
 */
export async function listVenueBlocks(venueId, { from, to } = {}) {
  validateVenueId(venueId);
  const window = validateBlockWindow({ from, to });

  let query = supabase
    .from('venue_blocks')
    .select(BLOCK_COLUMNS)
    .eq('venue_id', venueId)
    .is('removed_at', null);

  // Overlap, not containment: a block that starts before the window or ends
  // after it is still on the calendar for the part that shows. Strict, so a
  // block ending exactly at `from` is not in it.
  if (window !== null) {
    query = query.lt('starts_at', window.to).gt('ends_at', window.from);
  }

  const { data, error } = await query.order('starts_at').order('id');

  if (error) throw translateError(error);

  return (data ?? []).map(toBlock);
}

/**
 * The venues blocked at any point in a period (SCRUM-130, AC2).
 *
 * Exported for every search that has to leave blocked venues out: today's
 * /venues/search, and SCRUM-20/139 and SCRUM-16 later. Those will call it
 * directly, not through searchVenues, which is why it validates its own input
 * rather than trusting a caller to have done so.
 *
 * Only removed blocks are left out: a removed block blocks nothing. There is
 * no "now" filter -- an ended block cannot overlap a future period anyway, and
 * for a past one it is the truthful answer.
 *
 * @param {string} startsAt  ISO 8601 with an offset
 * @param {string} endsAt    ISO 8601 with an offset; later than startsAt
 * @returns {Promise<string[]>} each venue id once; [] when none is blocked
 * @throws {ValidationError} when the period is missing or malformed, before
 *                           any network call
 */
export async function findBlockedVenueIds(startsAt, endsAt) {
  const period = validatePeriod({ startsAt, endsAt });

  // The same strict overlap as listVenueBlocks. Touching the period's edge
  // does not block it, matching venue_blocks_no_overlap in 011.
  const { data, error } = await supabase
    .from('venue_blocks')
    .select('venue_id')
    .is('removed_at', null)
    .lt('starts_at', period.endsAt)
    .gt('ends_at', period.startsAt);

  if (error) throw translateError(error);

  // Blocks on one venue never overlap each other, but several can fall in a
  // long period, and the caller wants venues, not blocks.
  return [...new Set((data ?? []).map((row) => row.venue_id))];
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

/**
 * Amend a block: shorten it, extend it, or change its reason or notes (AC4).
 *
 * A patch -- see validateUpdateBlock. update_venue_block (015) merges it onto
 * the stored row and checks the result under the same locks creation takes.
 *
 * @param {string} venueId
 * @param {string} blockId
 * @param {object} input            see validateUpdateBlock
 * @param {string|null} userId      the Venue Staff member amending the block;
 *                                  recorded as last_modified_by, and as
 *                                  flagged_by on any booking the amendment
 *                                  overrides
 * @param {object} [options]
 * @param {Date} [options.now]      injected for tests; see validateUpdateBlock
 * @returns {Promise<{block: object, flaggedBookings: object[]}>} as
 *          createVenueBlock: the amended block, and the bookings this
 *          amendment newly flagged ([] when none)
 * @throws {ValidationError} bad input, before any network call; or a merged
 *                           row the database refused (22023)
 * @throws {NotFoundError}   no such venue, or no such block on it
 * @throws {ConflictError}   BLOCK_REMOVED, BLOCK_ENDED, VENUE_RETIRED,
 *                           BLOCK_OVERLAPS_BLOCK or BLOCK_BOOKING_CONFLICT,
 *                           as createVenueBlock describes the last three
 */
export async function updateVenueBlock(venueId, blockId, input, userId = null, { now } = {}) {
  validateVenueId(venueId);
  validateBlockId(blockId);
  const patch = validateUpdateBlock(input, { now });

  // Every parameter named, defaults included, so what this sends never
  // depends on the function's defaults staying as they are.
  const { data, error } = await supabase.rpc('update_venue_block', {
    p_venue_id: venueId,
    p_block_id: blockId,
    p_starts_at: patch.startsAt,
    p_ends_at: patch.endsAt,
    p_reason: patch.reason,
    p_notes: patch.notes,
    p_notes_supplied: patch.notesSupplied,
    p_user_id: userId,
    p_confirm_override: patch.confirmOverride,
    p_acknowledged_booking_ids: patch.acknowledgedBookingIds,
  });

  if (error) throw translateError(error);

  if (data?.outcome === 'conflict') {
    throw conflictFromOutcome(data, patch.confirmOverride);
  }

  // As in createVenueBlock: an unknown outcome fails loudly.
  if (data?.outcome !== 'updated') {
    throw new Error(`Unexpected outcome from update_venue_block: ${data?.outcome}`);
  }

  // flagged_bookings only, for the reason createVenueBlock gives.
  return {
    block: toBlock(data.block),
    flaggedBookings: (data.flagged_bookings ?? []).map(toBookingConflict),
  };
}

/**
 * Remove a block (AC4): a soft delete that records who removed it and when.
 *
 * Bookings the block flagged stay flagged; a Coordinator resolves each one.
 *
 * @param {string} venueId
 * @param {string} blockId
 * @param {string|null} userId  the Venue Staff member removing the block
 * @returns {Promise<void>} nothing -- the route answers 204, and a removed
 *          block is no longer in the list a client would show
 * @throws {ValidationError} when either id is malformed, before any network call
 * @throws {NotFoundError}   no such venue, or no such block on it
 * @throws {ConflictError}   BLOCK_REMOVED (already removed) or BLOCK_ENDED
 */
export async function removeVenueBlock(venueId, blockId, userId = null) {
  validateVenueId(venueId);
  validateBlockId(blockId);

  const { data, error } = await supabase.rpc('remove_venue_block', {
    p_venue_id: venueId,
    p_block_id: blockId,
    p_user_id: userId,
  });

  if (error) throw translateError(error);

  // An unknown outcome is not proof the block was removed, so it is not
  // reported as success.
  if (data?.outcome !== 'removed') {
    throw new Error(`Unexpected outcome from remove_venue_block: ${data?.outcome}`);
  }
}


/** A venue_block_history row in camelCase; the jsonb stays as stored. */
function toBlockHistoryEntry(row) {
  return {
    id: row.id,
    blockId: row.block_id,
    action: row.action,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    oldValues: row.old_values,
    newValues: row.new_values,
  };
}

/**
 * A block's audit trail, newest first (SCRUM-131, AC4).
 *
 * The block is looked up first, scoped to its venue. History rows carry no
 * venue_id, so without that a block's trail could be read through any
 * venue's URL. Removed blocks pass -- their trail is exactly what this keeps.
 *
 * oldValues and newValues are returned as stored, snake_case keys included,
 * as getVenueHistory does: they are a record of columns, not an API shape.
 *
 * @param {string} venueId
 * @param {string} blockId
 * @returns {Promise<object[]>} {id, blockId, action, changedBy, changedAt,
 *          oldValues, newValues}; action is created, amended or removed
 * @throws {ValidationError} when either id is malformed, before any network call
 * @throws {NotFoundError}   no such block on that venue
 */
export async function getVenueBlockHistory(venueId, blockId) {
  validateVenueId(venueId);
  validateBlockId(blockId);

  await getVenueBlock(venueId, blockId);

  // id breaks ties, as in getVenueHistory, so equal timestamps keep a stable order.
  const { data, error } = await supabase
    .from('venue_block_history')
    .select('id, block_id, action, changed_by, changed_at, old_values, new_values')
    .eq('block_id', blockId)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw translateError(error);

  return (data ?? []).map(toBlockHistoryEntry);
}
