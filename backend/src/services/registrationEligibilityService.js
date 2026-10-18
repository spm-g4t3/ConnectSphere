import {
  ValidationError, NotFoundError, ConflictError, ForbiddenError, UnauthorizedError, ServiceUnavailableError,
} from '../errors.js';
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

/** Shared by the eligibility preflight and registration writer. */
export function translateRegistrationEligibilityError(error) {
  if (['42703', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) {
    return new ServiceUnavailableError('Event registration is temporarily unavailable. Please try again later.');
  }
  if (error.code === '42501') return new ForbiddenError(error.message);
  if (error.code === 'P0002' || (error.code === '55000' && [
    'EVENT_NOT_CONFIRMED', 'REGISTRATION_DISABLED', 'REGISTRATION_DATES_MISSING',
    'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'EVENT_STARTED',
  ].includes(error.hint))) return new NotFoundError('This event is not open for registration');
  if (error.code === '22023') return new ValidationError(error.message);
  if (error.code === '40001' || error.code === '40P01') {
    return new ConflictError('Registration changed while you were registering. Please try again.', { code: 'REGISTRATION_CHANGED' });
  }
  if (error.code === '55000') return new ConflictError(error.message, { code: error.hint });
  return error;
}

/** Validate the verified identity and event id before either registration RPC. */
export function validateRegistrationIdentity({ attendeeId, eventId } = {}) {
  if (!attendeeId) throw new UnauthorizedError('Authentication required');
  for (const [field, value] of [['attendeeId', attendeeId], ['eventId', eventId]]) {
    if (!isPlausibleId(value)) {
      throw new ValidationError('Invalid registration request', [{ field, message: 'must be a valid UUID' }]);
    }
  }
}

/**
 * Preflight only: attendeeId comes from requireAuth's req.user.id. Role, status,
 * settings and time come from the database, never the request. The writer must
 * call assert_event_registration_eligible again within its insertion transaction.
 */
export async function validateRegistrationEligibility({ attendeeId, eventId, client } = {}) {
  validateRegistrationIdentity({ attendeeId, eventId });
  const db = client ?? (await import('../config/supabaseClient.js')).supabase;
  const { error } = await db.rpc('assert_event_registration_eligible', {
    p_event_request_id: eventId,
    p_attendee_id: attendeeId,
  });
  if (error) throw translateRegistrationEligibilityError(error);
}
