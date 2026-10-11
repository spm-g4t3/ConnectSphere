// BrowseEventDetails.jsx
//
// SCRUM-495: one open event, opened from the browse list: its name, date, start
// and end times, the organiser's description, its availability, and a Register
// action when registering is possible.
//
// This is the browse preview. It shows what the API sends for an open event
// and nothing else: no venue and no internal planning information. The
// registered-attendee view, which includes the venue, is SCRUM-24's and is a
// separate page and endpoint.
//
// Eligibility is the server's. The event is read afresh every time the page
// opens (GET /open-events/:id applies the list's rules at that moment), and an
// event that is not open, for any reason, is one 404 and one message here.
// Direct URLs get no more than the list would show.
//
// The description is the organiser's own text, rendered as a React text node,
// so it is escaped like every other free-text field in the app, with
// white-space: pre-wrap to keep its line breaks. It is never parsed as HTML.
//
// REGISTER. The action is offered only for an event with a place free that the
// caller is not already registered for (canRegister from the API). Registering
// itself is SCRUM-22's, and that flow does not exist yet, so this page takes
// it as an `onRegister(eventId)` prop rather than carrying a registration path
// of its own. With no handler the button stays disabled and says so: it never
// pretends to have registered anyone. SCRUM-22 supplies the handler, and the
// page then reads the event again, because availability may have changed.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOpenEvent } from "../services/openEventService";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import {
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

function RegisterAction({ event, onRegister, registering, onClick }) {
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
      <button type="button" onClick={onClick} disabled={!onRegister || registering}>
        {registering ? "Registering..." : "Register"}
      </button>
      {!onRegister && <p>Registering for events is not available yet.</p>}
    </div>
  );
}

export default function BrowseEventDetails({ onRegister }) {
  const { eventId } = useParams();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notOpen, setNotOpen] = useState(false);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotOpen(false);
    try {
      setEvent(await getOpenEvent(eventId));
    } catch (err) {
      setEvent(null);
      if (err.response?.status === 404) {
        setNotOpen(true);
      } else {
        setError(
          LOAD_ERROR_MESSAGES[err.response?.status] ||
            "This event could not be loaded. Please try again.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRegister() {
    if (!onRegister || registering) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      await onRegister(event.id);
    } catch {
      setRegisterError("Registration could not be completed. Please try again.");
    } finally {
      setRegistering(false);
    }
    // Success or not, what is on offer may have changed.
    await load();
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

        {!loading && event && (
          <>
            <dl className="browse-event-details__facts">
              <div>
                <dt>Date</dt>
                <dd>{formatEventDate(event.startsAt)}</dd>
              </div>
              <div>
                <dt>Starts</dt>
                <dd>{formatEventStartTime(event.startsAt)}</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd>{formatEventEndTime(event.startsAt, event.endsAt)}</dd>
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
              onClick={handleRegister}
            />
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
