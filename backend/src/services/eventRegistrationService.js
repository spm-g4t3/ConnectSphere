import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../errors.js';
import { SCHEMA_MISSING_CODES } from '../http/pgErrors.js';
import { resolveClient } from '../config/resolveClient.js';
import { isPlausibleId } from '../validation/ids.js';
import { getStatusDisplay, getOrganiserStatusLabel } from '../domain/eventRequestStatus.js';
import { MAX_INTEGER } from '../validation/limits.js';
import { checkTimestamp } from '../validation/timestampValidation.js';
import { REGISTRATION_CONFIGURABLE_STATUSES } from '../domain/registrationStatuses.js';
import { REGISTRATION_STATUS } from '../domain/registrationStatus.js';

// registration_capacity is a Postgres integer.
const MAX_CAPACITY = MAX_INTEGER;

function statusConflict(status) {
  const allowed = REGISTRATION_CONFIGURABLE_STATUSES.map(getOrganiserStatusLabel);
  const list = `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  return new ConflictError(
    `Registration can only be set up while the event is ${list}. Current status: ${getOrganiserStatusLabel(status)}.`,
  );
}

function requireId(id, field = 'eventRequestId') {
  if (!isPlausibleId(id)) {
    throw new ValidationError(`${field} must be a valid UUID`, [{ field, message: 'Must be a valid UUID.' }]);
  }
}

// checkTimestamp requires an explicit offset, so an offset-less time is refused
// instead of being read in the server's time zone. Its wording is replaced to
// keep this service's sentence-style messages.
function parseDate(value, field, details, { optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const instant = checkTimestamp({ add() {} }, field, value);
  if (instant === null) {
    details.push({ field, message: 'Enter a valid date and time.' });
    return null;
  }
  return instant.toISOString();
}

function normalizeSettings(input) {
  const details = [];
  if (input.enabled !== null && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    details.push({ field: 'registrationEnabled', message: 'Must be true or false.' });
  }
  // Left out, the saved value stays (setup_event_registration reads null so).
  if (input.waitlistEnabled !== null && input.waitlistEnabled !== undefined
      && typeof input.waitlistEnabled !== 'boolean') {
    details.push({ field: 'registrationWaitlistEnabled', message: 'Must be true or false.' });
  }
  const opensAt = parseDate(input.opensAt, 'registrationOpensAt', details, { optional: true });
  const closesAt = parseDate(input.closesAt, 'registrationClosesAt', details, { optional: true });
  const withdrawalDeadline = parseDate(
    input.withdrawalDeadline,
    'registrationWithdrawalDeadline',
    details,
    { optional: true },
  );

  let capacity = null;
  if (input.capacity !== null && input.capacity !== undefined && input.capacity !== '') {
    // Number() would turn true, [5], '1e2' and '  ' into numbers, so only a
    // number or a string of digits counts.
    const raw = input.capacity;
    if (typeof raw === 'number') capacity = raw;
    else if (typeof raw === 'string' && /^-?\d+$/.test(raw)) capacity = Number(raw);
    else capacity = Number.NaN;

    let message = null;
    if (!Number.isInteger(capacity)) message = 'Must be a whole number.';
    else if (capacity < 1) message = 'Must be a whole number above zero.';
    else if (capacity > MAX_CAPACITY) message = `Must be ${MAX_CAPACITY} or fewer.`;
    if (message) details.push({ field: 'registrationCapacity', message });
  }

  if (details.length) {
    throw new ValidationError('Registration settings are invalid.', details);
  }

  return {
    enabled: input.enabled ?? null, opensAt, closesAt, capacity, withdrawalDeadline,
    waitlistEnabled: input.waitlistEnabled ?? null,
  };
}

function toSettings(result, registeredCount, waitlistCount) {
  return {
    enabled: result.enabled,
    opensAt: result.opensAt,
    closesAt: result.closesAt,
    capacity: result.capacity,
    withdrawalDeadline: result.withdrawalDeadline,
    waitlistEnabled: result.waitlistEnabled,
    registeredCount,
    waitlistCount,
  };
}

function mapSetupOutcome(result) {
  if (result.outcome === 'not_found') throw new NotFoundError('Event not found.');
  if (result.outcome === 'forbidden') {
    throw new ForbiddenError('Only the Event Organiser who created this event can set up its registration.');
  }
  if (result.outcome === 'status_not_allowed') {
    throw statusConflict(result.status);
  }
  if (result.outcome === 'invalid') {
    throw new ValidationError('Registration settings are invalid.', result.details);
  }
  if (result.outcome !== 'saved') {
    throw new Error(`Unexpected setup_event_registration outcome: ${result.outcome}`);
  }
  return toSettings(result.settings, result.registeredCount, result.waitlistCount);
}

export async function getRegistrationSettings(eventRequestId, userId, { client } = {}) {
  requireId(eventRequestId);
  const db = await resolveClient(client);
  const { data: event, error } = await db
    .from('event_requests')
    .select('id, organiser_id, event_name, status, proposed_start, registration_enabled, registration_opens_at, registration_closes_at, registration_capacity, registration_withdrawal_deadline, registration_waitlist_enabled')
    .eq('id', eventRequestId)
    .maybeSingle();
  if (error) throw error;
  if (!event) throw new NotFoundError('Event not found.');
  if (event.organiser_id !== userId) {
    throw new ForbiddenError('Only the Event Organiser who created this event can view its registration settings.');
  }
  const countStatus = async (status) => {
    const { count, error: countError } = await db
      .from('event_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('event_request_id', eventRequestId)
      .eq('status', status);
    if (countError) throw countError;
    return count ?? 0;
  };
  const registeredCount = await countStatus(REGISTRATION_STATUS.REGISTERED);
  const waitlistCount = await countStatus(REGISTRATION_STATUS.WAITLISTED);
  return {
    id: event.id,
    eventName: event.event_name,
    status: event.status,
    statusDisplay: getStatusDisplay(event.status),
    proposedStart: event.proposed_start,
    settings: {
      enabled: event.registration_enabled,
      opensAt: event.registration_opens_at,
      closesAt: event.registration_closes_at,
      capacity: event.registration_capacity,
      withdrawalDeadline: event.registration_withdrawal_deadline,
      waitlistEnabled: event.registration_waitlist_enabled ?? false,
      registeredCount,
      waitlistCount,
    },
  };
}

export async function updateRegistrationSettings(eventRequestId, input, userId, { client } = {}) {
  requireId(eventRequestId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Registration settings must be an object.');
  }
  const settings = normalizeSettings(input);
  const db = await resolveClient(client);

  const { data, error: rpcError } = await db.rpc('setup_event_registration', {
    p_event_request_id: eventRequestId,
    p_user_id: userId,
    p_enabled: settings.enabled,
    p_opens_at: settings.opensAt,
    p_closes_at: settings.closesAt,
    p_capacity: settings.capacity,
    p_withdrawal_deadline: settings.withdrawalDeadline,
    p_waitlist_enabled: settings.waitlistEnabled,
  });
  if (rpcError) throw rpcError;
  return mapSetupOutcome(data);
}

/**
 * Registered and waiting-list totals for the event's Organiser or assigned
 * Coordinator; event_registration_counts checks which one the caller is.
 */
export async function getRegistrationCounts(eventRequestId, userId, { client } = {}) {
  requireId(eventRequestId);
  const db = await resolveClient(client);
  const { data, error } = await db.rpc('event_registration_counts', {
    p_event_request_id: eventRequestId,
    p_user_id: userId,
  });
  if (error?.code === 'P0002') throw new NotFoundError('Event not found.');
  if (error?.code === '42501') throw new ForbiddenError(error.message);
  // An unapplied migration is an outage, as for the attendee registration reads.
  if (SCHEMA_MISSING_CODES.includes(error?.code)) {
    throw new ServiceUnavailableError('Registration numbers are temporarily unavailable. Please try again later.');
  }
  if (error) throw error;
  return {
    eventRequestId: data.eventRequestId,
    capacity: data.capacity,
    waitlistEnabled: data.waitlistEnabled,
    registeredCount: Number(data.registeredCount),
    waitlistCount: Number(data.waitlistCount),
  };
}
