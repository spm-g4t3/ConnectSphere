/**
 * The events an Attendee can register for now, with places left and their own
 * registration. Eligibility (registrationWindow.js) is applied as query filters
 * and again over the rows; toOpenEvent is an allowlist, so a new column can
 * never reach the response. Role checks are the route's and the SQL function's.
 */
import { STATUS } from '../domain/eventRequestStatus.js';
import { isOpenForRegistration } from '../domain/registrationWindow.js';
import { availability } from '../domain/registrationAvailability.js';
import { translateRegistrationEligibilityError } from './registrationEligibilityService.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../errors.js';
// The repository's one uuid check, a pure module, so this service stays loadable
// without credentials.
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

const SETTINGS_COLUMNS = `
  registration_enabled, registration_opens_at, registration_closes_at,
  registration_capacity
`;

// status is read only to re-check it; it is not part of the response.
const COLUMNS = `id, event_name, description, proposed_start, proposed_end, status, ${SETTINGS_COLUMNS}`;

const PAGE_SIZE = 1000;
// Below PostgREST's 1,000-row cap, with room to spare.
const RPC_BATCH = 500;

/** The function's own refusals (migrations/AGENTS.md): 42501 forbidden, 22023 bad input. */
function translateStateError(error) {
  if (error.code === '42501') return new ForbiddenError('Only an Attendee can browse open events');
  if (error.code === '22023') {
    return new ValidationError(
      'Invalid request -- attendeeId: is required',
      [{ field: 'attendeeId', message: 'is required' }],
    );
  }
  return translateRegistrationEligibilityError(error);
}

/** Table failures describe database state, not attendee eligibility. */
function translateEventReadError(error) {
  return ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)
    ? translateRegistrationEligibilityError(error)
    : error;
}

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
 * canJoinWaitlist and waitlistCount are placeholders so SCRUM-22 can add the
 * waiting list without changing this shape: there is none yet, so never
 * joinable and no count.
 */
function toOpenEvent(row, activeCount, isRegistered, registrationStatus) {
  const { placesLeft, isFull } = availability(row.registration_capacity, activeCount);

  return {
    id: row.id,
    eventName: row.event_name,
    description: row.description,
    startsAt: row.proposed_start,
    endsAt: row.proposed_end,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    capacity: row.registration_capacity,
    registeredCount: activeCount,
    placesLeft,
    isFull,
    isRegistered,
    canRegister: !isFull && !isRegistered && (registrationStatus == null || registrationStatus === 'withdrawn'),
    canJoinWaitlist: false,
    waitlistCount: null,
  };
}

function toBrowseEvent(event) {
  return {
    id: event.id,
    eventName: event.eventName,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    capacity: event.capacity,
    placesLeft: event.placesLeft,
    isFull: event.isFull,
    isRegistered: event.isRegistered,
    canRegister: event.canRegister,
    canJoinWaitlist: event.canJoinWaitlist,
    waitlistCount: event.waitlistCount,
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
    .gt('proposed_start', instant)
    // A null close time stays open until the Organiser closes registration by hand.
    .or(`registration_closes_at.is.null,registration_closes_at.gt.${instant}`);
}

/**
 * Add availability and the caller's own state to eligible rows. The database
 * counts, so no row limit can cut a count short. The call returns one row per
 * event, so it is made for at most RPC_BATCH ids at a time: more would let
 * PostgREST's 1,000-row cap drop events silently, and the ids travel in the
 * request body, not the URL.
 */
async function withRegistrationState(db, rows, attendeeId) {
  if (rows.length === 0) return [];

  const states = new Map();
  for (let from = 0; from < rows.length; from += RPC_BATCH) {
    const { data, error } = await db.rpc('open_event_registration_state', {
      p_event_ids: rows.slice(from, from + RPC_BATCH).map((row) => row.id),
      p_attendee_id: attendeeId,
    });

    if (error) throw translateStateError(error);

    for (const state of data ?? []) states.set(state.event_request_id, state);
  }

  return rows.map((row) => {
    const state = states.get(row.id);
    return toOpenEvent(row, Number(state?.active_count ?? 0), state?.is_registered === true, state?.registration_status);
  });
}

/**
 * Events open for registration right now, earliest start first.
 *
 * @param {object} options
 * @param {string} options.attendeeId  the caller, from the verified token
 * @param {object} [options.client]
 * @param {Date} [options.now]  the instant to judge by; tests pass one
 * @returns {Promise<object[]>} possibly empty, each with only id, eventName,
 *   description, startsAt, endsAt, registrationOpensAt, registrationClosesAt,
 *   capacity, registeredCount, placesLeft, isFull, isRegistered, canRegister,
 *   canJoinWaitlist and waitlistCount
 * @throws {ValidationError} when no attendee was supplied, before any read
 */
async function listOpenEventsWithRegistrationDetails({ attendeeId, client, now = new Date() } = {}) {
  assertAttendee(attendeeId);

  const db = await resolveClient(client);

  const instant = now.toISOString();
  const rows = [];

  // PostgREST caps a response at 1,000 rows and says nothing when it cuts one
  // off, so read page by page. The id tiebreak keeps the order stable between pages.
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await openEventsQuery(db, instant)
      .order('proposed_start', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    // Missing schema is a deployment issue; other driver failures stay untyped
    // so the route logs them and answers a generic 500.
    if (error) throw translateEventReadError(error);

    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const events = rows.filter((row) => isOpenForRegistration(toSettings(row), now));

  return withRegistrationState(db, events, attendeeId);
}

/**
 * Same eligibility and database state as Browse Open Events, with registration
 * window and active-count fields for the Attendee dashboard.
 */
export async function listOpenEventsForRegistration(options = {}) {
  return listOpenEventsWithRegistrationDetails(options);
}

export async function listOpenEvents(options = {}) {
  const events = await listOpenEventsWithRegistrationDetails(options);
  return events.map(toBrowseEvent);
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

  if (error) throw translateEventReadError(error);

  const rows = (data ?? []).filter(
    (row) => row.id === wanted && isOpenForRegistration(toSettings(row), now),
  );
  if (rows.length === 0) throw notOpen();

  const [event] = await withRegistrationState(db, rows, attendeeId);
  return toBrowseEvent(event);
}
