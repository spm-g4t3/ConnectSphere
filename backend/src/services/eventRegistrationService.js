import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';
import { getStatusDisplay } from '../domain/eventRequestStatus.js';
import { REGISTRATION_CONFIGURABLE_STATUSES } from '../domain/registrationStatuses.js';

function displayStatus(status) {
  return getStatusDisplay(status).label;
}

function statusConflict(status) {
  const allowed = REGISTRATION_CONFIGURABLE_STATUSES.map(displayStatus);
  const list = `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  return new ConflictError(
    `Registration can only be set up while the event is ${list}. Current status: ${displayStatus(status)}.`,
  );
}

async function resolveClient(client) {
  if (client) return client;
  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

function requireId(id, field = 'eventRequestId') {
  if (!isPlausibleId(id)) {
    throw new ValidationError(`${field} must be a valid UUID`, [{ field, message: 'Must be a valid UUID.' }]);
  }
}

function parseDate(value, field, details, { optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: 'Enter a valid date and time.' });
    return null;
  }
  return new Date(value).toISOString();
}

function normalizeSettings(input) {
  const details = [];
  if (input.enabled !== null && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    details.push({ field: 'registrationEnabled', message: 'Must be true or false.' });
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
    capacity = Number(input.capacity);
    if (!Number.isInteger(capacity)) {
      details.push({
        field: 'registrationCapacity',
        message: 'Must be a whole number.',
      });
    }
  }

  if (details.length) {
    throw new ValidationError('Registration settings are invalid.', details);
  }

  return { enabled: input.enabled ?? null, opensAt, closesAt, capacity, withdrawalDeadline };
}

function toSettings(result, registeredCount) {
  return {
    enabled: result.enabled,
    opensAt: result.opensAt,
    closesAt: result.closesAt,
    capacity: result.capacity,
    withdrawalDeadline: result.withdrawalDeadline,
    registeredCount,
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
  return toSettings(result.settings, result.registeredCount);
}

export async function getRegistrationSettings(eventRequestId, userId, { client } = {}) {
  requireId(eventRequestId);
  const db = await resolveClient(client);
  const { data: event, error } = await db
    .from('event_requests')
    .select('id, organiser_id, event_name, status, proposed_start, registration_enabled, registration_opens_at, registration_closes_at, registration_capacity, registration_withdrawal_deadline')
    .eq('id', eventRequestId)
    .maybeSingle();
  if (error) throw error;
  if (!event) throw new NotFoundError('Event not found.');
  if (event.organiser_id !== userId) {
    throw new ForbiddenError('Only the Event Organiser who created this event can view its registration settings.');
  }
  const { count, error: countError } = await db
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_request_id', eventRequestId)
    .eq('status', 'registered');
  if (countError) throw countError;
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
      registeredCount: count ?? 0,
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
  });
  if (rpcError) {
    if (rpcError.code === '42501') {
      throw new ForbiddenError('Only the Event Organiser who created this event can set up its registration.');
    }
    throw rpcError;
  }
  return mapSetupOutcome(data);
}
