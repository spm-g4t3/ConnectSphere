const CONFLICT_MESSAGES = {
  ALREADY_REGISTERED: "You are already registered for this event.",
  EVENT_FULL: "This event is full.",
  REGISTRATION_NOT_OPEN: "Registration has not opened yet.",
  REGISTRATION_CLOSED: "Registration has closed for this event.",
  EVENT_NOT_CONFIRMED: "Registration is only available for Confirmed events.",
  REGISTRATION_DISABLED: "Registration is disabled for this event.",
  EVENT_STARTED: "Registration is closed because the event has started.",
  REGISTRATION_DATES_MISSING: "Registration dates have not been configured for this event.",
};

/** Null leaves the existing refreshed-event/generic fallback to explain the failure. */
export function registrationErrorMessage(error) {
  const response = error?.response;
  const status = response?.status;
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "Only Attendees can register for events.";
  if (status === 409 && Object.hasOwn(CONFLICT_MESSAGES, response.data?.code)) {
    return CONFLICT_MESSAGES[response.data.code];
  }
  if ([400, 404, 409].includes(status)) {
    const message = response.data?.error;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (error?.code === "ERR_NETWORK") return "Could not reach the server. Check your connection and try again.";
  return null;
}
