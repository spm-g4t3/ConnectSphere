/**
 * User role vocabulary.
 *
 * The database (the user_role enum: 007_user_roles.sql, then 039) decides which
 * roles are *storable*. This module decides what they are *called* in code, so
 * a route gates on ROLE.VENUE_STAFF rather than on a string literal that a typo
 * would turn into a silently open endpoint.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/eventRequestStatus.js.
 *
 * Not part of SCRUM-15: this is a shared authorisation dependency that the
 * Coordinator stories and SCRUM-45 will need too. It has its own ticket.
 */


/**
 * The seven roles, spelled exactly as the Postgres enum `user_role`.
 *
 * Five from 007, and two from 039 (SCRUM-485): the Event Coordinator Lead and
 * the Safety Officer. These lists must stay identical. If they drift, the
 * database rejects the write at runtime -- so a test asserts the match, against
 * every migration that adds a role, rather than leaving it to whoever edits one
 * file to remember the other.
 *
 * Not listed: technical_support. It is in the live enum, from before 007, but
 * no profile uses it; every Technical Support user holds
 * technical_support_staff. 039's header records why it stays in the enum.
 */
export const ROLE = Object.freeze({
  EVENT_ORGANISER: 'event_organiser',
  EVENT_COORDINATOR: 'event_coordinator',
  VENUE_STAFF: 'venue_staff',
  TECHNICAL_SUPPORT_STAFF: 'technical_support_staff',
  ATTENDEE: 'attendee',
  // SCRUM-485. Neither inherits anything from EVENT_COORDINATOR: every gate
  // compares the whole value, so a Lead passes no coordinator gate until a
  // later story grants it one.
  EVENT_COORDINATOR_LEAD: 'event_coordinator_lead',
  SAFETY_OFFICER: 'safety_officer',
});


/**
 * What each role is called when a person has to read it.
 *
 * Used in the 403 a caller sees when they lack the role -- "This action is
 * restricted to Venue Staff" is actionable in a way that the raw enum value
 * is not.
 */
export const ROLE_LABEL = Object.freeze({
  [ROLE.EVENT_ORGANISER]: 'Event Organisers',
  [ROLE.EVENT_COORDINATOR]: 'Event Coordinators',
  [ROLE.VENUE_STAFF]: 'Venue Staff',
  [ROLE.TECHNICAL_SUPPORT_STAFF]: 'Technical Support Staff',
  [ROLE.ATTENDEE]: 'Attendees',
  // AC1 asks for the exact names, "Event Coordinator Lead" and "Safety
  // Officer". These are those names in the label form: plural, like
  // 'Event Coordinators', because the label's one use is the 403 message
  // "This action is restricted to ...", which names a group of people.
  [ROLE.EVENT_COORDINATOR_LEAD]: 'Event Coordinator Leads',
  [ROLE.SAFETY_OFFICER]: 'Safety Officers',
});


/**
 * Is this a role the system actually knows?
 *
 * Object.hasOwn rather than a plain lookup: ROLE_LABEL['constructor'] would
 * otherwise find an inherited property and report true, which on an
 * authorisation path is the dangerous direction to be wrong in.
 *
 * @param {string} role
 * @returns {boolean}
 */
export function isKnownRole(role) {
  return Object.hasOwn(ROLE_LABEL, role);
}


/**
 * The human-readable name of a role, for a message shown to a caller.
 *
 * Falls back to a neutral phrase rather than echoing an unrecognised value
 * back into the response body.
 *
 * @param {string} role
 * @returns {string}
 */
export function roleLabel(role) {
  return isKnownRole(role) ? ROLE_LABEL[role] : 'another role';
}
