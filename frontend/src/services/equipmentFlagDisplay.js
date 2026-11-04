// equipmentFlagDisplay.js
//
// How the coordinator's equipment section words a line whose reservations are
// flagged (equipment unavailable), and how the Needs attention list words its reasons.
// Pure functions, so the wording is tested without rendering anything.
//
// A line arrives from the API as
//   { ..., flaggedReservations: [{ id, quantity, startAt, endAt, reason, code, flaggedAt }] }
// code is "equipment_lost" when the equipment is unavailable and null for any other
// flag, such as the event's date or time changing. Only the first is called
// "Equipment unavailable"; the rest are called what they are, flagged for review.
// Anything else (a missing key, a null, an entry that is not an object) is read as
// "nothing flagged" rather than throwing, as the other display modules do.

import { formatEventPeriod } from "./eventPeriodFormat";

const plural = (count, one, many) => (count === 1 ? one : many);

/** The words for a flag that was set without a reason. */
export const FLAG_WITHOUT_REASON = "Flagged for review.";

/** The kind of flag that is called "Equipment unavailable". */
// The stored code keeps its name; the screens say "unavailable" (SCRUM-310, D11).
const EQUIPMENT_LOST_CODE = "equipment_lost";

export const LOST_HEADING = "Equipment unavailable";
export const FLAGGED_HEADING = "Flagged for review";

/**
 * @param {object} line  a line from the event's equipment
 * @returns {{
 *   flagged: boolean,
 *   heading: string,   "" with nothing flagged; "Equipment unavailable" when every flag is for unavailable equipment; otherwise "Flagged for review"
 *   summary: string,
 *   items: {id: string, quantity: string, period: string, reason: string}[],
 * }}
 */
export function describeFlaggedLine(line) {
  const list = Array.isArray(line?.flaggedReservations) ? line.flaggedReservations : [];
  const items = list
    .filter((item) => item !== null && typeof item === "object")
    .map((item, index) => {
      const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "";
      return {
        id: typeof item.id === "string" && item.id !== "" ? item.id : `flag-${index}`,
        quantity,
        lost: item.code === EQUIPMENT_LOST_CODE,
        text: `${quantity} ${plural(quantity, "unit", "units")}`,
        period: formatEventPeriod(item.startAt, item.endAt),
        reason: reason === "" ? FLAG_WITHOUT_REASON : reason,
      };
    });

  const units = items.reduce((sum, item) => sum + item.quantity, 0);
  const count = items.length;
  return {
    flagged: count > 0,
    heading: count === 0 ? "" : items.every((item) => item.lost) ? LOST_HEADING : FLAGGED_HEADING,
    summary:
      count === 0
        ? ""
        : `${units} ${plural(units, "unit", "units")} across ${count} ${plural(count, "reservation", "reservations")} flagged for review`,
    items: items.map(({ id, text, period, reason }) => ({ id, quantity: text, period, reason })),
  };
}

/**
 * The reasons an event is on the Needs attention list, as the API gave them.
 * Only non-blank text is kept, so a malformed answer shows nothing rather than "undefined".
 *
 * @param {object} event
 * @returns {string[]}
 */
export function attentionReasonsOf(event) {
  if (event?.needsAttention !== true || !Array.isArray(event.attentionReasons)) return [];
  return event.attentionReasons
    .filter((reason) => typeof reason === "string" && reason.trim() !== "")
    .map((reason) => reason.trim());
}
