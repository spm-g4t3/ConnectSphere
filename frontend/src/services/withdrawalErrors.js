
export const WITHDRAWAL_FALLBACK_MESSAGE = "Your registration could not be withdrawn. It has not changed; please try again.";
export const WITHDRAWAL_NETWORK_MESSAGE = "Could not reach the server. Your registration has not changed; check your connection and try again.";

// The codes withdraw_registration refuses with. Each is final for this
// registration as it stands, so asking again would get the same answer.
const REJECTION_MESSAGES = {
  WITHDRAWAL_DEADLINE_PASSED: "The withdrawal deadline for this event has passed, so your registration can no longer be withdrawn. You are still registered.",
  WITHDRAWAL_DEADLINE_NOT_SET: "This event has no withdrawal deadline, so registrations cannot be withdrawn. You are still registered.",
  REGISTRATION_NOT_CONFIRMED: "Only a confirmed registration can be withdrawn, and this registration is not confirmed.",
  ALREADY_WITHDRAWN: "This registration has already been withdrawn.",
  // Says nothing of why: the attendee's event read keeps the event's status private.
  EVENT_NOT_ACTIVE: "Registrations for this event can no longer be withdrawn. You are still registered.",
  EVENT_STARTED: "This event has already started, so your registration can no longer be withdrawn. You are still registered.",
};

export const WITHDRAWAL_REFUSED_MESSAGE = "This registration cannot be withdrawn. It has not changed.";

// The only client errors that might pass on a later try.
const TRANSIENT_CLIENT_STATUSES = [408, 429];

// The backend answers a missing registration and someone else's with the same
// 404, and so does this: the message never says which it was.
const NOT_FOUND_MESSAGE = "This registration could not be found. It may already have been withdrawn or cancelled.";

/**
 * What to tell the attendee, and whether trying again could help. A rejection
 * is the backend saying no; anything else (network, outage, a race, an
 * unexpected error) left the registration unchanged and may succeed later.
 * @returns {{ message: string, rejected: boolean }}
 */
export function withdrawalFailure(error) {
  const response = error?.response;
  const status = response?.status;
  const code = response?.data?.code;
  if (status === 403) return { message: "Only Attendees can withdraw a registration.", rejected: true };
  if (status === 404) return { message: NOT_FOUND_MESSAGE, rejected: true };
  if (status === 409 && Object.hasOwn(REJECTION_MESSAGES, code)) {
    return { message: REJECTION_MESSAGES[code], rejected: true };
  }
  if (status === 409 && code === "REGISTRATION_CHANGED") {
    return { message: "Your registration changed while it was being withdrawn. Please try again.", rejected: false };
  }
  // A reason added to the backend after this map: still a refusal, in its own words.
  const serverMessage = response?.data?.error;
  if (status === 409 && typeof serverMessage === "string" && serverMessage.trim()) {
    return { message: serverMessage, rejected: true };
  }
  // Any other client error (a 400, say) would be refused again, so it is final.
  if (status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.includes(status)) {
    return { message: WITHDRAWAL_REFUSED_MESSAGE, rejected: true };
  }
  if (status === 503) {
    return { message: "Registration withdrawal is temporarily unavailable. Please try again later.", rejected: false };
  }
  if (error?.code === "ERR_NETWORK") return { message: WITHDRAWAL_NETWORK_MESSAGE, rejected: false };
  return { message: WITHDRAWAL_FALLBACK_MESSAGE, rejected: false };
}
