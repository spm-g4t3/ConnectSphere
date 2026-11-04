// venueBlockValidation.js
//
// SCRUM-126 (part of SCRUM-17, AC1). The client-side half of the venue block
// rules, and the edit diff VenueBlockForm sends.
//
// The rules and their wording mirror validateCreateBlock in
// backend/src/validation/venueBlockValidation.js, so a Venue Staff member sees
// the same message whether the browser or the API caught the fault. The
// backend stays the authority: this exists so an obvious mistake is named
// before a round trip, not to replace the server's check.
//
// Two differences, both because this sees the raw form rather than the wire:
//
//   * Dates arrive as datetime-local values ("2026-06-01T09:00"), read as
//     device time -- the same reading toOffsetIsoString gives them when they
//     are sent. An offset ISO string is accepted too and means the same
//     instant, so a prefilled or pasted value is judged identically.
//   * `requireFutureEnd` can be switched off. An edit that leaves the end
//     alone must not be refused because time has passed since the block was
//     made; the form sets it only when the end actually changed.
//
// Lives here rather than in VenueBlockForm.jsx because react-refresh only
// allows a component module to export components.
//
// parseDateTime is exported for venueSearchValidation.js (SCRUM-130), so the
// search window and a block refuse exactly the same malformed dates.

import { toDatetimeLocalValue, toOffsetIsoString } from "./datetimeFormat";
import { VENUE_BLOCK_REASONS } from "./venueBlockReasons";
import { codePointLength } from "./venueSafetyFacts";

/** Mirrors venue_blocks_notes_length in 011 and NOTES_MAX_LENGTH in the backend. */
export const NOTES_MAX_LENGTH = 1000;

const REASON_CODES = new Set(VENUE_BLOCK_REASONS.map((r) => r.code));

const REASON_MESSAGE = `must be one of: ${VENUE_BLOCK_REASONS.map((r) => r.code).join(", ")}`;

/**
 * A datetime-local value, optionally with seconds and an offset. Anything
 * looser -- "2026", "June 1" -- is refused even though Date would guess at it.
 */
const DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Last day of the month, leap years included; month is 1-based. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse one date field, or return null.
 *
 * The day is checked arithmetically because Date rolls 30 February forward
 * to 2 March instead of refusing it -- the backend's checkTimestamp does the
 * same for the same reason.
 */
export function parseDateTime(text) {
  const match = DATETIME_PATTERN.exec(text);
  if (!match) return null;

  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) return null;

  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Check a block form's raw values.
 *
 * Collects every fault rather than stopping at the first, in the same
 * { field, message } shape as the backend's details[], so the form renders
 * client and server faults with one renderer. A past start is allowed.
 *
 * @param {object} values
 * @param {string} [values.startsAt]  datetime-local or offset ISO
 * @param {string} [values.endsAt]    datetime-local or offset ISO
 * @param {string} [values.reason]
 * @param {string|null} [values.notes]
 * @param {object} [options]
 * @param {Date} [options.now]               the instant to judge "future" against
 * @param {boolean} [options.requireFutureEnd] default true
 * @returns {{field: string, message: string}[]} empty when the values are fine
 */
export function validateBlockInput(values, { now = new Date(), requireFutureEnd = true } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const instants = {};

  for (const field of ["startsAt", "endsAt"]) {
    const text = typeof values?.[field] === "string" ? values[field].trim() : "";
    if (text === "") {
      add(field, "is required");
      continue;
    }
    const instant = parseDateTime(text);
    if (instant === null) {
      add(field, "must be a valid date and time");
      continue;
    }
    instants[field] = instant;
  }

  if (instants.startsAt && instants.endsAt && instants.endsAt <= instants.startsAt) {
    add("endsAt", "must be later than the start");
  }

  if (requireFutureEnd && instants.endsAt && instants.endsAt <= now) {
    add("endsAt", "must be in the future");
  }

  const reason = typeof values?.reason === "string" ? values.reason.trim() : "";
  if (reason === "") {
    add("reason", "is required");
  } else if (!REASON_CODES.has(reason)) {
    add("reason", REASON_MESSAGE);
  }

  const rawNotes = values?.notes;
  let notes = "";
  if (rawNotes !== undefined && rawNotes !== null) {
    if (typeof rawNotes !== "string") {
      add("notes", "must be text");
    } else {
      notes = rawNotes.trim();
      if (codePointLength(notes) > NOTES_MAX_LENGTH) {
        add("notes", `must be ${NOTES_MAX_LENGTH} characters or fewer`);
      }
    }
  }

  // Skipped when notes were not text, which has already been named.
  if (reason === "other" && notes === "" && (rawNotes == null || typeof rawNotes === "string")) {
    add("notes", "is required when the reason is other");
  }

  return errors;
}

/**
 * Only what the user changed, for an edit.
 *
 * Dates are compared at minute precision through toDatetimeLocalValue, which
 * is all a datetime-local input shows. A stored 09:00:30 prefills as 09:00,
 * and comparing the raw strings would report that as a change nobody made.
 * A changed date is sent as an offset ISO string, the wire's shape.
 *
 * Notes are compared trimmed, and cleared notes are sent as null -- the
 * explicit "remove the notes", distinct from leaving the key out.
 *
 * @param {{startsAt: string, endsAt: string, reason: string, notes: string}} form
 * @param {object} initialBlock  the block as the API returned it
 * @returns {object} possibly empty
 */
export function buildBlockChanges(form, initialBlock) {
  const changes = {};

  for (const field of ["startsAt", "endsAt"]) {
    if (form[field] !== toDatetimeLocalValue(initialBlock[field])) {
      changes[field] = toOffsetIsoString(form[field]) ?? null;
    }
  }

  if (form.reason !== initialBlock.reason) changes.reason = form.reason;

  const notes = (form.notes ?? "").trim();
  if (notes !== (initialBlock.notes ?? "").trim()) changes.notes = notes === "" ? null : notes;

  return changes;
}
