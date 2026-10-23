import { SESSION_EXPIRED } from "./apiErrors";

export const WITHDRAWAL_FALLBACK_MESSAGE = "Your registration could not be withdrawn. It has not changed; please try again.";

/** The backend's own reason where it gave one; the registration is unchanged in every case. */
export function withdrawalErrorMessage(error) {
  const response = error?.response;
  const status = response?.status;
  if (status === 401) return SESSION_EXPIRED;
  if (status === 403) return "Only Attendees can withdraw a registration.";
  if (status === 503) return "Registration withdrawal is temporarily unavailable. Please try again later.";
  if ([400, 404, 409].includes(status)) {
    const message = response.data?.error;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (error?.code === "ERR_NETWORK") return "Could not reach the server. Check your connection and try again.";
  return WITHDRAWAL_FALLBACK_MESSAGE;
}
