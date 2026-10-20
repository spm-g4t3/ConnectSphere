import { ROLE } from '../domain/userRole.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../domain/bookingStatus.js';
import { UnauthorizedError, ForbiddenError, ValidationError, NotFoundError, ServiceUnavailableError } from '../errors.js';
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

const REGISTERED = 'registered';
const SCHEMA_ERRORS = ['42P01', '42703', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'];
const PAGE_SIZE = 1000;
const VISIBLE_BOOKING_STATUSES = [BOOKING_STATUS.APPROVED, BOOKING_STATUS.FLAGGED_FOR_REVIEW];

function validateId(field, value) {
  if (!isPlausibleId(value)) {
    throw new ValidationError('Invalid attendee event request', [{ field, message: 'must be a valid UUID' }]);
  }
}

function attendeeIdentity(user) {
  if (!user?.id) throw new UnauthorizedError('Authentication required');
  if (user.role !== ROLE.ATTENDEE) throw new ForbiddenError('This action is restricted to Attendees');
  validateId('attendeeId', user.id);
  return user.id.trim().toLowerCase();
}

function checkReadError(error) {
  if (!error) return;
  if (SCHEMA_ERRORS.includes(error.code)) {
    throw new ServiceUnavailableError('Event information is temporarily unavailable. Please try again later.');
  }
  throw error;
}

/** user is supplied by requireAuth, never by request parameters or the body. */
export async function getAttendeeEvent({ user, eventRequestId, client } = {}) {
  const attendeeId = attendeeIdentity(user);
  validateId('eventRequestId', eventRequestId);
  const eventId = eventRequestId.trim().toLowerCase();
  const db = client ?? (await import('../config/supabaseClient.js')).supabase;
  // Registration, event state and arrangements share one database snapshot;
  // a separate status check could disclose arrangements after a planning change.
  const { data, error } = await db.from('event_registrations')
    .select(`event_request_id, attendee_id, status,
      event_requests!inner(id, event_name, status, proposed_start, proposed_end,
        bookings(id, status, venues(name, location)))`)
    .eq('attendee_id', attendeeId)
    .eq('event_request_id', eventId)
    .eq('status', REGISTERED)
    .maybeSingle();

  checkReadError(error);
  if (!data || data.attendee_id !== attendeeId || data.event_request_id !== eventId
      || data.status !== REGISTERED || data.event_requests?.id !== eventId) {
    throw new NotFoundError('Event information not found');
  }

  const event = data.event_requests;
  // The name is already on the attendee's registered-events list in every state.
  const eventName = event.event_name ?? null;
  if (event.status !== STATUS.CONFIRMED) {
    return { eventRequestId: data.event_request_id, state: 'unavailable', eventName };
  }

  // Explicit projections keep internal status, planning and staffing data private.
  return {
    eventRequestId: data.event_request_id,
    state: 'confirmed',
    eventName,
    startsAt: event.proposed_start ?? null,
    endsAt: event.proposed_end ?? null,
    // A flagged booking is still the event's venue until someone resolves it;
    // attendees see that it is under review, never why.
    venues: (event.bookings ?? [])
      .filter(booking => VISIBLE_BOOKING_STATUSES.includes(booking.status))
      .map(booking => ({
        bookingId: booking.id,
        name: booking.venues?.name ?? null,
        location: booking.venues?.location ?? null,
        underReview: booking.status === BOOKING_STATUS.FLAGGED_FOR_REVIEW,
      })),
  };
}

/** Entry points only: arrangement visibility remains the protected detail read's decision. */
export async function listAttendeeEvents({ user, client } = {}) {
  const attendeeId = attendeeIdentity(user);
  const db = client ?? (await import('../config/supabaseClient.js')).supabase;
  const events = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db.from('event_registrations')
      .select('event_request_id, attendee_id, status, event_requests!inner(id, event_name)')
      .eq('attendee_id', attendeeId)
      .eq('status', REGISTERED)
      .order('registered_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    checkReadError(error);
    const page = data ?? [];
    for (const row of page) {
      if (row.attendee_id === attendeeId && row.status === REGISTERED
          && row.event_request_id && row.event_requests?.id === row.event_request_id) {
        events.push({ eventRequestId: row.event_request_id, eventName: row.event_requests.event_name });
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return events;
}
