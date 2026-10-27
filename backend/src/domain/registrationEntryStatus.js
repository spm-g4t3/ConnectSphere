/**
 * What the organiser and coordinator see for each registration status in an
 * event's registration list. The keys are event_registrations_status_known's
 * values; 'cancelled' also covers a registration on a cancelled event.
 */
export const REGISTRATION_ENTRY_LABEL = Object.freeze({
  registered: 'Registered',
  withdrawn: 'Withdrawn',
  waitlisted: 'Waitlisted',
  cancelled: 'Event cancelled',
});

/** @param {string} status */
export function registrationEntryLabel(status) {
  return Object.hasOwn(REGISTRATION_ENTRY_LABEL, status) ? REGISTRATION_ENTRY_LABEL[status] : 'Unknown';
}
