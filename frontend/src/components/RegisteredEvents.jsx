import { Link } from "react-router-dom";
import { getRegisteredEvents } from "../services/attendeeEventService";
import { attendeeEventPath } from "../services/attendeeEventRoutes";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import useOpenEventRead from "./useOpenEventRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { SESSION_EXPIRED } from "../services/apiErrors";
import WaitingListPlaces from "./WaitingListPlaces";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import useFocusAfterRetry from "./useFocusAfterRetry";

const MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Attendees can view registered events.",
};
const FALLBACK = "Registered events could not be loaded. Please try again.";

export default function RegisteredEvents() {
  const { data, loading, error, refreshFailed, load } = useOpenEventRead(getRegisteredEvents, {
    messages: MESSAGES, fallback: FALLBACK,
  });
  const events = data ?? [];
  useRefetchOnReturn(load);
  const { headingRef, retry } = useFocusAfterRetry(load);
  return (
    <>
      <h1>Registered events</h1>
      <section aria-labelledby="registered-events-heading">
        <h2 ref={headingRef} tabIndex={-1} id="registered-events-heading">Registered</h2>
        {loading && <LoadingText />}
        {error && <ErrorNotice message={error} onRetry={error === SESSION_EXPIRED ? undefined : retry} />}
        {refreshFailed && (
          <div className="browse-open-events__notice" role="status">
            <p>Could not refresh the list. Showing the events as last loaded.</p>
            <Button variant="secondary" onClick={retry}>Try again</Button>
          </div>
        )}
        {!loading && !error && (
          events.length ? <ul>{events.map(event => (
            <li key={event.eventRequestId}>
              <Link to={attendeeEventPath(event.eventRequestId)}>{event.eventName || "Unnamed event"}</Link>
            </li>
          ))}</ul> : (
            <EmptyState
              message="You have no active event registrations."
              nextStep="Browse Open Events to find an event to register for."
              action={<Link className="ui-button ui-button--primary" to={BROWSE_OPEN_EVENTS_PATH}>Browse Open Events</Link>}
            />
          )
        )}
      </section>
      <WaitingListPlaces onChanged={load} />
    </>
  );
}
