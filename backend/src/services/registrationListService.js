import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../errors.js';
import { SCHEMA_MISSING_CODES, createPgTranslator, forCodes } from '../http/pgErrors.js';
import { isPlausibleId } from '../validation/ids.js';
import { resolveClientIfMissing } from '../config/resolveClient.js';
import { getOrganiserStatusLabel } from '../domain/eventRequestStatus.js';
import { registrationEntryLabel } from '../domain/registrationEntryStatus.js';

const translateListError = createPgTranslator({
  codes: forCodes(SCHEMA_MISSING_CODES, () => new ServiceUnavailableError(
    'The registration list is temporarily unavailable. Please try again later.',
  )),
});

// A query string arrives as text, so only the two spellings a toggle sends count.
function parseHideWithdrawn(value) {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new ValidationError('hideWithdrawn must be true or false', [
    { field: 'hideWithdrawn', message: 'Must be true or false.' },
  ]);
}

function mapOutcome(data) {
  if (data?.outcome === 'not_found') throw new NotFoundError('Event not found.');
  if (data?.outcome === 'forbidden') {
    throw new ForbiddenError(
      "Only the event's assigned coordinator and the Event Organiser who created it can view its registrations.",
    );
  }
  if (data?.outcome === 'status_not_available') {
    throw new ConflictError(
      `Registrations can only be viewed once the event is Confirmed, Completed or Cancelled, or back in Planning after a significant change. Current status: ${getOrganiserStatusLabel(data.status)}.`,
      { code: 'REGISTRATION_LIST_NOT_AVAILABLE' },
    );
  }
  if (data?.outcome !== 'listed' || !Array.isArray(data.entries)) {
    throw new Error('Unexpected outcome from list_event_registrations');
  }
  return data;
}

const USERS_PER_PAGE = 1000;

// The admin API has no lookup by several ids, so page through the users and
// stop once every attendee is found: one call per 1,000 users, not per attendee.
async function emailsFor(db, attendeeIds) {
  const wanted = new Set(attendeeIds);
  const emails = new Map();
  for (let page = 1; wanted.size > 0; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) {
      throw new ServiceUnavailableError('Attendee emails are temporarily unavailable. Please try again later.');
    }
    for (const user of data.users) {
      if (wanted.delete(user.id)) emails.set(user.id, user.email ?? null);
    }
    if (data.users.length < USERS_PER_PAGE) break;
  }
  return emails;
}

/** userId must be requireAuth's req.user.id, never a request parameter. */
export async function listEventRegistrations({ eventRequestId, userId, hideWithdrawn, client } = {}) {
  if (!isPlausibleId(eventRequestId)) {
    throw new ValidationError('eventRequestId must be a valid UUID', [
      { field: 'eventRequestId', message: 'Must be a valid UUID.' },
    ]);
  }
  const hide = parseHideWithdrawn(hideWithdrawn);
  const db = await resolveClientIfMissing(client);
  const { data, error } = await db.rpc('list_event_registrations', {
    p_event_request_id: eventRequestId.trim().toLowerCase(),
    p_user_id: userId,
    p_hide_withdrawn: hide,
  });
  if (error) throw translateListError(error);
  const result = mapOutcome(data);
  const emails = result.entries.length
    ? await emailsFor(db, result.entries.map((entry) => entry.attendeeId))
    : new Map();

  return {
    event: result.event,
    counts: {
      registered: Number(result.registeredCount),
      waitlisted: Number(result.waitlistedCount),
      capacity: result.event.capacity ?? null,
    },
    hideWithdrawn: hide,
    entries: result.entries.map((entry) => ({
      id: entry.id,
      attendeeName: entry.attendeeName,
      attendeeEmail: emails.get(entry.attendeeId) ?? null,
      registeredAt: entry.registeredAt,
      waitlistedAt: entry.waitlistedAt ?? null,
      status: entry.status,
      statusLabel: registrationEntryLabel(entry.status),
    })),
  };
}
