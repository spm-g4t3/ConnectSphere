// One open event: the browse preview, with no venue or internal planning
// information. The server decides eligibility, so the event is re-read after
// every registration attempt and on return to the tab; Register is disabled
// until `onRegister` is supplied. The description is rendered as text, never HTML.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOpenEvent } from "../services/openEventService";
import { registrationErrorMessage } from "../services/registrationErrors";
import useRefreshOnReturn from "./useRefreshOnReturn";
import useOpenEventRead from "./useOpenEventRead";
import OpenEventAvailability, { RegisteredBadge } from "./OpenEventAvailability";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import {
  EVENT_TIME_NOTE,
  formatEventDate,
  formatEventEndTime,
  formatEventStartTime,
} from "../services/openEventDisplay";

const LOAD_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Attendees can browse open events.",
  500: "This event could not be loaded. Please try again.",
};

const NOT_OPEN_MESSAGE = "This event is not open for registration.";

function BackLink() {
  return (
    <p>
      <Link to={BROWSE_OPEN_EVENTS_PATH}>Back to open events</Link>
    </p>
  );
}

function RegisterAction({ event, isRegistered, onRegister, registering, stale, onClick }) {
  if (isRegistered) {
    return (
      <div className="browse-event-details__register">
        <button type="button" disabled>
          Already registered
        </button>
      </div>
    );
  }

  if (event.isFull || !event.canRegister) {
    return (
      <div className="browse-event-details__register">
        <button type="button" disabled>
          Register
        </button>
        <p>{event.isFull ? "This event is full." : "Registration is not available for this event."}</p>
      </div>
    );
  }

  return (
    <div className="browse-event-details__register">
      <button type="button" onClick={onClick} disabled={!onRegister || registering || stale}>
        {registering ? "Registering..." : "Register"}
      </button>
      {!onRegister && <p>Registering for events is not available yet.</p>}
      {onRegister && stale && <p>Registration is paused until this event can be checked again.</p>}
    </div>
  );
}

const FILLED_MESSAGE = "Sorry, this event filled up before your registration went through. It is now full.";
const ALREADY_MESSAGE = "You are already registered for this event.";
const GENERIC_REGISTER_MESSAGE = "Registration could not be completed. Please try again.";

const DETAILS_FALLBACK = "This event could not be loaded. Please try again.";

export default function BrowseEventDetails({ onRegister }) {
  const { eventId } = useParams();
  const fetchEvent = useCallback(() => getOpenEvent(eventId), [eventId]);
  const {
    data: event,
    loading,
    notFound: notOpen,
    error,
    refreshFailed,
    load,
  } = useOpenEventRead(fetchEvent, {
    messages: LOAD_ERROR_MESSAGES,
    fallback: DETAILS_FALLBACK,
    notFoundIsAnswer: true,
  });
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [registeredEventId, setRegisteredEventId] = useState(null);
  const isRegistered = event?.isRegistered || registeredEventId === eventId;
  const sending = useRef(false);
  const currentEventId = useRef(eventId);

  useEffect(() => {
    currentEventId.current = eventId;
    // Banners belong to the event they were raised on.
    setNotice(null);
    setRegisterError(null);
    setRegisteredEventId(null);
  }, [eventId]);

  // Not while a registration is in flight: that attempt refreshes when it ends,
  // and a read started now would supersede that one and hide what happened.
  const refreshUnlessRegistering = useCallback(() => {
    if (!sending.current) load();
  }, [load]);
  useRefreshOnReturn(refreshUnlessRegistering);
  async function handleRegister() {
    if (!onRegister || sending.current || !event || isRegistered) return;
    sending.current = true;
    setRegistering(true);
    setRegisterError(null);
    setNotice(null);

    const name = event.eventName || "this event";
    const startedOn = eventId;
    let registered;
    let failure;
    try {
      await onRegister(event.id);
      registered = true;
    } catch (err) {
      registered = false;
      failure = err;
    }

    // The reader moved to another event meanwhile: nothing about this attempt
    // belongs on that page, and re-reading would overwrite it.
    if (currentEventId.current !== startedOn) {
      sending.current = false;
      setRegistering(false);
      return;
    }

    const failureMessage = registered ? null : registrationErrorMessage(failure);
    if (registered) {
      setRegisteredEventId(startedOn);
      setNotice(`You are registered for ${name}.`);
    } else {
      if (failure?.response?.status === 409 && failure.response.data?.code === "ALREADY_REGISTERED") {
        setRegisteredEventId(startedOn);
      }
      if (failureMessage) setRegisterError(failureMessage);
    }

    // Success or not, what is on offer may have changed, and the server's
    // answer, not this page's copy, says what happened.
    const fresh = await load();
    sending.current = false;
    setRegistering(false);

    // Overtaken by another read (the reader moved on): this attempt's outcome
    // belongs to a page that is no longer shown.
    if (fresh.kind === "superseded") return;

    if (registered || failureMessage) return;
    if (fresh.kind === "ok" && fresh.data.isRegistered) {
      setRegisterError(ALREADY_MESSAGE);
    } else if (fresh.kind === "ok" && fresh.data.isFull) {
      setRegisterError(FILLED_MESSAGE);
    } else if (fresh.kind !== "not-found") {
      // When the event is no longer open, the not-open message already says so.
      setRegisterError(GENERIC_REGISTER_MESSAGE);
    }
  }
  return (
    <>
      <h1>{event ? event.eventName || "Unnamed event" : "Event details"}</h1>

      <section className="browse-event-details" aria-labelledby="browse-event-details-heading">
        <h2 id="browse-event-details-heading">Event details</h2>

        {loading && <p role="status">Loading...</p>}

        {!loading && notOpen && (
          <div className="browse-event-details__unavailable" role="alert">
            <p>{NOT_OPEN_MESSAGE}</p>
          </div>
        )}

        {/* Outside the details: the reload after registering can find the event
            closed, and the attendee must still be told they are registered. */}
        {notice && (
          <div className="browse-event-details__success" role="status">
            <p>{notice}</p>
          </div>
        )}

        {!loading && error && (
          <div className="browse-event-details__error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {refreshFailed && (
          <div className="browse-event-details__notice" role="status">
            <p>Could not refresh this event. Showing the details as last loaded.</p>
            <button type="button" onClick={refreshUnlessRegistering} disabled={registering}>
              Try again
            </button>
          </div>
        )}

        {!loading && event && (
          <>
            <dl className="browse-event-details__facts">
              <div>
                <dt>Date</dt>
                <dd>{formatEventDate(event.startsAt)}</dd>
              </div>
              <div>
                <dt>Starts</dt>
                <dd>
                  {formatEventStartTime(event.startsAt)} {EVENT_TIME_NOTE}
                </dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd>
                  {formatEventEndTime(event.startsAt, event.endsAt)} {EVENT_TIME_NOTE}
                </dd>
              </div>
              <div>
                <dt>Availability</dt>
                <dd>
                  <OpenEventAvailability event={event} />
                  {isRegistered && <RegisteredBadge />}
                </dd>
              </div>
            </dl>

            <h3>About this event</h3>
            <p className="browse-event-details__description">
              {event.description || "The organiser has not added a description."}
            </p>

            <RegisterAction
              event={event}
              isRegistered={isRegistered}
              onRegister={onRegister}
              registering={registering}
              stale={refreshFailed}
              onClick={handleRegister}
            />
          </>
        )}

        {registerError && registerError !== error && (
          <div className="browse-event-details__error" role="alert">
            <p>{registerError}</p>
          </div>
        )}

        <BackLink />
      </section>
    </>
  );
}
