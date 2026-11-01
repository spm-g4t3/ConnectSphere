// equipmentErrors.js
//
// SCRUM-280. What a failed equipment request says to Technical Support Staff.
//
// A 400 from these routes carries details[], one { field, message } per invalid
// field, and every one of them is shown (the story asks to "show every
// validation error from the backend"). Everything else is keyed by the 409
// `code` first, then by status, then a default per action. data.error is never
// shown on its own: outside a 400 it is database or driver prose.


const FIELD_LABELS = {
  name: "Name",
  description: "Description",
  category: "Category",
  location: "Location",
  totalQuantity: "Total quantity",
  damagedQuantity: "Damaged",
  underMaintenanceQuantity: "Under maintenance",
  note: "Note",
};

const CODE_MESSAGES = {
  EQUIPMENT_NAME_TAKEN: "Another equipment type already uses that name.",
  EQUIPMENT_ALREADY_RETIRED: "This type has already been retired. The list has been refreshed.",
  EQUIPMENT_NOT_RETIRED: "This type is not retired. The list has been refreshed.",
  EQUIPMENT_AFFECTED_CHANGED:
    "The reservations this change affects have changed since you looked. Nothing was saved. Review the updated list and confirm again.",
};

const STATUS_MESSAGES = {
  403: "Only Technical Support Staff can manage the equipment catalogue.",
  404: "That equipment type no longer exists. The list has been refreshed.",
};

const DEFAULT_MESSAGES = {
  load: "Could not load the equipment catalogue. Please try again.",
  save: "Could not save the equipment type. Please try again.",
  condition: "Could not save the quantities. Please try again.",
  retire: "Could not retire this type. Please try again.",
  reinstate: "Could not reinstate this type. Please try again.",
  history: "Could not load this type's history. Please try again.",
  preview: "Could not check which reservations this change affects. Nothing was saved. Please try again.",
};

/**
 * The messages for a failed request, one per line to show.
 *
 * @param {unknown} err  what the equipmentService call threw
 * @param {"load"|"save"|"condition"|"retire"|"reinstate"|"history"|"preview"} action
 * @returns {string[]}
 */
export function equipmentErrorMessages(err, action) {
  const response = err?.response;
  const details = response?.data?.details;

  if (response?.status === 400 && Array.isArray(details) && details.length > 0) {
    return details.map(({ field, message }) =>
      Object.hasOwn(FIELD_LABELS, field) ? `${FIELD_LABELS[field]}: ${message}` : message,
    );
  }

  const code = response?.data?.code;
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return [CODE_MESSAGES[code]];

  const status = response?.status;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return [STATUS_MESSAGES[status]];
  if (status === 400) return ["Some details were not accepted. Please check the form."];

  return [DEFAULT_MESSAGES[action] ?? "Something went wrong. Please try again."];
}

/**
 * Whether the failure means the list on screen is out of date, so the caller
 * should refetch it: the type is gone, or already in the state we asked for.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStaleEquipmentError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  return status === 404 || code === "EQUIPMENT_ALREADY_RETIRED" || code === "EQUIPMENT_NOT_RETIRED";
}


/**
 * Whether a save was refused because the reservations the change affects are
 * no longer the ones the staff member confirmed (SCRUM-313). Nothing was saved,
 * and the current list is in affectedFromError.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAffectedChangedError(err) {
  return err?.response?.status === 409 && err?.response?.data?.code === "EQUIPMENT_AFFECTED_CHANGED";
}

/**
 * The current list of affected reservations carried by that refusal, in the same
 * shape the preview returns. Anything that is not a list of reservations reads
 * as an empty list, so a malformed body can never show a made-up reservation.
 *
 * @param {unknown} err
 * @returns {object[]}
 */
export function affectedFromError(err) {
  const conflicts = err?.response?.data?.conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter(
    (item) => item !== null && typeof item === "object" && typeof item.reservationId === "string",
  );
}
