// EventOrganiserDashboard.jsx

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyEventRequests } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";

function formatEventDate(value) {
  if (!value) return "Date not set";

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function EventOrganiserDashboard({ user }) {
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    getMyEventRequests()
      .then((requests) => {
        if (!cancelled) {
          setEvents(requests);
          setEventsError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setEventsError("Could not load your event requests.");
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const deadlines = events
    .filter((event) => event.status === "pending_clarification")
    .sort((first, second) => {
      const firstStart = first.proposedStart ? new Date(first.proposedStart).getTime() : Infinity;
      const secondStart = second.proposedStart ? new Date(second.proposedStart).getTime() : Infinity;
      return firstStart - secondStart;
    });

  return (
    <div className="dashboard dashboard--organiser">
      <h1>Welcome, {user.name}</h1>

      <section>
        <h2>My events</h2>
        <ul>
          {events.map((event) => {
            const statusDisplay = readStatusDisplay(event);
            return (
              <li key={event.id} className="dashboard--organiser__event-row">
                <details className="dashboard--organiser__event-details">
                  <summary>
                    <span className="dashboard--organiser__event-summary">
                      <strong>{event.eventName}</strong>
                      <span className={`status-badge ${statusClassName(statusDisplay.group)}`}>
                        {statusDisplay.label}
                      </span>
                    </span>
                    <span className="dashboard--organiser__event-date">
                      {formatEventDate(event.proposedStart)}
                    </span>
                  </summary>
                  <dl>
                    <dt>Current status</dt>
                    <dd>{statusDisplay.description}</dd>
                    <dt>Purpose</dt>
                    <dd>{event.purpose || "Not specified"}</dd>
                    <dt>Description</dt>
                    <dd>{event.description || "Not specified"}</dd>
                    <dt>Proposed start</dt>
                    <dd>{formatEventDate(event.proposedStart)}</dd>
                    <dt>Proposed end</dt>
                    <dd>{formatEventDate(event.proposedEnd)}</dd>
                    <dt>Expected attendance</dt>
                    <dd>{event.expectedAttendance ?? "Not specified"}</dd>
                    <dt>Venue requirements</dt>
                    <dd>{event.venueRequirements || "Not specified"}</dd>
                    <dt>Accessibility requirements</dt>
                    <dd>{event.accessibilityRequirements || "Not specified"}</dd>
                    <dt>Equipment requirements</dt>
                    <dd>{event.equipmentRequirements || "Not specified"}</dd>
                  </dl>
                  {event.clarificationNote && (
                    <p className="dashboard--organiser__clarification">
                      <strong>Coordinator clarification:</strong> {event.clarificationNote}
                    </p>
                  )}
                  <Link to="/events" className="dashboard--organiser__manage-event">
                    Open in My Events
                  </Link>
                </details>
              </li>
            );
          })}
          {eventsLoading && <p>Loading your events...</p>}
          {eventsError && <p className="dashboard--organiser__error" role="alert">{eventsError}</p>}
          {!eventsLoading && !eventsError && events.length === 0 && (
            <p>You haven't created any events yet.</p>
          )}
        </ul>
        <Link
          className="dashboard--organiser__create-event"
          to="/events"
          state={{ openNewEventRequest: true }}
        >
          + Create new event
        </Link>
      </section>

      <section>
        <h2>Upcoming deadlines</h2>
        <ul>
          {deadlines.map((event) => {
            return (
              <li key={event.id} className="dashboard--organiser__deadline-row">
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{event.clarificationNote || "The Event Coordinator requested an amendment."}</p>
                </div>
                <div className="dashboard--organiser__deadline-meta">
                  <span className="deadline-tag">Amend before event starts</span>
                  <span>{formatEventDate(event.proposedStart)}</span>
                </div>
                <Link
                  to="/events"
                  state={{ openClarificationRequestId: event.id }}
                  className="dashboard--organiser__manage-event"
                >
                  Respond in My Events
                </Link>
              </li>
            );
          })}
          {!eventsLoading && deadlines.length === 0 && (
            <p>No outstanding amendments before your event dates.</p>
          )}
          {eventsLoading && <p>Checking for requested amendments...</p>}
          {eventsError && <p className="dashboard--organiser__error" role="alert">{eventsError}</p>}
        </ul>
      </section>
    </div>
  );
}
