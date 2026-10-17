import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getOpenRegistrationEvents,
  registerForEvent,
} from "../services/eventRegistrationService";
import { BROWSE_OPEN_EVENTS_PATH, isOpenEventsEnabled } from "../services/openEventRoutes";

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AttendeeDashboard({ user }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(null);
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
          <h2 id="attendee-browse-heading">Browse Open Events</h2>
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
          <ul>
            {events.map((event) => {
              const hasRegistered = registered.includes(event.id);
              return (
                <li key={event.id}>
                  <h3>{event.eventName}</h3>
                  {event.description && <p>{event.description}</p>}
                  <p>Event starts {displayDate(event.startsAt)}</p>
                  <p>Registration closes {displayDate(event.registrationClosesAt)}</p>
                  <p>
                    Registered: {event.registeredCount}
                    {event.capacity ? ` / ${event.capacity}` : ""}
                  </p>
                  <button
                    type="button"
                    disabled={hasRegistered || registering === event.id}
                    onClick={() => handleRegister(event.id)}
                  >
                    {hasRegistered ? "Registered" : registering === event.id ? "Registering..." : "Register"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}