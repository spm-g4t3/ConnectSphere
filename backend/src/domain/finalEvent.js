/**
 * SCRUM-382 (SCRUM-379 AC3): the one definition of a final event.
 *
 * An event is final once it is Completed or Cancelled. Nothing leads out of
 * either status (ALLOWED_TRANSITIONS), and a final event is read-only: no edit,
 * change request, booking, equipment, registration or on-site assignment
 * change is accepted. Every endpoint that changes an event, or anything
 * attached to it, asks this module. The routes do it through
 * middleware/finalEventGuard.js; the list of those routes is in
 * docs/SCRUM-382.md and is held in place by tests/routes/scrum382FinalEventRoutes.test.js.
 *
 * Pure and credential-free, like the rest of src/domain: nothing here reads the
 * database, so it can be imported anywhere.
 */

import { STATUS } from './eventRequestStatus.js';
import { ConflictError } from '../errors.js';

/** The statuses nothing leads out of. */
export const FINAL_EVENT_STATUSES = Object.freeze([STATUS.COMPLETED, STATUS.CANCELLED]);

/** Machine-readable reason on the 409, so a client can tell this refusal from other conflicts. */
export const EVENT_FINAL_CODE = 'EVENT_FINAL';

/**
 * Is this status Completed or Cancelled?
 *
 * Anything else is false, including a status this module has never heard of
 * and a missing one: the guard must only ever refuse an event that is known to
 * be final, never one it merely cannot read.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isFinalEventStatus(status) {
  return FINAL_EVENT_STATUSES.includes(status);
}

/**
 * The words shown to whoever tried to change a final event.
 *
 * @param {string} status  'completed' or 'cancelled'
 * @returns {string}
 */
export function finalEventMessage(status) {
  return `This event is ${status} and can no longer be changed`;
}

/**
 * Throw if the status is final; return normally otherwise.
 *
 * @param {unknown} status
 * @throws {ConflictError} 409 with code EVENT_FINAL
 */
export function assertEventNotFinal(status) {
  if (isFinalEventStatus(status)) {
    throw new ConflictError(finalEventMessage(status), { code: EVENT_FINAL_CODE });
  }
}
