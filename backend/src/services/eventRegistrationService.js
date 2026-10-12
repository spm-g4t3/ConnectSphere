import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';

const CONFIGURABLE_STATUSES = new Set([
  'approved',
  'safety_review',
  'safety_approved',
  'confirmed',
]);

function displayStatus(status) {
  return {
    approved: 'Approved',
    safety_review: 'Safety review',
    safety_approved: 'Safety approved',
    confirmed: 'Confirmed',
  }[status] ?? status;
}

function statusConflict(status) {
  return new ConflictError(
    `Registration can only be set up while the event is Approved, Safety review, Safety approved or Confirmed. Current status: ${displayStatus(status)}.`,
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

function validateSettings(input, proposedStart, registeredCount) {
  const details = [];
  if (typeof input.enabled !== 'boolean') {
    details.push({ field: 'registrationEnabled', message: 'Choose whether registration is on or off.' });
  }
  const opensAt = parseDate(input.opensAt, 'registrationOpensAt', details);
  const closesAt = parseDate(input.closesAt, 'registrationClosesAt', details);
  const withdrawalDeadline = parseDate(
    input.withdrawalDeadline,
    'registrationWithdrawalDeadline',
    details,
    { optional: true },
  );

  if (opensAt && closesAt && Date.parse(opensAt) >= Date.parse(closesAt)) {
    details.push({
      field: 'registrationOpensAt',
      message: 'Must be before the closing date and time.',
    });
  }
  if (closesAt && !proposedStart) {
    details.push({
      field: 'proposedStart',
      message: 'Set the event start before setting the registration closing time.',
    });
  } else if (closesAt && Date.parse(closesAt) > Date.parse(proposedStart)) {
    details.push({
      field: 'registrationClosesAt',
      message: 'Must be no later than the event start.',
    });
  }
  if (withdrawalDeadline && !proposedStart) {
    details.push({
      field: 'proposedStart',
      message: 'Set the event start before setting the withdrawal deadline.',
    });
  } else if (withdrawalDeadline && Date.parse(withdrawalDeadline) > Date.parse(proposedStart)) {
    details.push({
      field: 'registrationWithdrawalDeadline',
      message: 'Must be no later than the event start.',
    });
  }

  let capacity = null;
  if (input.capacity !== null && input.capacity !== undefined && input.capacity !== '') {
    capacity = Number(input.capacity);
    if (!Number.isInteger(capacity) || capacity <= 0) {
      details.push({
        field: 'registrationCapacity',
        message: 'Must be a whole number above zero.',
      });
    } else if (capacity < registeredCount) {
      details.push({
        field: 'registrationCapacity',
        message: `Cannot be below the ${registeredCount} attendees already registered.`,
      });
    }
  }

  if (details.length) {
    throw new ValidationError('Registration settings are invalid.', details);
  }

  return { enabled: input.enabled, opensAt, closesAt, capacity, withdrawalDeadline };
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
    .eq('event_request_id', eventRequestId);
  if (countError) throw countError;
  return {
    id: event.id,
    eventName: event.event_name,
    status: event.status,
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
  const db = await resolveClient(client);
  const { data: event, error } = await db
    .from('event_requests')
    .select('id, organiser_id, status, proposed_start')
    .eq('id', eventRequestId)
    .maybeSingle();
  if (error) throw error;
  if (!event) throw new NotFoundError('Event not found.');
  if (event.organiser_id !== userId) {
    throw new ForbiddenError('Only the Event Organiser who created this event can set up its registration.');
  }
  if (!CONFIGURABLE_STATUSES.has(event.status)) {
    throw statusConflict(event.status);
  }
  const { count, error: countError } = await db
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_request_id', eventRequestId);
  if (countError) throw countError;
  const settings = validateSettings(input, event.proposed_start, count ?? 0);

  const { data, error: rpcError } = await db.rpc('setup_event_registration', {
    p_event_request_id: eventRequestId,
    p_user_id: userId,
    p_enabled: settings.enabled,
    p_opens_at: settings.opensAt,
    p_closes_at: settings.closesAt,
    p_capacity: settings.capacity,
    p_withdrawal_deadline: settings.withdrawalDeadline,
  });
  if (rpcError) throw rpcError;
  return mapSetupOutcome(data);
}

export async function listOpenRegistrationEvents(attendeeId, { client } = {}) {
  const db = await resolveClient(client);
  const { data, error } = await db.rpc('list_open_registration_events', {
    p_attendee_id: attendeeId,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('list_open_registration_events returned an invalid result.');
  return data.map((event) => ({
    id: event.id,
    eventName: event.event_name,
    description: event.description,
    startsAt: event.proposed_start,
    registrationOpensAt: event.registration_opens_at,
    registrationClosesAt: event.registration_closes_at,
    capacity: event.registration_capacity,
    registeredCount: event.registered_count,
    isRegistered: event.is_registered,
  }));
}

export async function registerForEvent(eventRequestId, attendeeId, { client } = {}) {
  requireId(eventRequestId);
  const db = await resolveClient(client);
  const { data, error } = await db.rpc('register_for_event', {
    p_event_request_id: eventRequestId,
    p_attendee_id: attendeeId,
  });
  if (error) throw error;
  switch (data?.outcome) {
    case 'registered':
      return data.registration;
    case 'not_found':
      throw new NotFoundError('Event not found.');
    case 'event_not_confirmed':
      throw new ConflictError(`Attendees can only register for a Confirmed event. Current status: ${data.status}.`);
    case 'registration_closed':
      throw new ConflictError('Registration is off or outside its registration window.');
    case 'capacity_reached':
      throw new ConflictError('Registration is full.');
    case 'already_registered':
      throw new ConflictError('You are already registered for this event.');
    default:
      throw new Error(`Unexpected register_for_event outcome: ${data?.outcome}`);
  }
}
