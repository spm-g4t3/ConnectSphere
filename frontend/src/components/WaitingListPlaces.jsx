import { useEffect, useRef, useState } from "react";
import { getWaitlist, leaveWaitlist } from "../services/attendeeEventService";
import useOpenEventRead from "./useOpenEventRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { WaitlistedBadge } from "./OpenEventAvailability";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import useFocusAfterRetry from "./useFocusAfterRetry";

const MESSAGES = {
  403: "Only Attendees can view waiting lists.",
};
const FALLBACK = "Your waiting lists could not be loaded. Please try again.";

function leaveFailureMessage(error) {
  const response = error?.response;
  if (response?.status === 404) return "This waiting-list place could not be found. It may already have been removed.";
  // Promoted while the request was on its way: the place is now a registration.
  if (response?.status === 409 && response.data?.code === "ALREADY_REGISTERED") {
    return "You have been given a place at this event, so you are no longer on its waiting list.";
  }
  if (response?.status === 409 && response.data?.code === "NOT_WAITLISTED") {
    return "You are no longer on this waiting list.";
  }
  if (error?.code === "ERR_NETWORK") return "Could not reach the server. You are still on the waiting list.";
  return "You could not leave the waiting list. You are still on it; please try again.";
}

function WaitingListPlace({ place, onLeft, onPromoted }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState(null);
  const sending = useRef(false);
  const leaveButtonRef = useRef(null);
  const refocusLeave = useRef(false);

  // The dialog has gone from the page by the time this runs, so focus returns
  // to Leave waiting list instead of the page body. A successful leave sends it
  // to the page's notice instead, as this row is about to disappear.
  useEffect(() => {
    if (confirming || submitting || !refocusLeave.current) return;
    refocusLeave.current = false;
    leaveButtonRef.current?.focus();
  }, [confirming, submitting]);

  async function handleLeave() {
    /* v8 ignore next -- @preserve ConfirmDialog disables Confirm while busy. */
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      await leaveWaitlist(place.registrationId);
      onLeft(place);
    } catch (err) {
      refocusLeave.current = true;
      setFailure(leaveFailureMessage(err));
      // Promoted: the registrations list gains the event. This list is left as
      // it is, so the explanation stays on screen until the next refresh.
      if (err?.response?.data?.code === "ALREADY_REGISTERED") onPromoted?.();
    } finally {
      // Closed either way: on success the re-read removes this row, so the
      // dialog must not stay open offering to leave again meanwhile.
      setConfirming(false);
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <li>
      <strong>{place.eventName || "Unnamed event"}</strong>{" "}
      <WaitlistedBadge position={place.waitlistPosition} />
      {/* The server says whether places can be offered now; the queue is kept either way. */}
      {place.placesOffered === false && (
        <p>Registration for this event is closed, so no places are being offered. You keep your place in the queue.</p>
      )}
      {/* Leave waiting list stays on screen, so it is the retry. */}
      {failure && <ErrorNotice message={failure} />}
      <Button ref={leaveButtonRef} variant="danger" onClick={() => setConfirming(true)}>
        Leave waiting list
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Leave the waiting list?"
        confirmLabel={submitting ? "Leaving..." : "Confirm leaving"}
        cancelLabel="Keep my place"
        danger
        busy={submitting}
        onConfirm={handleLeave}
        onCancel={() => {
          refocusLeave.current = true;
          setConfirming(false);
        }}
      >
        You will lose your place in the queue.
      </ConfirmDialog>
    </li>
  );
}

/**
 * The attendee's waiting-list places. Positions are the server's: after a
 * departure the list is read again rather than renumbered here, and it is read
 * again on return to the tab, which is when a promotion moves an event from
 * here to the registered list. onChanged tells the page a list may have moved.
 */
export default function WaitingListPlaces({ onChanged }) {
  const { data, loading, error, refreshFailed, load } = useOpenEventRead(getWaitlist, {
    messages: MESSAGES, fallback: FALLBACK,
  });
  const places = data ?? [];
  const [notice, setNotice] = useState(null);
  // Counted rather than keyed on the text, so leaving a second event with the
  // same name still moves focus.
  const [noticeFocusRequest, setNoticeFocusRequest] = useState(0);
  const noticeRef = useRef(null);
  useRefetchOnReturn(load);

  // The Leave button that had focus goes with its row, so focus moves to the notice.
  useEffect(() => {
    if (noticeFocusRequest) noticeRef.current?.focus();
  }, [noticeFocusRequest]);

  const { headingRef, retry } = useFocusAfterRetry(load);

  function handleLeft(place) {
    setNotice(`You have left the waiting list for ${place.eventName || "this event"}.`);
    setNoticeFocusRequest((count) => count + 1);
    load();
    onChanged?.();
  }

  return (
    <section className="waiting-list-places" aria-labelledby="waiting-lists-heading">
      <h2 ref={headingRef} tabIndex={-1} id="waiting-lists-heading">Waiting lists</h2>
      {notice && (
        <p ref={noticeRef} tabIndex={-1} className="browse-event-details__success" role="status">{notice}</p>
      )}
      {loading && <LoadingText />}
      {error && <ErrorNotice message={error} onRetry={retry} />}
      {refreshFailed && (
        <div className="browse-open-events__notice" role="status">
          <p>Could not refresh your waiting lists. Showing them as last loaded.</p>
          <Button variant="secondary" onClick={retry}>Try again</Button>
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
        ) : (
          <EmptyState
            message="You are not on any waiting lists."
            nextStep="When an event is full, you can join its waiting list from the event's page."
          />
        )
      )}
    </section>
  );
}
