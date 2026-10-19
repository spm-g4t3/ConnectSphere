// The Attendee's list of open events. The backend filters, sorts and counts;
// nothing here does.
import { Link } from "react-router-dom";
import { getOpenEvents } from "../services/openEventService";
import { REGISTRATION_UNAVAILABLE_MESSAGE } from "../services/registrationErrors";
import useRefreshOnReturn from "./useRefreshOnReturn";
import useOpenEventRead from "./useOpenEventRead";
import OpenEventAvailability, { RegisteredBadge } from "./OpenEventAvailability";
import { openEventDetailsPath } from "../services/openEventRoutes";
import {
  EVENT_TIME_NOTE,
  formatEventDate,
  formatEventEndTime,
  formatEventStartTime,
} from "../services/openEventDisplay";

const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Attendees can browse open events.",
  500: "Open events could not be loaded. Please try again.",
  503: REGISTRATION_UNAVAILABLE_MESSAGE,
};

function EventRow({ event }) {
  return (
    <li className="browse-open-events__row">
      <div className="browse-open-events__summary">
        <span className="browse-open-events__title">
          <Link to={openEventDetailsPath(event.id)}>
            <strong>{event.eventName || "Unnamed event"}</strong>
          </Link>
          {event.isRegistered && <RegisteredBadge />}
        </span>
        <span className="browse-open-events__meta">
          <span>{formatEventDate(event.startsAt)}</span>
          <span>Starts {formatEventStartTime(event.startsAt)}</span>
          <span>Ends {formatEventEndTime(event.startsAt, event.endsAt)}</span>
          <span>{EVENT_TIME_NOTE}</span>
        </span>
      </div>
      <OpenEventAvailability event={event} />
    </li>
  );
}

const LIST_FALLBACK = "Open events could not be loaded. Please try again.";

export default function BrowseOpenEvents() {
  const { data, loading, error, refreshFailed, load: fetchEvents } = useOpenEventRead(getOpenEvents, {
    messages: LIST_ERROR_MESSAGES,
    fallback: LIST_FALLBACK,
  });
  const events = data ?? [];
  useRefreshOnReturn(fetchEvents);
  return (
    <>
      <h1>Browse Open Events</h1>

      <section className="browse-open-events" aria-labelledby="browse-open-events-heading">
        <h2 id="browse-open-events-heading">Events open for registration</h2>

        {loading && <p role="status">Loading...</p>}

        {error && (
          <div className="browse-open-events__error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={fetchEvents}>
              Try again
            </button>
          </div>
        )}

        {refreshFailed && (
          <div className="browse-open-events__notice" role="status">
            <p>Could not refresh the list. Showing the events as last loaded.</p>
            <button type="button" onClick={fetchEvents}>
              Try again
            </button>
          </div>
        )}

        {/* Nothing open is a normal state, not an error. */}
        {!loading && !error && events.length === 0 && (
          <p>No events are currently open for registration.</p>
        )}

        {!loading && !error && events.length > 0 && (
          <ul>
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
