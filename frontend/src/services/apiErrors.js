// apiErrors.js
//
// The pieces every *Errors.js module and list screen read a failed API call
// with. Each caller keeps its own message tables; only the reading is shared.

/** What a 401 says everywhere: apiClient has already cleared the session. */
export const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

/** The machine-readable `code` of a refusal, or null when there is none. */
export function codeOf(err) {
  return err?.response?.data?.code ?? null;
}

/** A 400's details[], for the fields this form has. */
export function fieldErrorsFrom(err, fields) {
  const details = err?.response?.status === 400 ? err.response.data?.details : null;
  return Array.isArray(details) ? details.filter((d) => fields.includes(d?.field)) : [];
}

/** The message a status-keyed table has for this failure, else `fallback`. */
export function statusMessageOf(err, messages, fallback) {
  return messages[err?.response?.status] || fallback;
}

/**
 * A (err, action) => message function, keyed by the 409 `code` first, then a
 * 404 worded per action, then any other 409, then by status, then a default
 * per action.
 *
 * @param {{ codeMessages: Object, statusMessages: Object, notFoundMessages: Object,
 *   defaultMessages: Object, unknownConflictMessage: string }} tables
 * @returns {(err: unknown, action: string) => string}
 */
export function makeErrorMapper({
  codeMessages,
  statusMessages,
  notFoundMessages,
  defaultMessages,
  unknownConflictMessage,
}) {
  return function errorMessage(err, action) {
    const code = codeOf(err);
    if (code && Object.hasOwn(codeMessages, code)) return codeMessages[code];

    const status = err?.response?.status;
    // An action with no 404 wording falls through to the generic message below,
    // rather than returning undefined and leaving the alert blank.
    if (status === 404 && Object.hasOwn(notFoundMessages, action)) return notFoundMessages[action];
    if (status === 409) return unknownConflictMessage;
    if (Object.hasOwn(statusMessages, status)) return statusMessages[status];

    return defaultMessages[action] ?? "Something went wrong. Please try again.";
  };
}
