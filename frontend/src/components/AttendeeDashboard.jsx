// The Attendee landing page: a greeting, the way into Browse Open Events and
// the attendee's notifications. Each section is a direct child of .dashboard
// to get its card styling.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getOpenRegistrationEvents,
  registerForEvent,
} from "../services/eventRegistrationService";
import { BROWSE_OPEN_EVENTS_PATH, isOpenEventsEnabled } from "../services/openEventRoutes";
import NotificationInbox from "./NotificationInbox";

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AttendeeDashboard({ user }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [registered, setRegistered] = useState([]);
  const browseEnabled = isOpenEventsEnabled();

  useEffect(() => {
    if (browseEnabled) return undefined;

    let active = true;
    getOpenRegistrationEvents()
      .then((openEvents) => {
        if (active) {
          setEvents(openEvents);
          setRegistered(openEvents.filter((event) => event.isRegistered).map((event) => event.id));
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError?.response?.data?.error || "Could not load open events.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [browseEnabled]);

  async function handleRegister(eventId) {
    setRegistering(eventId);
    setError(null);
    try {
      await registerForEvent(eventId);
      setRegistered((current) => [...current, eventId]);
      setEvents((current) => current.map((event) => (
        event.id === eventId
          ? { ...event, registeredCount: event.registeredCount + 1 }
          : event
      )));
    } catch (registrationError) {
      setError(registrationError?.response?.data?.error || "Could not register for this event.");
    } finally {
      setRegistering(null);
    }
  }

  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>
      {browseEnabled ? (
        <section aria-labelledby="attendee-browse-heading">
          <h2 id="attendee-browse-heading">Browse Open Events</h2>
          <p>Find events that are open for registration.</p>
          <Link className="dashboard--attendee__browse-link" to={BROWSE_OPEN_EVENTS_PATH}>
            Browse Open Events
          </Link>
        </section>
      ) : (
        <section aria-labelledby="attendee-browse-heading">
          <h2 id="attendee-browse-heading">Open for registration</h2>
          <p>Events are listed only while registration is open and capacity remains.</p>
          {loading && <p>Loading open events...</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && events.length === 0 && (
            <div className="attendee-open-events__empty" role="status">
              <p>There are no events open for registration right now.</p>
              <p>An event appears here only when it is Confirmed, registration is on, the opening time has passed, the closing time has not passed, and capacity remains.</p>
              <p>If the organiser has just changed the event or its settings, refresh this page and check again.</p>
            </div>
          )}
          <ul className="attendee-open-events__list">
            {events.map((event) => {
              const hasRegistered = registered.includes(event.id);
              const isOpen = expanded === event.id;
              return (
                <li key={event.id} className="attendee-open-events__item">
                  <div className="attendee-open-events__head">
                    <h3>{event.eventName}</h3>
                    {hasRegistered ? (
                      <span className="attendee-open-events__registered">Registered</span>
                    ) : (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : event.id)}
                      >
                        {isOpen ? "Hide" : "Register"}
                      </button>
                    )}
                  </div>
                  {isOpen && !hasRegistered && (
                    <div className="attendee-open-events__details">
                      {event.description && <p>{event.description}</p>}
                      <dl>
                        <div><dt>Event starts</dt><dd>{displayDate(event.startsAt)}</dd></div>
                        <div><dt>Registration closes</dt><dd>{displayDate(event.registrationClosesAt)}</dd></div>
                        <div>
                          <dt>Registered</dt>
                          <dd>
                            {event.registeredCount}
                            {event.capacity ? ` / ${event.capacity}` : ""}
                          </dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        disabled={registering === event.id}
                        onClick={() => handleRegister(event.id)}
                      >
                        {registering === event.id ? "Registering..." : "Confirm registration"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <NotificationInbox />
    </div>
  );
}
