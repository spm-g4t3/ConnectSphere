import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyEventRequests } from "../services/eventRequestService";
import { isRegistrationConfigurable } from "../services/registrationStatuses";
import { readStatusDisplay } from "../services/eventRequestStatusDisplay";
import { formatDateTime } from "../services/displayFormat";
import { canRetryRead } from "../services/apiErrors";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";

export default function RegistrationEventsList() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { message, retryable }

  const loadEvents = useCallback((isActive = () => true) =>
    getMyEventRequests()
      .then((data) => {
        if (isActive()) setEvents(data.filter((req) => isRegistrationConfigurable(req.status)));
      })
      .catch((err) => {
        if (isActive()) setError({ message: "Could not load your events.", retryable: canRetryRead(err) });
      })
      .finally(() => {
        if (isActive()) setLoading(false);
      }), []);

  useEffect(() => {
    let active = true;
    loadEvents(() => active);
    return () => {
      active = false;
    };
  }, [loadEvents]);

  function reloadEvents() {
    setLoading(true);
    setError(null);
    return loadEvents();
  }
  const { headingRef, retry } = useFocusAfterRetry(reloadEvents);

  return (
    <main className="event-registration-page">
      <h1 ref={headingRef} tabIndex={-1}>Event registration</h1>
      <p>
        Choose an event to set up its registration. Attendees can register only once the event is Confirmed.
      </p>
      {loading && <LoadingText />}
      {error && <ErrorNotice message={error.message} onRetry={error.retryable ? retry : undefined} />}
      {!loading && !error && events.length === 0 && (
        <EmptyState
          message="None of your events can have registration set up yet."
          nextStep="An event must be Approved, in Safety review, Safety approved or Confirmed."
        />
      )}
      {events.length > 0 && (
        <ul className="registration-events-list">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.eventName}</strong>
              <span> · {readStatusDisplay(event).label} · {formatDateTime(event.proposedStart, "Start not set")} </span>
              <Link className="ui-button ui-button--secondary" to={`/events/${event.id}/registration`}>Configure registration</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
