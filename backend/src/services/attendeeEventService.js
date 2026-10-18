import { ROLE } from '../domain/userRole.js';
import { UnauthorizedError, ForbiddenError, ValidationError, NotFoundError, ServiceUnavailableError } from '../errors.js';
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

const REGISTERED = 'registered';
const SCHEMA_ERRORS = ['42P01', '42703', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'];

/** user is supplied by requireAuth, never by request parameters or the body. */
export async function getAttendeeEvent({ user, eventRequestId, client } = {}) {
  if (!user?.id) throw new UnauthorizedError('Authentication required');
  if (user.role !== ROLE.ATTENDEE) throw new ForbiddenError('This action is restricted to Attendees');
  for (const [field, value] of [['attendeeId', user.id], ['eventRequestId', eventRequestId]]) {
    if (!isPlausibleId(value)) {
      throw new ValidationError('Invalid attendee event request', [{ field, message: 'must be a valid UUID' }]);
    }
  }

  const attendeeId = user.id.trim().toLowerCase();
  const eventId = eventRequestId.trim().toLowerCase();
  const db = client ?? (await import('../config/supabaseClient.js')).supabase;
  // Keep the active registration and its event in one authorised read. The
  // unique attendee/event row also exists for inactive and waitlisted entries.
  const { data, error } = await db.from('event_registrations')
    .select('event_request_id, attendee_id, status, event_requests!inner(id)')
    .eq('attendee_id', attendeeId)
    .eq('event_request_id', eventId)
    .eq('status', REGISTERED)
    .maybeSingle();

  if (error) {
    if (SCHEMA_ERRORS.includes(error.code)) {
      throw new ServiceUnavailableError('Event information is temporarily unavailable. Please try again later.');
    }
    throw error;
  }
  if (!data || data.attendee_id !== attendeeId || data.event_request_id !== eventId
      || data.status !== REGISTERED || data.event_requests?.id !== eventId) {
    throw new NotFoundError('Event information not found');
  }

  // This is the access-only projection; arrangement retrieval extends this read.
  return { eventRequestId: data.event_request_id };
}
