import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getAttendeeEvent } from "../services/attendeeEventService";
import { REGISTERED_EVENTS_PATH } from "../services/attendeeEventRoutes";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";
import { EVENT_TIME_NOTE, formatEventWhen } from "../services/openEventDisplay";
import useOpenEventRead from "./useOpenEventRead";
import WithdrawRegistration from "./WithdrawRegistration";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";
import useFocusAfterRetry from "./useFocusAfterRetry";

const MESSAGES = {
  403: "Only Attendees can view this event information.",
};
const FALLBACK = "Event information could not be loaded. Please try again.";

const BODY_STATES = ["cancelled", "confirmed"];
const bodyState = (current) => (BODY_STATES.includes(current?.state) ? current.state : "unconfirmed");

function EventBody({ state, current }) {
  switch (state) {
    case "cancelled":
      // SCRUM-434 AC5: the coordinator's optional message only; the internal reason never reaches this screen.
      // Only the cancellation line is a live region, so a screen reader announces it and not the whole panel.
      return (
        <div className="attendee-event-information__cancelled">
          <p role="status">This event has been cancelled.</p>
          {current.message && (
            <>
              <h2>Message from the coordinator</h2>
              <p className="attendee-event-information__message">{current.message}</p>
            </>
          )}
        </div>
      );
    case "confirmed":
      return (
        <>
          <h2>Confirmed arrangements</h2>
          <dl className="browse-event-details__facts">
            <div><dt>When</dt><dd>{formatEventWhen(current.startsAt, current.endsAt)} {EVENT_TIME_NOTE}</dd></div>
          </dl>
          <h2 id="attendee-confirmed-venues-heading">Venues</h2>
          {current.venues.length ? <ul aria-labelledby="attendee-confirmed-venues-heading">{current.venues.map(venue => (
            <li key={venue.bookingId}>
              <strong>{venue.name?.trim() || "Venue name unavailable"}</strong>
              <p className="attendee-event-information__location">{venue.location?.trim() || "Location unavailable"}</p>
              {venue.underReview === true && <p>This venue is being reviewed and may change.</p>}
            </li>
          ))}</ul> : (
            <EmptyState
              message="No confirmed venue information is available."
              nextStep="Check back later; this page shows the venue once it is confirmed."
            />
          )}
        </>
      );
    default:
      return <p role="status">Event details are not currently confirmed.</p>;
  }
}

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
  const withdrawnRef = useRef(null);
  // The withdraw section that had focus is replaced by this notice, so focus moves to it.
  useEffect(() => {
    if (withdrawn) withdrawnRef.current?.focus();
  }, [withdrawn]);
  // Focus goes to the page title after Try again: this section has no heading.
  const { headingRef, retry } = useFocusAfterRetry(load);
  // One state decides the body: cancelled, confirmed, or anything else (not confirmed).
  // A reply for another event, or a state this screen does not know, reads as not confirmed.
  const view = !loading && !error && data ? bodyState(current) : null;
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>{current?.eventName?.trim() || withdrawn?.eventName?.trim() || "Event information"}</h1>
      <section aria-label="Registered event information">
        {loading && <LoadingText />}
        {/* From the backend's reply alone, so a failed reload cannot hide it. */}
        {withdrawn && (
          <div ref={withdrawnRef} tabIndex={-1} className="browse-event-details__success" role="status">
            <p>Your registration has been withdrawn.</p>
            <dl className="browse-event-details__facts">
              <div><dt>Registration status</dt><dd><StatusBadge tone="neutral">Withdrawn</StatusBadge></dd></div>
            </dl>
            <p><Link to={BROWSE_OPEN_EVENTS_PATH}>Browse open events</Link></p>
          </div>
        )}
        {/* A missing registration is the answer, not a failure, so there is nothing to try again. */}
        {!withdrawn && notFound && <ErrorNotice message="Event information is unavailable. An active registration is required." />}
        {error && <ErrorNotice message={error} onRetry={retry} />}
        {view && <EventBody state={view} current={current} />}
        {/* SCRUM-434 AC5: a cancelled event shows the cancellation and the message only, so no withdrawal is offered. */}
        {!loading && !error && current?.registrationId && view !== "cancelled" && (
          <WithdrawRegistration
            registrationId={current.registrationId}
            refusal={refusal?.registrationId === current.registrationId ? refusal.message : null}
            onWithdrawn={handleWithdrawn}
            onRefused={(message) => setRefusal({ registrationId: current.registrationId, message })}
          />
        )}
      </section>
      <p><Link className="ui-button ui-button--link" to={REGISTERED_EVENTS_PATH}>Back to registered events</Link></p>
    </>
  );
}

export default function AttendeeEventInformation() {
  const { eventId } = useParams();
  // A new route gets a new read state immediately, before effects or late replies.
  return <EventInformation key={eventId} eventId={eventId} />;
}
