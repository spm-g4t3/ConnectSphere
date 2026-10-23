import {
  ValidationError, NotFoundError, ConflictError, ServiceUnavailableError, UnauthorizedError,
} from '../errors.js';
import {
  SCHEMA_MISSING_CODES, createPgTranslator, forCodes, forbidden, invalid, hintConflict,
} from '../http/pgErrors.js';
import { isPlausibleId } from '../validation/ids.js';
import { resolveClientIfMissing } from '../config/resolveClient.js';

/**
 * withdraw_registration's refusals, most raised by assert_registration_withdrawable,
 * which it calls. A missing registration and
 * someone else's answer the same 404; a 55000 keeps its hint as the code, so the
 * client can tell an expired deadline from a registration that is not confirmed.
 */
export const translateWithdrawalError = createPgTranslator({
  codes: {
    ...forCodes(SCHEMA_MISSING_CODES, () => new ServiceUnavailableError(
      'Registration withdrawal is temporarily unavailable. Please try again later.',
    )),
    42501: forbidden,
    P0002: () => new NotFoundError('Registration not found'),
    22023: invalid,
    55000: hintConflict(),
    ...forCodes(['40001', '40P01'], () => new ConflictError(
      'Your registration changed while you were withdrawing. Please try again.', { code: 'REGISTRATION_CHANGED' },
    )),
  },
});

/** attendeeId must be requireAuth's req.user.id, never a request parameter. */
export function validateWithdrawalIdentity({ attendeeId, registrationId } = {}) {
  if (!attendeeId) throw new UnauthorizedError('Authentication required');
  for (const [field, value] of [['attendeeId', attendeeId], ['registrationId', registrationId]]) {
    if (!isPlausibleId(value)) {
      throw new ValidationError('Invalid withdrawal request', [{ field, message: 'must be a valid UUID' }]);
    }
  }
}

/**
 * One RPC checks eligibility and writes under the same locks; never call
 * assert_registration_withdrawable first and treat it as permission to write.
 */
export async function withdrawRegistration({ attendeeId, registrationId, client } = {}) {
  validateWithdrawalIdentity({ attendeeId, registrationId });
  const db = await resolveClientIfMissing(client);
  const { data, error } = await db.rpc('withdraw_registration', {
    p_registration_id: registrationId,
    p_attendee_id: attendeeId,
  });
  if (error) throw translateWithdrawalError(error);
  if (data?.outcome !== 'withdrawn' || !data.registration?.id) {
    throw new Error('Unexpected outcome from withdraw_registration');
  }

  const row = data.registration;
  return {
    id: row.id,
    eventRequestId: row.eventRequestId,
    attendeeId: row.attendeeId,
    status: row.status,
    registeredAt: row.registeredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
