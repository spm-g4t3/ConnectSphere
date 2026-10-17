import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyEventRequests } from "../services/eventRequestService";

// Statuses from which an Organiser can set up registration (SCRUM-494 AC2).
const CONFIGURABLE_STATUSES = ["approved", "safety_review", "safety_approved", "confirmed"];

function statusLabel(status) {
  const text = String(status).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatStart(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Start not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function RegistrationEventsList() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    getMyEventRequests()
      .then((data) => {
        if (active) setEvents(data.filter((req) => CONFIGURABLE_STATUSES.includes(req.status)));
      })
      .catch(() => {
        if (active) setError("Could not load your events.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="event-registration-page">
      <h1>Event registration</h1>
      <p>
        Choose an event to set up its registration. Attendees can register only once the event is Confirmed.
      </p>
      {loading && <p role="status">Loading your events…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && events.length === 0 && (
        <p>
          None of your events can have registration set up yet. An event must be Approved, in
          Safety review, Safety approved or Confirmed.
        </p>
      )}
      {events.length > 0 && (
        <ul className="registration-events-list">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.eventName}</strong>
              <span> · {statusLabel(event.status)} · {formatStart(event.proposedStart)} </span>
              <Link to={`/events/${event.id}/registration`}>Configure registration</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
