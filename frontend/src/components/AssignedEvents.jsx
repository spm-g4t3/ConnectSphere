// AssignedEvents.jsx
//
// SCRUM-486 AC6: every event someone holds in an active status, earliest
// event first, for the Event Coordinator Lead, each opening the event's own
// page (/event-requests/:id), where the Lead hands it to another coordinator.
//
// Why it exists. The Lead could already reassign from that page (SCRUM-521),
// but nothing linked a Lead to it: an assigned request leaves the unassigned
// queue, and the coordinators' queue and My events are theirs. The Lead could
// reach an event only by typing its address, which is not "reassign events
// where necessary" (change 5). This is the smallest list that closes that: no
// filters, no counts, no actions of its own. It is the first slice of
// SCRUM-487 AC3's list, which will extend it rather than replace it.
//
// Built the way UnassignedQueue is: a <section> that takes its card styling
// and badge colours from the wrapper App.jsx mounts it in, a status-keyed
// error table, and loading, error and empty states said in words. The rows
// borrow My events' row classes, so the two lists of events look alike
// without a stylesheet of their own. No refetch on focus: the Lead leaves this
// page to act, and coming back mounts it again, which reads the list again.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import UnassignedCount from "./UnassignedCount";
import { listAssignedEventsForLead } from "../services/eventRequestService";
import { formatTimestamp } from "../services/displayFormat";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";

// 403 has its own words, as in UnassignedQueue: it means the account is not a
// Lead, an administration problem, not a breakage.
const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only the Event Coordinator Lead can see the assigned events.",
  500: "The assigned events could not be loaded. Please try again.",
};

export default function AssignedEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        setEvents(await listAssignedEventsForLead());
      } catch (err) {
        setError(
          LIST_ERROR_MESSAGES[err.response?.status] ||
            "The assigned events could not be loaded. Please try again.",
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  return (
    <section className="assigned-events">
      <h2>Assigned events</h2>

      {/* SCRUM-487 AC4 (SCRUM-543): the requests nobody holds yet, counted,
          with the way to the queue. Counted, not listed (SCRUM-487 D5): this
          list is of held events, and the queue is where the rest are acted on. */}
      <UnassignedCount />

      {loading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      {/* Nothing held is said, never left as an empty card that could be
          mistaken for a failed load. */}
      {!loading && !error && events.length === 0 && (
        <p>No coordinator is holding an active event.</p>
      )}

      {/* Earliest event first, as the server orders it; not re-sorted. */}
      <ul>
        {events.map((event) => {
          // Labels come from the API, so this component never interprets a status.
          const display = readStatusDisplay(event);

          return (
            <li key={event.id} className="my-assigned-events__row">
              <div className="my-assigned-events__summary">
                <span className="my-assigned-events__title">
                  <strong>{event.eventName}</strong>
                  <span className={`status-badge ${statusClassName(display.group)}`}>
                    {display.label}
                  </span>
                </span>
                <span className="my-assigned-events__meta">
                  <span>{formatTimestamp(event.proposedStart, "Date not set")}</span>
                  <span>Organiser: {event.organiserName ?? "No name on record"}</span>
                  <span>Coordinator: {event.assignedCoordinatorName ?? "No name on record"}</span>
                </span>
              </div>
              <Link to={`/event-requests/${event.id}`} aria-label={`Open ${event.eventName}`}>
                Open
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
