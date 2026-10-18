import { ROLE } from '../domain/userRole.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../domain/bookingStatus.js';
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
  // Registration, event state and arrangements share one database snapshot;
  // a separate status check could disclose arrangements after a planning change.
  const { data, error } = await db.from('event_registrations')
    .select(`event_request_id, attendee_id, status,
      event_requests!inner(id, status, proposed_start, proposed_end,
        bookings(id, status, venues(name, location)))`)
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

  const event = data.event_requests;
  if (event.status !== STATUS.CONFIRMED) {
    return { eventRequestId: data.event_request_id, state: 'unavailable' };
  }

  // Explicit projections keep internal status, planning and staffing data private.
  return {
    eventRequestId: data.event_request_id,
    state: 'confirmed',
    startsAt: event.proposed_start ?? null,
    endsAt: event.proposed_end ?? null,
    venues: (event.bookings ?? [])
      .filter(booking => booking.status === BOOKING_STATUS.APPROVED)
      .map(booking => ({
        bookingId: booking.id,
        name: booking.venues?.name ?? null,
        location: booking.venues?.location ?? null,
      })),
  };
}
