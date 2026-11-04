// equipmentReviewErrors.js
//
// SCRUM-296. What the review screen says when the server refuses. The server's
// 400, 403 and 409 messages for this feature are written for a reader, so they
// are shown; a missing or odd one falls back to a fixed sentence. A 500 is
// never shown as the server worded it.

const FIELD_LABELS = { note: "Note", outcome: "Note", lines: "Lines", quantity: "Quantity", reason: "Reason" };

const FALLBACKS = {
  400: "That was not accepted. Check what you entered and try again.",
  403: "Only the staff member reviewing this request can do that. The screen has been refreshed.",
  404: "That request or line no longer exists. The screen has been refreshed.",
  409: "This request has changed since you opened it. The screen has been refreshed.",
};
const GENERIC = "Something went wrong. Try again.";

/** @param {unknown} err an axios error */
export function reviewErrorMessage(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;

  if (status === 400) {
    const details = Array.isArray(data?.details) ? data.details : [];
    if (details.length > 0) {
      return details
        .map(({ field, message }) => (field === "lines" ? message : `${FIELD_LABELS[field] ?? "Input"}: ${message}`))
        .join(". ");
    }
    return FALLBACKS[400];
  }
  if (status === 403 || status === 409) {
    return typeof data?.error === "string" && data.error.trim() !== "" ? data.error : FALLBACKS[status];
  }
  return FALLBACKS[status] ?? GENERIC;
}

/** True when the screen's copy was stale, so it should be read again. */
export const isStaleRefusal = (err) => [403, 404, 409].includes(err?.response?.status);
