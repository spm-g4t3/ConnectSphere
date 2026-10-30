/**
 * SCRUM-383 (SCRUM-379 AC7): what puts an event on a coordinator's Needs attention list.
 *
 * Pure: nothing here reads the database or the clock. The caller passes the
 * time, so every rule below can be tested at an exact instant. The list itself
 * is built by listNeedsAttention in services/eventRequestService.js.
 *
 * The sources, and what is not built yet:
 *
 *  - MARK_COMPLETED: a Confirmed event that has ended.
 *  - NOT_CONFIRMED: an Approved event that has ended without being confirmed.
 *  - CLARIFICATION_OVERDUE: an event waiting on the Organiser's clarification
 *    reply, past its reply-by date. NOT BUILT AS A FLAG: SCRUM-162 stores the
 *    reply-by date (event_requests.clarification_reply_by_date) but no overdue
 *    flag, so "overdue" is worked out here from that date.
 *  - VENUE_NOT_READY, EQUIPMENT_NOT_READY: a Confirmed event that no longer
 *    passes SCRUM-363's readiness check, one reason per failing item.
 *  - EQUIPMENT_FLAGGED: a Confirmed event holding a flagged, unreleased
 *    equipment reservation (SCRUM-315); its wording lives with the service.
 *
 * Not on the list, because AC7 does not name them: an event still in the safety
 * check (safety_review, safety_approved) whose end has passed. See
 * docs/SCRUM-383.md.
 */

import { singaporeToday } from '../validation/timestampValidation.js';

export const NEEDS_ATTENTION_CODE = Object.freeze({
  MARK_COMPLETED: 'MARK_COMPLETED',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  CLARIFICATION_OVERDUE: 'CLARIFICATION_OVERDUE',
  VENUE_NOT_READY: 'VENUE_NOT_READY',
  EQUIPMENT_NOT_READY: 'EQUIPMENT_NOT_READY',
  EQUIPMENT_FLAGGED: 'EQUIPMENT_FLAGGED',
});

/** The order reasons are listed in for one event. */
export const NEEDS_ATTENTION_ORDER = Object.freeze([
  NEEDS_ATTENTION_CODE.MARK_COMPLETED,
  NEEDS_ATTENTION_CODE.NOT_CONFIRMED,
  NEEDS_ATTENTION_CODE.CLARIFICATION_OVERDUE,
  NEEDS_ATTENTION_CODE.VENUE_NOT_READY,
  NEEDS_ATTENTION_CODE.EQUIPMENT_NOT_READY,
  NEEDS_ATTENTION_CODE.EQUIPMENT_FLAGGED,
]);

export const MARK_COMPLETED_REASON = 'Mark as completed';
export const NOT_CONFIRMED_REASON = 'Not confirmed; cancel';

/**
 * Has the event ended at `now`? True from the instant of its end: the same
 * moment complete_event_request starts to accept it, so an event is on the list
 * exactly when it can be completed. No end time means it has not ended.
 *
 * @param {string|Date|null|undefined} proposedEnd
 * @param {Date} now
 * @returns {boolean}
 */
export function eventHasEnded(proposedEnd, now) {
  if (proposedEnd == null) return false;
  const end = proposedEnd instanceof Date ? proposedEnd.getTime() : Date.parse(proposedEnd);
  return Number.isFinite(end) && end <= now.getTime();
}

/** A date column as 'YYYY-MM-DD', whether it arrived as that text or as a Date at UTC midnight. */
export function dateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : null;
}

/**
 * Is a clarification reply late at `now`? It is late once the reply-by date has
 * passed in Singapore: on the reply-by date itself the Organiser still has the
 * day. No reply-by date means there is no deadline to miss.
 *
 * @param {string|Date|null|undefined} replyByDate
 * @param {Date} now
 * @returns {boolean}
 */
export function clarificationIsOverdue(replyByDate, now) {
  const due = dateOnly(replyByDate);
  return due !== null && due < singaporeToday(now);
}

export function clarificationOverdueReason(replyByDate) {
  return `Clarification overdue: reply was due ${dateOnly(replyByDate)}`;
}

/**
 * The words for a venue readiness item that is not met. `detail` is the
 * readiness function's own wording.
 */
export function venueReadinessReason(detail) {
  if (detail === 'No venue booking') return 'No valid venue booking';
  if (detail === 'Flagged for review') return 'Venue booking flagged for review';
  return `Venue booking: ${detail}`;
}

export function equipmentReadinessReason(detail) {
  return `Equipment request: ${detail}`;
}

/**
 * Order two list items: the earlier event first, an event with no start last, then by
 * event id so the order never depends on how the database returned the rows, and then
 * the order reasons are listed in for one event.
 */
export function compareNeedsAttentionItems(a, b) {
  const startOf = (item) => (item.proposedStart == null ? Number.POSITIVE_INFINITY : Date.parse(item.proposedStart));
  const byStart = Math.sign(startOf(a) - startOf(b));
  if (byStart !== 0 && !Number.isNaN(byStart)) return byStart;
  if (a.eventRequestId !== b.eventRequestId) return a.eventRequestId < b.eventRequestId ? -1 : 1;
  return NEEDS_ATTENTION_ORDER.indexOf(a.code) - NEEDS_ATTENTION_ORDER.indexOf(b.code);
}
