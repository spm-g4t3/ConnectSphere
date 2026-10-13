// BrowseOpenEvents.jsx
//
// SCRUM-495: the Attendee's list of events open for registration, earliest
// start first, each with its date, start and end times, and availability.
//
// Built the way MyBookingRequests is: a useCallback fetch, a status-keyed error
// table, a "Loading..." line, an empty-state sentence, and <section> as a
// direct child of the .dashboard wrapper App.jsx's route supplies, so it picks
// up the `.dashboard > section` card styling.
//
// What is listed, in what order, and what is said about places and the
// caller's own registration are all decided by the backend (GET /open-events).
// Nothing here filters, re-sorts or counts. The list carries no venue or
// internal planning information, because the API sends none.
//
// Full events stay in the list, marked "Full". An event the caller already
// holds a place on is marked "Registered". Selecting an event goes to its
// details page (BrowseEventDetails.jsx).
//
// REFRESH. The list is read when the page opens and again whenever the reader
// returns to the tab, so an event that has since filled, closed, started or
// gone back to Approved drops out (or shows Full), and a registration made
// elsewhere shows as Registered. Opening the page again, for instance after
// registering on the details page, is also a fresh read. A refresh does not
// blank the list: only the first read shows "Loading...". If a refresh fails
// for a transient reason the last list stays up with a notice, because
// removing it would be no more true than keeping it; a lost session or a
// refused role replaces it with the error, as on first load. Overlapping reads
// are settled by recency, so a slow old answer never overwrites a newer one.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getOpenEvents } from "../services/openEventService";
import useRefreshOnReturn from "./useRefreshOnReturn";
import { openEventDetailsPath } from "../services/openEventRoutes";
import {
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
