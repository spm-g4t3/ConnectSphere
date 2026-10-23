import {
  ValidationError, NotFoundError, ConflictError, ServiceUnavailableError, UnauthorizedError,
} from '../errors.js';
import {
  SCHEMA_MISSING_CODES, createPgTranslator, forCodes, forbidden, invalid, hintConflict,
} from '../http/pgErrors.js';
import { isPlausibleId } from '../validation/ids.js';

/**
 * assert_registration_withdrawable's refusals. A missing registration and
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
