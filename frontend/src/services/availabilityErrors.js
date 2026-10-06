// availabilityErrors.js
//
// SCRUM-70. What a failed availability request says to Technical Support Staff.
//
// A 400 carries details[], one { field, message } per invalid input, and every
// one is shown (the story asks to "show every validation error from the
// backend"). Anything else gets a fixed message: outside a 400 the server's own
// text is database prose and never reaches the screen.

const FIELD_LABELS = {
  equipmentTypeId: "Equipment type",
  quantity: "Quantity",
  startAt: "Start",
  endAt: "End",
  eventRequestId: "Event",
};

const STATUS_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Technical Support Staff can check equipment availability.",
};

const DEFAULT_MESSAGES = {
  check: "Could not check availability. Please try again.",
  load: "Could not load the equipment types. Please try again.",
};

/**
 * @param {unknown} err  what the service call threw
 * @param {"check"|"load"} action
 * @returns {string[]}  one message per line to show
 */
export function availabilityErrorMessages(err, action) {
  const response = err?.response;
  const details = response?.data?.details;

  if (response?.status === 400 && Array.isArray(details) && details.length > 0) {
    return details.map(({ field, message }) =>
      Object.hasOwn(FIELD_LABELS, field) ? `${FIELD_LABELS[field]}: ${message}` : message,
    );
  }

  if (Object.hasOwn(STATUS_MESSAGES, response?.status)) return [STATUS_MESSAGES[response.status]];
  if (response?.status === 400) return ["Some details were not accepted. Please check the form."];

  return [DEFAULT_MESSAGES[action] ?? "Something went wrong. Please try again."];
}
