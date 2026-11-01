import { ROLE } from '../domain/userRole.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { BOOKING_STATUS, BOOKED_STATUSES } from '../domain/bookingStatus.js';
import { UnauthorizedError, ForbiddenError, ValidationError, NotFoundError, ServiceUnavailableError } from '../errors.js';
import { SCHEMA_MISSING_CODES } from '../http/pgErrors.js';
import { resolveClientIfMissing } from '../config/resolveClient.js';
import { isPlausibleId } from '../validation/ids.js';
import { REGISTRATION_STATUS } from '../domain/registrationStatus.js';

const REGISTERED = REGISTRATION_STATUS.REGISTERED;
// PGRST200 too: these reads embed event_requests, bookings and venues, and a
// missing relationship between them is the schema's fault, not the caller's.
const SCHEMA_ERRORS = [...SCHEMA_MISSING_CODES, 'PGRST200'];
const PAGE_SIZE = 1000;

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

/**
 * The message the coordinator chose to give attendees when cancelling, or null.
 * A second read is safe: Cancelled is final, and the message is written once with
 * the cancellation, so it cannot change between the two reads.
 */
async function readCancellationMessage(db, eventId) {
  const { data, error } = await db.from('event_requests')
    .select('attendee_message')
    .eq('id', eventId)
    .maybeSingle();
  checkReadError(error);
  const message = typeof data?.attendee_message === 'string' ? data.attendee_message.trim() : '';
  return message === '' ? null : message;
}

/** user is supplied by requireAuth, never by request parameters or the body. */
export async function getAttendeeEvent({ user, eventRequestId, client } = {}) {
  const attendeeId = attendeeIdentity(user);
  validateId('eventRequestId', eventRequestId);
  const eventId = eventRequestId.trim().toLowerCase();
  const db = await resolveClientIfMissing(client);
  // Registration, event state and arrangements share one database snapshot;
  // a separate status check could disclose arrangements after a planning change.
  const { data, error } = await db.from('event_registrations')
    .select(`id, event_request_id, attendee_id, status,
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
  // SCRUM-434 AC5: a cancelled event shows the coordinator's optional message and
  // nothing else. The internal reason is never selected here.
  if (event.status === STATUS.CANCELLED) {
    return {
      eventRequestId: data.event_request_id,
      registrationId: data.id,
      state: 'cancelled',
      eventName,
      message: await readCancellationMessage(db, eventId),
    };
  }
  if (event.status !== STATUS.CONFIRMED) {
    return { eventRequestId: data.event_request_id, registrationId: data.id, state: 'unavailable', eventName };
  }

  // Explicit projections keep internal status, planning and staffing data private.
  return {
    eventRequestId: data.event_request_id,
    // What the attendee withdraws; withdraw_registration checks it is theirs.
    registrationId: data.id,
    state: 'confirmed',
    eventName,
    startsAt: event.proposed_start ?? null,
    endsAt: event.proposed_end ?? null,
    // A flagged booking is still the event's venue until someone resolves it;
    // attendees see that it is under review, never why.
    venues: (event.bookings ?? [])
      .filter(booking => BOOKED_STATUSES.includes(booking.status))
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
  const db = await resolveClientIfMissing(client);
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

/** The caller's own waiting-list places, newest first, each with its position. */
export async function listAttendeeWaitlist({ user, client } = {}) {
  const attendeeId = attendeeIdentity(user);
  const db = await resolveClientIfMissing(client);
  const { data, error } = await db.rpc('list_attendee_waitlist', { p_attendee_id: attendeeId });
  if (error?.code === '42501') throw new ForbiddenError('This action is restricted to Attendees');
  checkReadError(error);
  return (data ?? []).map(row => ({
    registrationId: row.registration_id,
    eventRequestId: row.event_request_id,
    eventName: row.event_name ?? null,
    waitlistPosition: Number(row.waitlist_position),
    waitlistedAt: row.waitlisted_at,
    placesOffered: row.places_offered === true,
  }));
}
