/**
 * Registration notification vocabulary (SCRUM-177): the types, audiences and
 * causes notify_registration_change accepts (migration 039). A test asserts
 * the types are in notifications_type_known and the writer agrees on the rest.
 *
 * registration_promoted (037) is the waiting-list status change and keeps its
 * own writer, promote_waitlisted_registrations.
 *
 * Deliberately free of imports, database calls and framework code, the same
 * shape as domain/registrationStatus.js.
 */

export const REGISTRATION_NOTIFICATION_TYPE = Object.freeze({
  OPENED: 'registration_opened',
  CLOSED: 'registration_closed',
  CAPACITY_REACHED: 'registration_capacity_reached',
  PLACE_RELEASED: 'registration_place_released',
  PROMOTED: 'registration_promoted',
});

export const REGISTRATION_NOTIFICATION_AUDIENCE = Object.freeze({
  ORGANISER: 'organiser',
  COORDINATOR: 'coordinator',
  WAITLISTED: 'waitlisted',
});

const { ORGANISER, COORDINATOR, WAITLISTED } = REGISTRATION_NOTIFICATION_AUDIENCE;
const T = REGISTRATION_NOTIFICATION_TYPE;

// Who may receive each type written by notify_registration_change. Capacity and
// availability are staff matters; attendees only hear about their queue.
export const AUDIENCES_BY_TYPE = Object.freeze({
  [T.OPENED]: Object.freeze([ORGANISER, COORDINATOR, WAITLISTED]),
  [T.CLOSED]: Object.freeze([ORGANISER, COORDINATOR, WAITLISTED]),
  [T.CAPACITY_REACHED]: Object.freeze([ORGANISER, COORDINATOR]),
  [T.PLACE_RELEASED]: Object.freeze([ORGANISER, COORDINATOR]),
});

export const CAUSES_BY_TYPE = Object.freeze({
  [T.OPENED]: Object.freeze(['opening_time', 'settings_changed', 'event_confirmed']),
  [T.CLOSED]: Object.freeze(['closing_time', 'switched_off', 'event_started', 'event_not_confirmed']),
  [T.PLACE_RELEASED]: Object.freeze(['withdrawal']),
});
