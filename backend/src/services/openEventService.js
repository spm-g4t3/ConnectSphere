/**
 * The events an Attendee can register for now, with places left and the
 * caller's own registration. Read-only; full events stay listed, marked.
 *
 * Eligibility is domain/registrationWindow.js, applied as query filters and
 * again over the rows, so a row the query should not return never leaves here.
 * Nothing is cached. Only counts and the caller's own state leave; other
 * attendees' ids are used to count and dropped. toOpenEvent is an allowlist, so
 * a new column can never reach the response.
 *
 * Assumes SCRUM-494's settings on event_requests (registration_enabled,
 * registration_opens_at, registration_closes_at, registration_capacity; null
 * capacity is no limit) and SCRUM-22's `registrations` table. Neither is on dev
 * yet, so this fails against a real database until they are. No authorisation
 * here: the route proves the caller is an Attendee.
 */import { STATUS } from '../domain/eventRequestStatus.js';
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
  // Postgres compares uuids without regard to case, so a pasted upper-case id
  // must find the same event, and the check below must agree with it.
  const wanted = eventId.trim().toLowerCase();

  const { data, error } = await openEventsQuery(db, now.toISOString()).eq('id', wanted);

  if (error) throw error;

  const rows = (data ?? []).filter(
    (row) => row.id === wanted && isOpenForRegistration(toSettings(row), now),
  );
  if (rows.length === 0) throw notOpen();

  const [event] = await withRegistrationState(db, rows, attendeeId);
  return event;
}