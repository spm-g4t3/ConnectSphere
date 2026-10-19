import {
  validateRegistrationIdentity, translateRegistrationEligibilityError,
} from './registrationEligibilityService.js';

/**
 * attendeeId must come from requireAuth's req.user.id in an Attendee-only route.
 * One RPC revalidates eligibility, locks the event, checks capacity and inserts;
 * a separate eligibility preflight must never authorise an independent insert.
 */
export async function registerForEvent({ attendeeId, eventId, client } = {}) {
  validateRegistrationIdentity({ attendeeId, eventId });
  const db = client ?? (await import('../config/supabaseClient.js')).supabase;
  const { data, error } = await db.rpc('register_for_event', {
    p_event_request_id: eventId,
    p_attendee_id: attendeeId,
  });
  if (error) throw translateRegistrationEligibilityError(error);
  const refusal = {
    not_found: { code: 'P0002' },
    event_not_confirmed: { code: 'P0002' },
    registration_closed: { code: 'P0002' },
    forbidden: { code: '42501', message: 'This action is restricted to Attendees' },
    capacity_reached: { code: '55000', hint: 'EVENT_FULL', message: 'Event is full' },
    already_registered: { code: '55000', hint: 'ALREADY_REGISTERED', message: 'Already registered' },
    already_waitlisted: { code: '55000', hint: 'ALREADY_WAITLISTED', message: 'Already on the waiting list' },
    registration_cancelled: { code: '55000', hint: 'REGISTRATION_CANCELLED', message: 'This registration was cancelled and cannot be reactivated.' },
  };
  if (Object.hasOwn(refusal, data?.outcome)) throw translateRegistrationEligibilityError(refusal[data.outcome]);
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
