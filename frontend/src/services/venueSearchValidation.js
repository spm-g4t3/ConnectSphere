// venueSearchValidation.js
//
// SCRUM-130 (part of SCRUM-17, AC2). The client-side half of the optional
// date window on venue search: "the blocked period is excluded from venue
// search results".
//
// The rules and wording mirror checkTimeWindow in
// backend/src/validation/timestampValidation.js, as validateSearchFilters
// applies it to startsAt/endsAt. A malformed date reads "must be a valid date
// and time", as it does on the block form, rather than the backend's more
// technical offset messages: the input here never lacks an offset. The
// backend stays the authority; this names an obvious mistake before a round
// trip.
//
// Both or neither: a blank window means "search as before", and a one-sided
// one is refused on the missing field. There is deliberately no future rule
// -- a past window is a legitimate question to ask -- and no length cap,
// because how long an event may run is SCRUM-20's rule, not search's.
//
// Dates are datetime-local values read as device time, the same reading
// toOffsetIsoString gives them on the way out.

import { toOffsetIsoString } from "./datetimeFormat";
import { parseDateTime } from "./venueBlockValidation";

/** Trimmed text, or "" for anything that is not a string. Blank means not given. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Check a search window's raw values.
 *
 * Collects every fault in the backend's { field, message } details[] shape,
 * so VenueSearch renders client and server faults with one renderer.
 *
 * @param {{startsAt?: string, endsAt?: string}} values  datetime-local or offset ISO
 * @returns {{field: string, message: string}[]} empty when the window is fine or absent
 */
export function validateSearchWindow({ startsAt, endsAt } = {}) {
  const start = text(startsAt);
  const end = text(endsAt);
  if (start === "" && end === "") return [];

  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (start === "") add("startsAt", "is required when an end is given");
  if (end === "") add("endsAt", "is required when a start is given");

  const startInstant = start === "" ? null : parseDateTime(start);
  const endInstant = end === "" ? null : parseDateTime(end);
  if (start !== "" && startInstant === null) add("startsAt", "must be a valid date and time");
  if (end !== "" && endInstant === null) add("endsAt", "must be a valid date and time");

  // Equal is refused too: the window is half-open, so [t, t) holds no time.
  if (startInstant && endInstant && endInstant <= startInstant) {
    add("endsAt", "must be later than the start");
  }

  return errors;
}

/**
 * The window as search params, or {} when it is blank or one-sided.
 *
 * {} rather than undefined keys, so spreading it into the filters gives a
 * dateless search exactly today's call. Validate first: this does not judge.
 *
 * @param {{startsAt?: string, endsAt?: string}} values
 * @returns {{startsAt?: string, endsAt?: string}} offset ISO strings
 */
export function toSearchWindow({ startsAt, endsAt } = {}) {
  const start = text(startsAt);
  const end = text(endsAt);
  if (start === "" || end === "") return {};
  return { startsAt: toOffsetIsoString(start), endsAt: toOffsetIsoString(end) };
}
