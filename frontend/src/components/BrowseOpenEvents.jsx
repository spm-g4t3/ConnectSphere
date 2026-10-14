// BrowseOpenEvents.jsx
//
// The Attendee's list of open events. The backend decides what is listed, the
// order and the availability; nothing here filters, sorts or counts.
//
// It is read on open and when the reader returns to the tab, without blanking
// the list. A failed refresh keeps the last list with a notice, a lost session
// or refused role replaces it, and the newest read wins.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getOpenEvents } from "../services/openEventService";
import useRefreshOnReturn from "./useRefreshOnReturn";
import { openEventDetailsPath } from "../services/openEventRoutes";
import {
  EVENT_TIME_NOTE,
  availabilityLabel,
  formatEventDate,
  formatEventEndTime,
  formatEventStartTime,
} from "../services/openEventDisplay";

const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Attendees can browse open events.",
  500: "Open events could not be loaded. Please try again.",
};

function EventRow({ event }) {
  return (
    <li className="browse-open-events__row">
      <div className="browse-open-events__summary">
        <span className="browse-open-events__title">
          <Link to={openEventDetailsPath(event.id)}>
            <strong>{event.eventName || "Unnamed event"}</strong>
          </Link>
          {event.isRegistered && (
            <span className="browse-open-events__badge browse-open-events__badge--registered">
              Registered
            </span>
          )}
        </span>
        <span className="browse-open-events__meta">
          <span>{formatEventDate(event.startsAt)}</span>
          <span>Starts {formatEventStartTime(event.startsAt)}</span>
          <span>Ends {formatEventEndTime(event.startsAt, event.endsAt)}</span>
          <span>{EVENT_TIME_NOTE}</span>
        </span>
      </div>
      <span
        className={
          event.isFull
            ? "browse-open-events__availability browse-open-events__availability--full"
            : "browse-open-events__availability"
        }
      >
        {availabilityLabel(event)}
      </span>
    </li>
  );
}

// A refusal is not transient: keeping the list on screen after one would be wrong.
const REFUSALS = [401, 403];

export default function BrowseOpenEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useRef(0);
  const loaded = useRef(false);

  const fetchEvents = useCallback(async () => {
    const mine = ++latest.current;
    const background = loaded.current;
    if (!background) {
      setLoading(true);
      setError(null);
    }

    try {
      const data = await getOpenEvents();
      if (mine !== latest.current) return;
      loaded.current = true;
      setEvents(data);
      setError(null);
      setRefreshFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      const status = err.response?.status;
      if (background && !REFUSALS.includes(status)) {
        setRefreshFailed(true);
        return;
      }
      loaded.current = false;
      setEvents([]);
      setRefreshFailed(false);
      setError(
        LIST_ERROR_MESSAGES[status] || "Open events could not be loaded. Please try again.",
      );
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

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
