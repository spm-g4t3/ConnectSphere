import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getAttendeeEvent } from "../services/attendeeEventService";
import { REGISTERED_EVENTS_PATH } from "../services/attendeeEventRoutes";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import { EVENT_TIME_NOTE, formatEventDate, formatEventStartTime, formatEventEndTime } from "../services/openEventDisplay";
import useOpenEventRead from "./useOpenEventRead";
import WithdrawRegistration from "./WithdrawRegistration";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { SESSION_EXPIRED } from "../services/apiErrors";

const MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Attendees can view this event information.",
};
const FALLBACK = "Event information could not be loaded. Please try again.";

function EventInformation({ eventId }) {
  const fetchEvent = useCallback(() => getAttendeeEvent(eventId), [eventId]);
  const { data, loading, notFound, error, load } = useOpenEventRead(fetchEvent, {
    messages: MESSAGES, fallback: FALLBACK, notFoundIsAnswer: true, retainDataOnRefresh: false,
  });
  useRefetchOnReturn(load);
  // The backend's reply to a withdrawal; set only once it has succeeded.
  const [withdrawal, setWithdrawal] = useState(null);
  // A final refusal, kept here because a reload remounts the action, keyed by
  // registration so a new registration starts with the action offered again.
  const [refusal, setRefusal] = useState(null);
  // Only a reply for this route's event may name it.
  const current = data?.eventRequestId === eventId.trim().toLowerCase() ? data : null;
  const handleWithdrawn = (result) => {
    // The name is kept: the re-read no longer returns this event to a withdrawn attendee.
    setWithdrawal({ ...result, eventName: current?.eventName });
    load();
  };
  // Only while the server shows no active registration; a later read that
  // shows one again (registered anew) must not sit beside a withdrawn notice.
  const withdrawn = withdrawal && !current ? withdrawal : null;
  return (
    <>
      <h1>{current?.eventName?.trim() || withdrawn?.eventName?.trim() || "Event information"}</h1>
      <section aria-label="Registered event information">
        {loading && <p role="status">Loading...</p>}
        {/* From the backend's reply alone, so a failed reload cannot hide it. */}
        {withdrawn && (
          <div className="browse-event-details__success" role="status">
            <p>Your registration has been withdrawn.</p>
            <dl className="browse-event-details__facts">
              <div><dt>Registration status</dt><dd>Withdrawn</dd></div>
            </dl>
            <p><Link to={BROWSE_OPEN_EVENTS_PATH}>Browse open events</Link></p>
          </div>
        )}
        {!withdrawn && notFound && <p role="alert">Event information is unavailable. An active registration is required.</p>}
        {error && (
          <div className="browse-open-events__error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={load}>Try again</button>
          </div>
        )}
        {/* SCRUM-434 AC5: the coordinator's optional message only; the internal reason never reaches this screen. */}
        {!loading && !error && current?.state === "cancelled" && (
          <div role="status" className="attendee-event-information__cancelled">
            <p>This event has been cancelled.</p>
            {current.message && (
              <>
                <h2>Message from the coordinator</h2>
                <p className="attendee-event-information__message">{current.message}</p>
              </>
            )}
          </div>
        )}
        {!loading && !error && data && current?.state !== "cancelled" && (!current || current.state !== "confirmed"
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
        {/* SCRUM-434 AC5: a cancelled event shows the cancellation and the message only, so no withdrawal is offered. */}
        {!loading && !error && current?.registrationId && current.state !== "cancelled" && (
          <WithdrawRegistration
            registrationId={current.registrationId}
            refusal={refusal?.registrationId === current.registrationId ? refusal.message : null}
            onWithdrawn={handleWithdrawn}
            onRefused={(message) => setRefusal({ registrationId: current.registrationId, message })}
          />
        )}
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
