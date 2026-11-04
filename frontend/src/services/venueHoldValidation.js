// venueHoldValidation.js
//
// SCRUM-491 (AC2). The client-side half of the hold rules, and the payload
// VenueHoldForm sends: which Approved event, and when the hold expires. The
// venue comes from the panel, the period from the stored event, and the
// placer from the token, so none of them is a field.
//
// The wording mirrors validatePlaceVenueHold in
// backend/src/validation/venueHoldValidation.js ("is required", "must be in
// the future"), so a Venue Staff member sees the same message whichever side
// caught the fault. The backend, and behind it place_venue_hold's own check
// against the database clock, stays the authority.
//
// The expiry is a datetime-local value read as device time and sent through
// toOffsetIsoString, exactly as the block form's dates are: the panel shows
// every time with toLocaleString, so the expiry is typed in the same clock it
// is read back in.
//
// Lives here rather than in VenueHoldForm.jsx because react-refresh only
// allows a component module to export components.

import { toOffsetIsoString } from "./datetimeFormat";
import { parseDateTime } from "./venueBlockValidation";

/**
 * Check a hold form's raw values.
 *
 * Collects every fault, in the backend's { field, message } shape, so the
 * form renders client and server faults with one renderer.
 *
 * @param {object} values
 * @param {string} [values.eventRequestId]  the chosen event's id
 * @param {string} [values.expiresAt]       datetime-local or offset ISO
 * @param {object} [options]
 * @param {Date} [options.now]  the instant to judge "future" against
 * @returns {{field: string, message: string}[]} empty when the values are fine
 */
export function validateHoldInput(values, { now = new Date() } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  const eventRequestId =
    typeof values?.eventRequestId === "string" ? values.eventRequestId.trim() : "";
  if (eventRequestId === "") add("eventRequestId", "is required");

  const expiresAt = typeof values?.expiresAt === "string" ? values.expiresAt.trim() : "";
  if (expiresAt === "") {
    add("expiresAt", "is required");
  } else {
    const instant = parseDateTime(expiresAt);
    if (instant === null) add("expiresAt", "must be a valid date and time");
    else if (instant <= now) add("expiresAt", "must be in the future");
  }

  return errors;
}

/**
 * The form as placeVenueHold's body. Validate first: this does not judge.
 *
 * @param {{eventRequestId: string, expiresAt: string}} values
 * @returns {{eventRequestId: string, expiresAt: string}} the expiry with the
 *          device's offset
 */
export function toHoldPayload(values) {
  return {
    eventRequestId: values.eventRequestId.trim(),
    expiresAt: toOffsetIsoString(values.expiresAt.trim()),
  };
}
