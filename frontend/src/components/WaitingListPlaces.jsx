import { useRef, useState } from "react";
import { getWaitlist, leaveWaitlist } from "../services/attendeeEventService";
import useOpenEventRead from "./useOpenEventRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { SESSION_EXPIRED } from "../services/apiErrors";

const MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Attendees can view waiting lists.",
};
const FALLBACK = "Your waiting lists could not be loaded. Please try again.";

function leaveFailureMessage(error) {
  const response = error?.response;
  if (response?.status === 401) return SESSION_EXPIRED;
  if (response?.status === 404) return "This waiting-list place could not be found. It may already have been removed.";
  // Promoted while the request was on its way: the place is now a registration.
  if (response?.status === 409 && response.data?.code === "NOT_WAITLISTED") {
    return "You have been given a place at this event, so you are no longer on its waiting list.";
  }
  if (error?.code === "ERR_NETWORK") return "Could not reach the server. You are still on the waiting list.";
  return "You could not leave the waiting list. You are still on it; please try again.";
}

function WaitingListPlace({ place, onLeft, onPromoted }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState(null);
  const sending = useRef(false);

  async function handleLeave() {
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      await leaveWaitlist(place.registrationId);
      onLeft();
    } catch (err) {
      setFailure(leaveFailureMessage(err));
      setConfirming(false);
      // Promoted: the registrations list gains the event. This list is left as
      // it is, so the explanation stays on screen until the next refresh.
      if (err?.response?.data?.code === "NOT_WAITLISTED") onPromoted?.();
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <li>
      <strong>{place.eventName || "Unnamed event"}</strong>{" "}
      <span>Position {place.waitlistPosition} on the waiting list</span>
      {failure && <p className="browse-open-events__error" role="alert">{failure}</p>}
      {confirming ? (
        <div className="event-venue-bookings__actions">
          <p>Leave the waiting list? You will lose your place in the queue.</p>
          <button type="button" disabled={submitting} onClick={handleLeave}>
            {submitting ? "Leaving..." : "Confirm leaving"}
          </button>
          <button type="button" disabled={submitting} onClick={() => setConfirming(false)}>
            Keep my place
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          Leave waiting list
        </button>
      )}
    </li>
  );
}

/** The attendee's waiting-list places. onChanged tells the page a list may have moved. */
export default function WaitingListPlaces({ onChanged }) {
  const { data, loading, error, refreshFailed, load } = useOpenEventRead(getWaitlist, {
    messages: MESSAGES, fallback: FALLBACK,
  });
  const places = data ?? [];
  useRefetchOnReturn(load);

  function handleLeft() {
    load();
    onChanged?.();
  }

  return (
    <section aria-labelledby="waiting-lists-heading">
      <h2 id="waiting-lists-heading">Waiting lists</h2>
      {loading && <p>Loading waiting lists...</p>}
      {(error || refreshFailed) && (
        <div className="browse-open-events__error" role="alert">
          <p>{error || "Could not refresh your waiting lists. Showing them as last loaded."}</p>
          <button type="button" onClick={load}>Try again</button>
        </div>
      )}
      {!loading && !error && (
        places.length ? (
          <ul>
            {places.map(place => (
              <WaitingListPlace
                key={place.registrationId}
                place={place}
                onLeft={handleLeft}
                onPromoted={onChanged}
              />
            ))}
          </ul>
        ) : <p>You are not on any waiting lists.</p>
      )}
    </section>
  );
}
