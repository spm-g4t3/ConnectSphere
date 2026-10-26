import {
  validateRegistrationIdentity, translateRegistrationEligibilityError,
} from './registrationEligibilityService.js';
import { resolveClientIfMissing } from '../config/resolveClient.js';
import { REGISTRATION_STATUS } from '../domain/registrationStatus.js';

// The outcomes register_for_event and join_event_waitlist refuse with, as the
// errors translateRegistrationEligibilityError turns into HTTP answers.
const REFUSALS = {
  not_found: { code: 'P0002' },
  event_not_confirmed: { code: 'P0002' },
  registration_closed: { code: 'P0002' },
  forbidden: { code: '42501', message: 'This action is restricted to Attendees' },
  capacity_reached: { code: '55000', hint: 'EVENT_FULL', message: 'Event is full' },
  already_registered: { code: '55000', hint: 'ALREADY_REGISTERED', message: 'Already registered' },
  already_waitlisted: { code: '55000', hint: 'ALREADY_WAITLISTED', message: 'Already on the waiting list' },
  registration_cancelled: { code: '55000', hint: 'REGISTRATION_CANCELLED', message: 'This registration was cancelled and cannot be reactivated.' },
  waitlist_disabled: { code: '55000', hint: 'WAITLIST_DISABLED', message: 'Event is full and has no waiting list' },
};

/**
 * attendeeId must come from requireAuth's req.user.id in an Attendee-only route.
 * One RPC revalidates eligibility, locks the event, checks capacity and inserts;
 * a separate eligibility preflight must never authorise an independent insert.
 */
export async function registerForEvent({ attendeeId, eventId, client } = {}) {
  validateRegistrationIdentity({ attendeeId, eventId });
  const db = await resolveClientIfMissing(client);
  const { data, error } = await db.rpc('register_for_event', {
    p_event_request_id: eventId,
    p_attendee_id: attendeeId,
  });
  if (error) throw translateRegistrationEligibilityError(error);
  if (Object.hasOwn(REFUSALS, data?.outcome)) throw translateRegistrationEligibilityError(REFUSALS[data.outcome]);
  if (data?.outcome !== 'registered' || !data.registration?.id) {
    throw new Error('Unexpected outcome from register_for_event');
  }

  const row = data.registration;
  return {
    id: row.id,
    eventRequestId: row.eventRequestId ?? row.event_request_id,
    attendeeId: row.attendeeId ?? row.attendee_id,
    status: row.status ?? 'registered',
    createdAt: row.createdAt ?? row.created_at ?? row.registeredAt,
    updatedAt: row.updatedAt ?? row.updated_at ?? row.registeredAt,
    ...(row.registeredAt != null ? { registeredAt: row.registeredAt } : {}),
  };
}


/**
 * Joins a full event's waiting list. One RPC checks eligibility, locks the
 * event and decides: a free place registers the attendee as registerForEvent
 * would, a full event with a list queues them, and a repeat join returns the
 * entry already held. `created` is false only for that repeat.
 *
 * @returns {Promise<{ created: boolean, registration: object }>} registration
 *   carries the authoritative status and waitlistPosition (null when registered)
 */
export async function joinEventWaitlist({ attendeeId, eventId, client } = {}) {
  validateRegistrationIdentity({ attendeeId, eventId });
  const db = await resolveClientIfMissing(client);
  const { data, error } = await db.rpc('join_event_waitlist', {
    p_event_request_id: eventId,
    p_attendee_id: attendeeId,
  });
  if (error) throw translateRegistrationEligibilityError(error);
  if (Object.hasOwn(REFUSALS, data?.outcome)) throw translateRegistrationEligibilityError(REFUSALS[data.outcome]);

  const row = data?.registration;
  if (data?.outcome === 'registered' && row?.id) {
    return {
      created: true,
      registration: {
        id: row.id,
        eventRequestId: row.eventRequestId,
        attendeeId: row.attendeeId,
        status: REGISTRATION_STATUS.REGISTERED,
        waitlistPosition: null,
        registeredAt: row.registeredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  }
  if (data?.outcome !== 'waitlisted' || !row?.id || !Number.isInteger(row.waitlistPosition)
      || typeof data.created !== 'boolean') {
    throw new Error('Unexpected outcome from join_event_waitlist');
  }
  return {
    created: data.created,
    registration: {
      id: row.id,
      eventRequestId: row.eventRequestId,
      attendeeId: row.attendeeId,
      status: REGISTRATION_STATUS.WAITLISTED,
      waitlistPosition: row.waitlistPosition,
      waitlistedAt: row.waitlistedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}
