import { NotFoundError, ValidationError } from '../errors.js';
import { resolveClient } from '../config/resolveClient.js';
import {
  createPgTranslator,
  forCodes,
  forbidden,
  conflict,
  invalid,
} from '../http/pgErrors.js';
import { UUID_PATTERN, requireCallerId } from '../validation/ids.js';

const OUTCOMES = new Set(['approved', 'changes_requested', 'rejected']);
export const SAFETY_REVIEW_NOT_ALLOWED = 'SAFETY_REVIEW_NOT_ALLOWED';

function validateEventId(id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new ValidationError('A valid event request id is required');
  }
}

const translateError = createPgTranslator({
  missingMessage: 'Unexpected database error',
  codes: {
    '42501': forbidden,
    P0002: (message) => new NotFoundError(message),
    '55000': conflict(SAFETY_REVIEW_NOT_ALLOWED),
    '40001': conflict('SAFETY_REVIEW_CHANGED'),
    ...forCodes(['22023', '23514', '22P02'], invalid),
  },
  fallback: (message) => new Error(message),
});

function validateResponse(input, safetyOfficerId) {
  if (typeof safetyOfficerId !== 'string' || !UUID_PATTERN.test(safetyOfficerId)) {
    throw new ValidationError('A signed-in Safety Officer is required');
  }
  if (!input || !OUTCOMES.has(input.outcome)) {
    throw new ValidationError('Choose approve, request changes or reject the safety arrangement');
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    throw new ValidationError('The safety review note must be text');
  }

  const note = typeof input.note === 'string' ? input.note.trim() : null;
  if (input.outcome !== 'approved' && !note) {
    throw new ValidationError('A note is required for this safety review response');
  }

  const affectedBookingIds = input.affectedBookingIds ?? [];
  if (
    !Array.isArray(affectedBookingIds) ||
    affectedBookingIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id)) ||
    new Set(affectedBookingIds).size !== affectedBookingIds.length
  ) {
    throw new ValidationError('Affected venue bookings must be a list of unique booking ids');
  }
  if (input.equipmentAffected !== undefined && typeof input.equipmentAffected !== 'boolean') {
    throw new ValidationError('equipmentAffected must be true or false');
  }
  const equipmentAffected = input.equipmentAffected ?? false;
  if (input.outcome === 'approved' && (affectedBookingIds.length > 0 || equipmentAffected)) {
    throw new ValidationError('Arrangements can be marked as affected only when requesting changes or rejecting');
  }

  return { outcome: input.outcome, note, affectedBookingIds, equipmentAffected };
}

async function callRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw translateError(error);
  return data;
}

// The reads take the caller because the functions check it is a Safety Officer.
export async function listSafetyReviews(callerId, { client } = {}) {
  requireCallerId(callerId, 'callerId');
  const db = await resolveClient(client);
  const rows = await callRpc(db, 'safety_review_queue', { p_caller: callerId });
  return Array.isArray(rows) ? rows : [];
}

export async function listSafetyReviewHistory(callerId, { client } = {}) {
  requireCallerId(callerId, 'callerId');
  const db = await resolveClient(client);
  const rows = await callRpc(db, 'safety_review_history', { p_caller: callerId });
  return Array.isArray(rows) ? rows : [];
}

export async function getSafetyReview(eventRequestId, callerId, { client } = {}) {
  validateEventId(eventRequestId);
  requireCallerId(callerId, 'callerId');
  const db = await resolveClient(client);
  return callRpc(db, 'safety_review_detail', { p_event_request_id: eventRequestId, p_caller: callerId });
}

export async function respondToSafetyReview(eventRequestId, input, safetyOfficerId, { client } = {}) {
  validateEventId(eventRequestId);
  const response = validateResponse(input, safetyOfficerId);
  const db = await resolveClient(client);

  return callRpc(db, 'respond_to_safety_review', {
    p_event_request_id: eventRequestId,
    p_safety_officer_id: safetyOfficerId,
    p_outcome: response.outcome,
    p_note: response.note,
    p_affected_booking_ids: response.affectedBookingIds,
    p_equipment_affected: response.equipmentAffected,
  });
}
