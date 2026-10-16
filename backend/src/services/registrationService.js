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
  if (data?.outcome !== 'registered' || !data.registration?.id) {
    throw new Error('Unexpected outcome from register_for_event');
  }

  const row = data.registration;
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    attendeeId: row.attendee_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
