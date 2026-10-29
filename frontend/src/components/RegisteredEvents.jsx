import { Link } from "react-router-dom";
import { getRegisteredEvents } from "../services/attendeeEventService";
import { attendeeEventPath } from "../services/attendeeEventRoutes";
import useOpenEventRead from "./useOpenEventRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import WaitingListPlaces from "./WaitingListPlaces";

const MESSAGES = {
  403: "Only Attendees can view registered events.",
};
const FALLBACK = "Registered events could not be loaded. Please try again.";

export default function RegisteredEvents() {
  const { data, loading, error, refreshFailed, load } = useOpenEventRead(getRegisteredEvents, {
    messages: MESSAGES, fallback: FALLBACK,
  });
  const events = data ?? [];
  useRefetchOnReturn(load);
  return (
    <>
      <h1>Registered events</h1>
      <section aria-label="Your registered events">
        {loading && <p role="status">Loading...</p>}
        {(error || refreshFailed) && (
          <div className="browse-open-events__error" role="alert">
            <p>{error || "Could not refresh the list. Showing the events as last loaded."}</p>
            <button type="button" onClick={load}>Try again</button>
          </div>
        )}
        {!loading && !error && (
          events.length ? <ul>{events.map(event => (
            <li key={event.eventRequestId}>
              <Link to={attendeeEventPath(event.eventRequestId)}>{event.eventName || "Unnamed event"}</Link>
            </li>
          ))}</ul> : <p>You have no active event registrations.</p>
        )}
      </section>
      <WaitingListPlaces onChanged={load} />
    </>
  );
}
