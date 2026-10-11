/**
 * Open events service.
 *
 * SCRUM-495: the events an Attendee can currently register for.
 *
 * Read-only. It never touches registrations, and it keeps full events in the
 * list: working out the places left, and marking a full or already-registered
 * event, is a later subtask. This only decides which events are listed.
 *
 * An event is listed when its status is Confirmed, registration is on, the
 * registration window is open now and the event has not started. The rule
 * itself is domain/registrationWindow.js. It is applied twice on purpose: as
 * filters in the query, so the database does the work, and again over what
 * came back, so a row the query should not have returned (a changed filter, a
 * misbehaving client) still never reaches a caller.
 *
 * Nothing is cached. `now` is read on every call and the settings and status
 * are read from the table each time, so an event whose registration was
 * switched off, closed, or sent back to Approved (SCRUM-395) drops out of the
 * next response.
 *
 * Assumption: SCRUM-494 stores its settings on event_requests as
 * registration_enabled, registration_opens_at, registration_closes_at and
 * registration_capacity (null capacity means no limit). None of those columns
 * exists yet, so this fails against a real database until SCRUM-494 adds them.
 * If it names them differently, change SETTINGS_COLUMNS and the filters below.
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

const SETTINGS_COLUMNS = `
  registration_enabled, registration_opens_at, registration_closes_at,
  registration_capacity
`;

// status is read only to re-check it; it is not part of the response.
const COLUMNS = `id, event_name, description, proposed_start, proposed_end, status, ${SETTINGS_COLUMNS}`;

async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/**
 * The only fields an Attendee is ever sent. Built field by field, never by
 * spreading the row.
 */
function toOpenEvent(row) {
  return {
    id: row.id,
    eventName: row.event_name,
    description: row.description,
    startsAt: row.proposed_start,
    endsAt: row.proposed_end,
    capacity: row.registration_capacity,
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
 * Events open for registration right now, earliest start first.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]  the instant to judge by; tests pass one
 * @returns {Promise<object[]>} possibly empty, each with only id, eventName,
 *   description, startsAt, endsAt and capacity
 */
export async function listOpenEvents({ client, now = new Date() } = {}) {
  const db = await resolveClient(client);
  const instant = now.toISOString();

  const { data, error } = await db
    .from('event_requests')
    .select(COLUMNS)
    .eq('status', STATUS.CONFIRMED)
    .eq('registration_enabled', true)
    .lte('registration_opens_at', instant)
    .gt('registration_closes_at', instant)
    .gt('proposed_start', instant)
    .order('proposed_start', { ascending: true })
    .order('id', { ascending: true });

  // Untyped on purpose: the route logs it and answers a generic 500, so a
  // driver message never reaches the caller.
  if (error) throw error;

  return (data ?? [])
    .filter((row) => isOpenForRegistration(toSettings(row), now))
    .map(toOpenEvent);
}
