/**
 * Open events service.
 *
 * SCRUM-495: the events an Attendee can currently register for, with how many
 * places each has left and whether this Attendee is already registered.
 *
 * Read-only. It never writes a registration. Full events stay in the list;
 * they are marked, not removed.
 *
 * An event is listed when its status is Confirmed, registration is on, the
 * registration window is open now and the event has not started. The rule
 * itself is domain/registrationWindow.js. It is applied twice on purpose: as
 * filters in the query, so the database does the work, and again over what
 * came back, so a row the query should not have returned (a changed filter, a
 * misbehaving client) still never reaches a caller.
 *
 * Nothing is cached. `now` is read on every call and the settings, status and
 * registrations are read from the tables each time, so an event whose
 * registration was switched off, closed, or sent back to Approved (SCRUM-395)
 * drops out of the next response, and a place freed by a withdrawal shows up.
 *
 * Availability is advisory. SCRUM-22 stays the authority on capacity and
 * duplicates, under a lock, at the moment of registering.
 *
 * Registrations are read in ONE query for every listed event, not one per
 * event. That query returns each active registration's event and attendee so
 * this module can count them and spot the caller's own; the attendee ids are
 * used for that and then dropped. Only counts and the caller's own state leave
 * here, never another attendee's identity or record. The caller is the
 * attendeeId passed in, which the route takes from the verified token. A
 * database aggregate would move the counting off this process, but needs a
 * migration, which belongs to SCRUM-22.
 *
 * Assumptions, none of which exists in the schema yet:
 *  - SCRUM-494 stores its settings on event_requests as registration_enabled,
 *    registration_opens_at, registration_closes_at and registration_capacity
 *    (null capacity means no limit).
 *  - SCRUM-22 stores registrations in a `registrations` table with
 *    event_request_id, attendee_id and status; domain/registrationAvailability.js
 *    says which statuses hold a place.
 * This fails against a real database until those exist. If they are named
 * differently, change SETTINGS_COLUMNS, REGISTRATION_COLUMNS and the filters
 * below.
 *
 * What leaves this module is decided by toOpenEvent, an explicit allowlist.
 * The query also selects only the columns it needs, and never the venue,
 * requirement, coordinator, clarification or decision columns. Selecting a
 * column and mapping it are separate steps so that adding a column to the
 * table can never add it to the response.
 *
 * No authorisation here, as in eventRequestService: the route proves the
 * caller is an Attendee.
 */
import { STATUS } from '../domain/eventRequestStatus.js';
import { isOpenForRegistration } from '../domain/registrationWindow.js';
import { availability, holdsAPlace, ACTIVE_REGISTRATION_STATUS } from '../domain/registrationAvailability.js';
import { ValidationError, NotFoundError } from '../errors.js';
// The repository's one uuid check, a pure module, so this service stays loadable
// without credentials.
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

const SETTINGS_COLUMNS = `
  registration_enabled, registration_opens_at, registration_closes_at,
  registration_capacity
`;

// status is read only to re-check it; it is not part of the response.
const COLUMNS = `id, event_name, description, proposed_start, proposed_end, status, ${SETTINGS_COLUMNS}`;

// attendee_id is read only to count and to recognise the caller; it is never returned.
const REGISTRATION_COLUMNS = 'event_request_id, attendee_id, status';

async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/**
 * The only fields an Attendee is ever sent. Built field by field, never by
 * spreading the row.
 *
 * placesLeft is null for no limit and never negative. isFull and isRegistered
 * are what the page labels "Full" and "Registered"; canRegister is whether the
 * Register action should be offered (advisory, see the file header).
 */
function toOpenEvent(row, activeCount, isRegistered) {
  const { placesLeft, isFull } = availability(row.registration_capacity, activeCount);

  return {
    id: row.id,
    eventName: row.event_name,
    description: row.description,
    startsAt: row.proposed_start,
    endsAt: row.proposed_end,
    capacity: row.registration_capacity,
    placesLeft,
    isFull,
    isRegistered,
    canRegister: !isFull && !isRegistered,
  };
}

function toSettings(row) {
  return {
    status: row.status,
    registrationEnabled: row.registration_enabled,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    startsAt: row.proposed_start,
  };
}

/**
 * One pass over the registrations of the listed events: how many hold a place
 * per event, and which of them are the caller's. Other attendees' ids are
 * compared and discarded.
 */
function tally(registrations, attendeeId) {
  const counts = new Map();
  const mine = new Set();

  for (const registration of registrations) {
    if (!holdsAPlace(registration)) continue;

    const eventId = registration.event_request_id;
    counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
    if (registration.attendee_id === attendeeId) mine.add(eventId);
  }

  return { counts, mine };
}

function assertAttendee(attendeeId) {
  if (typeof attendeeId !== 'string' || attendeeId.trim() === '') {
    throw new ValidationError(
      'Invalid request -- attendeeId: is required',
      [{ field: 'attendeeId', message: 'is required' }],
    );
  }
}

/** The eligibility conditions, as filters on one query. Shared by the list and one event. */
function openEventsQuery(db, instant) {
  return db
    .from('event_requests')
    .select(COLUMNS)
    .eq('status', STATUS.CONFIRMED)
    .eq('registration_enabled', true)
    .lte('registration_opens_at', instant)
    .gt('registration_closes_at', instant)
    .gt('proposed_start', instant);
}

/**
 * Add availability and the caller's own state to eligible rows, reading every
 * event's registrations in one query.
 */
async function withRegistrationState(db, rows, attendeeId) {
  if (rows.length === 0) return [];

  const { data: registrations, error } = await db
    .from('registrations')
    .select(REGISTRATION_COLUMNS)
    .in('event_request_id', rows.map((row) => row.id))
    .eq('status', ACTIVE_REGISTRATION_STATUS);

  if (error) throw error;

  const { counts, mine } = tally(registrations ?? [], attendeeId);

  return rows.map((row) => toOpenEvent(row, counts.get(row.id) ?? 0, mine.has(row.id)));
}

/**
 * Events open for registration right now, earliest start first.
 *
 * @param {object} options
 * @param {string} options.attendeeId  the caller, from the verified token
 * @param {object} [options.client]
 * @param {Date} [options.now]  the instant to judge by; tests pass one
 * @returns {Promise<object[]>} possibly empty, each with only id, eventName,
 *   description, startsAt, endsAt, capacity, placesLeft, isFull, isRegistered
 *   and canRegister
 * @throws {ValidationError} when no attendee was supplied, before any read
 */
export async function listOpenEvents({ attendeeId, client, now = new Date() } = {}) {
  assertAttendee(attendeeId);

  const db = await resolveClient(client);

  const { data, error } = await openEventsQuery(db, now.toISOString())
    .order('proposed_start', { ascending: true })
    .order('id', { ascending: true });

  // Untyped on purpose: the route logs it and answers a generic 500, so a
  // driver message never reaches the caller.
  if (error) throw error;

  const events = (data ?? []).filter((row) => isOpenForRegistration(toSettings(row), now));

  return withRegistrationState(db, events, attendeeId);
}

/**
 * One open event, for the details page: the same eligibility rule as the
 * list, judged afresh at this instant, with the same fields.
 *
 * An event that does not exist and one that is not open (not Confirmed,
 * registration off, window closed, already started) are the same NotFoundError
 * with the same message, so this cannot be used to probe for events that are
 * not on offer. A malformed id is answered the same way, without a read.
 *
 * This is the browse preview. It carries no venue and no internal planning
 * information, and it is not the registered-attendee view of SCRUM-24.
 *
 * @param {object} options
 * @param {string} options.attendeeId  the caller, from the verified token
 * @param {string} options.eventId
 * @param {object} [options.client]
 * @param {Date} [options.now]
 * @returns {Promise<object>} the same shape as one list entry
 * @throws {ValidationError} when no attendee was supplied
 * @throws {NotFoundError}   when the event is not open for registration
 */
export async function getOpenEvent({ attendeeId, eventId, client, now = new Date() } = {}) {
  assertAttendee(attendeeId);

  const notOpen = () => new NotFoundError('This event is not open for registration');
  if (typeof eventId !== 'string' || !isPlausibleId(eventId)) throw notOpen();

  const db = await resolveClient(client);

  const { data, error } = await openEventsQuery(db, now.toISOString()).eq('id', eventId);

  if (error) throw error;

  const rows = (data ?? []).filter(
    (row) => row.id === eventId && isOpenForRegistration(toSettings(row), now),
  );
  if (rows.length === 0) throw notOpen();

  const [event] = await withRegistrationState(db, rows, attendeeId);
  return event;
}