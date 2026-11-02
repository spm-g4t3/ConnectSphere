// equipmentImpactDisplay.js
//
// How the confirmation step words the reservations a change would leave short
// (event name, period, quantity and coordinator, as the story asks), and the
// plain sums its heading uses. Pure functions, so the wording is tested without
// rendering anything.

import { formatEventPeriod } from "./eventPeriodFormat";

const plural = (count, one, many) => (count === 1 ? one : many);

/**
 * One affected reservation as the lines the screen shows.
 *
 * @param {object} item  an entry of the preview's `affected`
 * @returns {{ id: string, eventName: string, period: string, quantity: string,
 *   coordinator: string, alreadyFlagged: boolean }}
 */
export function describeAffected(item) {
  const name = typeof item.eventName === "string" ? item.eventName.trim() : "";
  const coordinator = typeof item.coordinatorName === "string" ? item.coordinatorName.trim() : "";
  const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
  return {
    id: item.reservationId,
    eventName: name === "" ? "Untitled event" : name,
    period: formatEventPeriod(item.startAt, item.endAt),
    quantity: `${quantity} ${plural(quantity, "unit", "units")}`,
    coordinator: coordinator === "" ? "No coordinator assigned" : coordinator,
    alreadyFlagged: item.flagged === true,
  };
}

/**
 * The totals for the heading: how many reservations and how many units.
 *
 * @param {object[]} affected
 * @returns {{ reservations: number, units: number }}
 */
export function summariseAffected(affected) {
  return {
    reservations: affected.length,
    units: affected.reduce((sum, item) => sum + (Number.isFinite(item.quantity) ? item.quantity : 0), 0),
  };
}

/**
 * The sentence above the list. The usable figures are left out when they are not
 * known, which is the case for a list that came back with a refusal.
 *
 * @param {object[]} affected
 * @param {number|null|undefined} usableBefore
 * @param {number|null|undefined} usableAfter
 * @returns {string}
 */
export function impactHeading(affected, usableBefore, usableAfter) {
  const { reservations, units } = summariseAffected(affected);
  if (reservations === 0) return "No reservations are affected by this change.";

  const figures =
    Number.isFinite(usableBefore) && Number.isFinite(usableAfter)
      ? `Usable units go from ${usableBefore} to ${usableAfter}. `
      : "";
  return (
    `${figures}${reservations} ${plural(reservations, "reservation", "reservations")} ` +
    `(${units} ${plural(units, "unit", "units")}) would no longer be covered.`
  );
}
