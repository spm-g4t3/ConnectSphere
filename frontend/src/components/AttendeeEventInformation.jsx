import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { getAttendeeEvent } from "../services/attendeeEventService";
import { REGISTERED_EVENTS_PATH } from "../services/attendeeEventRoutes";
import { EVENT_TIME_NOTE, formatEventDate, formatEventStartTime, formatEventEndTime } from "../services/openEventDisplay";
import useOpenEventRead from "./useOpenEventRead";
import useRefreshOnReturn from "./useRefreshOnReturn";

const MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Attendees can view this event information.",
};
const FALLBACK = "Event information could not be loaded. Please try again.";

function EventInformation({ eventId }) {
  const fetchEvent = useCallback(() => getAttendeeEvent(eventId), [eventId]);
  const { data, loading, notFound, error, load } = useOpenEventRead(fetchEvent, {
    messages: MESSAGES, fallback: FALLBACK, notFoundIsAnswer: true, retainDataOnRefresh: false,
  });
  useRefreshOnReturn(load);
  // Only a reply for this route's event may name it.
  const current = data?.eventRequestId === eventId.trim().toLowerCase() ? data : null;
  return (
    <>
      <h1>{current?.eventName?.trim() || "Event information"}</h1>
      <section aria-label="Registered event information">
        {loading && <p role="status">Loading...</p>}
        {notFound && <p role="alert">Event information is unavailable. An active registration is required.</p>}
        {error && (
          <div className="browse-open-events__error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={load}>Try again</button>
          </div>
        )}
        {!loading && !error && data && (!current || current.state !== "confirmed"
          ? <p role="status">Event details are not currently confirmed.</p>
          : <>
            <h2>Confirmed arrangements</h2>
            <p>{EVENT_TIME_NOTE}</p>
            <dl className="browse-event-details__facts">
              <div><dt>Date</dt><dd>{formatEventDate(data.startsAt)}</dd></div>
              <div><dt>Start time</dt><dd>{formatEventStartTime(data.startsAt)}</dd></div>
              <div><dt>End time</dt><dd>{formatEventEndTime(data.startsAt, data.endsAt)}</dd></div>
            </dl>
            <h2 id="attendee-confirmed-venues-heading">Venues</h2>
            {data.venues.length ? <ul aria-labelledby="attendee-confirmed-venues-heading">{data.venues.map(venue => (
              <li key={venue.bookingId}>
                <strong>{venue.name?.trim() || "Venue name unavailable"}</strong>
                <p className="attendee-event-information__location">{venue.location?.trim() || "Location unavailable"}</p>
                {venue.underReview === true && <p>This venue is being reviewed and may change.</p>}
              </li>
            ))}</ul> : <p>No confirmed venue information is available.</p>}
          </>)}
      </section>
      <p><Link to={REGISTERED_EVENTS_PATH}>Back to registered events</Link></p>
    </>
  );
}

export default function AttendeeEventInformation() {
  const { eventId } = useParams();
  // A new route gets a new read state immediately, before effects or late replies.
  return <EventInformation key={eventId} eventId={eventId} />;
}
