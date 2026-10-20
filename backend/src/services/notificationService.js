/**
 * Notification service.
 *
 * SCRUM-128, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC3: when a block overrides approved bookings, each Event Coordinator is
 * notified. The notifications are written by the database, inside
 * create_venue_block (014_booking_review_notifications.sql), in the same
 * transaction that flags the bookings -- so this service never creates one.
 * It only lets a signed-in user read their own and mark one as read.
 *
 * Every query is scoped by recipient_id, taken from the caller's token by the
 * route. notifications has row level security on with no policies and this
 * client holds the secret key, so that filter is the whole of the access
 * control: a function here that forgot it would read everyone's inbox.
 *
 * SCRUM-491 (AC8): process_venue_hold_expiry (040) writes a
 * 'venue_hold_expired' notice for the holding event's coordinator, naming the
 * event, the venue and the expiry in its payload, and the hold in
 * venue_hold_id. It is read here like any other.
 *
 * Deliberately NOT done here:
 *
 *  - No role check. A notification belongs to its recipient, and ownership is
 *    the stronger rule: a Coordinator who loses the role should still be able
 *    to read what they were sent, and nobody else can read it either way.
 *  - No shaping of the payload. It is stored as the camelCase snapshot the
 *    frontend renders (see 014, section 3), so it passes through untouched.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { createPgTranslator, rejected } from '../http/pgErrors.js';
import { validateNotificationId } from '../validation/notificationValidation.js';

/** Every column toNotification reads, so each read selects the same shape. */
const NOTIFICATION_COLUMNS =
  'id, recipient_id, type, booking_id, block_id, venue_hold_id, event_request_id, payload, read_at, created_at, booking:bookings(event_request_id)';

/**
 * Enough for a dashboard card without paging. Read notifications stay in the
 * list, so without a cap it would grow for as long as the account exists.
 */
const DEFAULT_LIMIT = 50;

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Much smaller than venueBlockService's: these queries write nothing a
 * constraint could refuse, so the only input fault left is a malformed uuid
 * reaching the cast. Anything else is unexpected and stays a plain Error, so
 * the route answers 500 and logs it.
 */
const translateError = createPgTranslator({ codes: { '22P02': rejected } });

/**
 * Refuse a missing recipient before any query runs.
 *
 * The recipient filter is the only access control these queries have (see
 * the header), so a missing one is refused outright rather than sent to
 * PostgREST and left to whatever it makes of "recipient_id = undefined". A
 * route always passes req.user.id, so reaching this is a bug in the caller,
 * and it should say so rather than look like an empty inbox.
 */
function requireUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ValidationError('A signed-in user is required to read notifications');
  }
}

/**
 * A notifications row, in the camelCase every other service returns.
 * recipient_id is left out: every query is scoped to the caller, so it is
 * always the caller's own id and would tell them nothing.
 *
 * @param {object} row  snake_case, from PostgREST
 * @returns {object}
 */
export function toNotification(row) {
  return {
    id: row.id,
    type: row.type,
    bookingId: row.booking_id,
    blockId: row.block_id,
    // SCRUM-491: the hold a 'venue_hold_expired' notice is about (040); null
    // for every other type.
    venueHoldId: row.venue_hold_id,
    // SCRUM-172: older types store the event only in the payload, or only via
    // their booking, so fall back in that order. The embedded booking itself
    // is not returned.
    eventRequestId:
      row.event_request_id ?? row.payload?.eventRequestId ?? row.booking?.event_request_id ?? null,
    payload: row.payload ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/**
 * The caller's notifications, newest first, read and unread together.
 *
 * id is the tie-break because one override writes a notification per booking
 * in a single statement, so they share a created_at (now() is fixed for the
 * transaction). Without it their order could change between two reads.
 *
 * @param {string} userId           the recipient; the route passes req.user.id
 * @param {object} [options]
 * @param {number} [options.limit]  defaults to 50
 * @returns {Promise<object[]>} possibly empty
 * @throws {ValidationError} when userId is missing
 */
export async function listNotifications(userId, { limit = DEFAULT_LIMIT } = {}) {
  requireUserId(userId);

  const { data, error } = await supabase
    .from('notifications')
    .select(NOTIFICATION_COLUMNS)
    .eq('recipient_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw translateError(error);

  return (data ?? []).map(toNotification);
}

/**
 * How many of the caller's notifications are unread.
 *
 * SCRUM-172 (AC4): counted by the database, not from listNotifications, whose
 * cap would undercount past 50. head: true returns no rows, so a badge that
 * polls this stays cheap.
 *
 * @param {string} userId  the recipient; the route passes req.user.id
 * @returns {Promise<number>} 0 when none are unread
 * @throws {ValidationError} when userId is missing
 */
export async function countUnreadNotifications(userId) {
  requireUserId(userId);

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', userId)
    .is('read_at', null);

  if (error) throw translateError(error);

  return count ?? 0;
}

/**
 * Mark one of the caller's notifications as read.
 *
 * Idempotent. The update is guarded by read_at IS NULL, so marking an
 * already-read notification leaves the first read_at in place rather than
 * moving it -- "when was this first seen" stays true however many times the
 * button is pressed, or two tabs press it at once. When the guarded update
 * matches nothing, a second read tells "already read" (return it as it is)
 * apart from "not yours or does not exist" (404).
 *
 * Another user's notification answers the same 404, with the same message, as
 * a missing one. A 403 would confirm the id exists -- the enumeration oracle
 * errors.js explains the codebase avoids.
 *
 * @param {string} id
 * @param {string} userId  the recipient; the route passes req.user.id
 * @returns {Promise<object>} the notification, with readAt set
 * @throws {ValidationError} malformed id, or missing userId
 * @throws {NotFoundError}   no such notification for this user
 */
export async function markNotificationRead(id, userId) {
  requireUserId(userId);
  validateNotificationId(id);

  const { data: updated, error: updateError } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('recipient_id', userId)
    .is('read_at', null)
    .select(NOTIFICATION_COLUMNS)
    .maybeSingle();

  if (updateError) throw translateError(updateError);
  if (updated) return toNotification(updated);

  // Nothing unread matched. Either it was already read, or it is not this
  // user's to read -- the same scoped query tells them apart.
  const { data: existing, error: readError } = await supabase
    .from('notifications')
    .select(NOTIFICATION_COLUMNS)
    .eq('id', id)
    .eq('recipient_id', userId)
    .maybeSingle();

  if (readError) throw translateError(readError);
  if (!existing) throw new NotFoundError(`Notification ${id} not found`);

  return toNotification(existing);
}
