// BrowseEventDetails.jsx
//
// One open event, from the browse list: the browse preview, with no venue or
// internal planning information (SCRUM-24's registered view is separate).
//
// Eligibility is the server's: the event is read afresh on open, after every
// registration attempt and on return to the tab, and a 404 is one not-open
// message. Register takes an onRegister(eventId) prop because SCRUM-22's flow
// does not exist yet; without it the button stays disabled. A failed refresh
// keeps the details with a notice and pauses Register. The description is
// rendered as text, never HTML.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOpenEvent } from "../services/openEventService";
import useRefreshOnReturn from "./useRefreshOnReturn";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import {
  EVENT_TIME_NOTE,
  availabilityLabel,
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

function RegisterAction({ event, onRegister, registering, stale, onClick }) {
  if (event.isRegistered) {
    return (
      <div className="browse-event-details__register">
        <button type="button" disabled>
          Already registered
        </button>
        <p>You are registered for this event.</p>
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

// A refusal is not transient: keeping the details on screen after one would be wrong.
const REFUSALS = [401, 403];

export default function BrowseEventDetails({ onRegister }) {
  const { eventId } = useParams();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notOpen, setNotOpen] = useState(false);
  const [error, setError] = useState(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [notice, setNotice] = useState(null);
  const latest = useRef(0);
  const loaded = useRef(false);
  const sending = useRef(false);
  const currentEventId = useRef(eventId);
  // Reads the event and shows the answer. Resolves to what was found, so a
  // caller that needs the fresh state (a failed registration) can act on it:
  // { kind: "open", event }, { kind: "not-open" } or { kind: "error" }, or
  // { kind: "superseded" } when a newer read took over.
  const load = useCallback(async () => {
    const mine = ++latest.current;
    const background = loaded.current;
    if (!background) {
      setLoading(true);
      setError(null);
      setNotOpen(false);
      setEvent(null);
    }

    try {
      const fresh = await getOpenEvent(eventId);
      if (mine !== latest.current) return { kind: "superseded" };
      loaded.current = true;
      setEvent(fresh);
      setNotOpen(false);
      setError(null);
      setRefreshFailed(false);
      return { kind: "open", event: fresh };
    } catch (err) {
      if (mine !== latest.current) return { kind: "superseded" };
      const status = err.response?.status;

      if (status === 404) {
        // No longer open, for whatever reason: nothing may still offer to register.
        loaded.current = true;
        setEvent(null);
        setNotOpen(true);
        setError(null);
        setRefreshFailed(false);
        return { kind: "not-open" };
      }

      if (background && !REFUSALS.includes(status)) {
        setRefreshFailed(true);
        return { kind: "error" };
      }

      loaded.current = false;
      setEvent(null);
      setNotOpen(false);
      setRefreshFailed(false);
      setError(
        LOAD_ERROR_MESSAGES[status] || "This event could not be loaded. Please try again.",
      );
      return { kind: "error" };
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    currentEventId.current = eventId;
    loaded.current = false;
    // Banners belong to the event they were raised on.
    setNotice(null);
    setRegisterError(null);
    load();
  }, [eventId, load]);

  // Not while a registration is in flight: that attempt refreshes when it ends.
  const refreshOnReturn = useCallback(() => {
    if (!sending.current) load();
  }, [load]);
  useRefreshOnReturn(refreshOnReturn);

  async function handleRegister() {
    if (!onRegister || sending.current || !event) return;
    sending.current = true;
    setRegistering(true);
    setRegisterError(null);
    setNotice(null);

    const name = event.eventName || "this event";
    const startedOn = eventId;
    let registered;
    try {
      await onRegister(event.id);
      registered = true;
    } catch {
      registered = false;
    }

    // The reader moved to another event meanwhile: nothing about this attempt
    // belongs on that page, and re-reading would overwrite it.
    if (currentEventId.current !== startedOn) {
      sending.current = false;
      setRegistering(false);
      return;
    }

    // Success or not, what is on offer may have changed, and the server's
    // answer, not this page's copy, says what happened.
    const fresh = await load();
    sending.current = false;
    setRegistering(false);

    if (registered) {
      setNotice(`You are registered for ${name}.`);
    } else if (fresh.kind === "open" && fresh.event.isRegistered) {
      setRegisterError(ALREADY_MESSAGE);
    } else if (fresh.kind === "open" && fresh.event.isFull) {
      setRegisterError(FILLED_MESSAGE);
    } else if (fresh.kind !== "not-open") {
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
            <button type="button" onClick={load}>
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
                  <span
                    className={
                      event.isFull
                        ? "browse-open-events__availability browse-open-events__availability--full"
                        : "browse-open-events__availability"
                    }
                  >
                    {availabilityLabel(event)}
                  </span>
                  {event.isRegistered && (
                    <span className="browse-open-events__badge browse-open-events__badge--registered">
                      Registered
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <h3>About this event</h3>
            <p className="browse-event-details__description">
              {event.description || "The organiser has not added a description."}
            </p>

            <RegisterAction
              event={event}
              onRegister={onRegister}
              registering={registering}
              stale={refreshFailed}
              onClick={handleRegister}
            />
            {notice && (
              <div className="browse-event-details__success" role="status">
                <p>{notice}</p>
              </div>
            )}
            {registerError && (
              <div className="browse-event-details__error" role="alert">
                <p>{registerError}</p>
              </div>
            )}
          </>
        )}

        <BackLink />
      </section>
    </>
  );
}
