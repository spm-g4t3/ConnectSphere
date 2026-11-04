import {
  ValidationError, NotFoundError, ConflictError, ServiceUnavailableError, UnauthorizedError,
} from '../errors.js';
import {
  SCHEMA_MISSING_CODES, createPgTranslator, forCodes, forbidden, invalid, hintConflict,
} from '../http/pgErrors.js';
import { isPlausibleId } from '../validation/ids.js';
import { resolveClientIfMissing } from '../config/resolveClient.js';

/**
 * leave_event_waitlist's refusals. Kept apart from withdrawal's: leaving a queue
 * is not withdrawing a place, and its messages must not say so. A missing entry
 * and someone else's answer the same 404; a 55000 keeps its hint as the code
 * (ALREADY_REGISTERED once promoted, NOT_WAITLISTED once left).
 */
export const translateWaitlistDepartureError = createPgTranslator({
  codes: {
    ...forCodes(SCHEMA_MISSING_CODES, () => new ServiceUnavailableError(
      'Waiting lists are temporarily unavailable. Please try again later.',
    )),
    42501: forbidden,
    P0002: () => new NotFoundError('Waiting-list entry not found'),
    22023: invalid,
    55000: hintConflict(),
    ...forCodes(['40001', '40P01'], () => new ConflictError(
      'Your waiting-list entry changed while you were leaving. Please try again.', { code: 'REGISTRATION_CHANGED' },
    )),
  },
});

/**
 * Leaves the caller's own waiting-list entry. attendeeId must be requireAuth's
 * req.user.id; one RPC checks ownership and status under the event lock.
 */
export async function leaveWaitlist({ attendeeId, registrationId, client } = {}) {
  if (!attendeeId) throw new UnauthorizedError('Authentication required');
  for (const [field, value] of [['attendeeId', attendeeId], ['registrationId', registrationId]]) {
    if (!isPlausibleId(value)) {
      throw new ValidationError('Invalid waiting-list request', [{ field, message: 'must be a valid UUID' }]);
    }
  }
  const db = await resolveClientIfMissing(client);
  // Send what was validated: isPlausibleId trims, and a uuid cast does not.
  const { data, error } = await db.rpc('leave_event_waitlist', {
    p_registration_id: registrationId.trim().toLowerCase(),
    p_attendee_id: attendeeId.trim().toLowerCase(),
  });
  if (error) throw translateWaitlistDepartureError(error);
  if (data?.outcome !== 'left_waitlist' || !data.registration?.id) {
    throw new Error('Unexpected outcome from leave_event_waitlist');
  }

  const row = data.registration;
  return {
    id: row.id,
    eventRequestId: row.eventRequestId,
    attendeeId: row.attendeeId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
