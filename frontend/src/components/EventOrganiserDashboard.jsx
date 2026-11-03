// EventOrganiserDashboard.jsx

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyEventRequests } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusTone,
} from "../services/eventRequestStatusDisplay";
import { formatDateTime, formatDay } from "../services/displayFormat";
import { isReplyOverdue } from "../services/datetimeFormat";
import { canRetryRead } from "../services/apiErrors";
import NotificationInbox from "./NotificationInbox";
import SafetyApprovalNotice from "./SafetyApprovalNotice";
import NeedsAttentionBadge from "./NeedsAttentionBadge";
import StatusBadge from "./ui/StatusBadge";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";

export default function EventOrganiserDashboard({ user }) {
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState(null); // { message, retryable }

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      setEvents(await getMyEventRequests());
    } catch (err) {
      setEventsError({ message: "Could not load your event requests.", retryable: canRetryRead(err) });
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents, user.id]);

  useRefetchOnReturn(fetchEvents);
  const { headingRef, retry } = useFocusAfterRetry(fetchEvents);
  const showEmptyEvents = !eventsLoading && !eventsError && events.length === 0;

  const deadlines = events
    .filter((event) => event.status === "pending_clarification")
    .sort((first, second) => {
      const firstDeadline = first.clarificationReplyByDate
        ? new Date(`${first.clarificationReplyByDate}T00:00:00.000Z`).getTime()
        : first.proposedStart ? new Date(first.proposedStart).getTime() : Infinity;
      const secondDeadline = second.clarificationReplyByDate
        ? new Date(`${second.clarificationReplyByDate}T00:00:00.000Z`).getTime()
        : second.proposedStart ? new Date(second.proposedStart).getTime() : Infinity;
      return firstDeadline - secondDeadline;
    });

  const createEventLink = (
    <Link
      className="ui-button ui-button--primary"
      to="/events"
      state={{ openNewEventRequest: true }}
    >
      + Create new event
    </Link>
  );

  return (
    <div className="dashboard dashboard--organiser">
      <h1 ref={headingRef} tabIndex={-1}>Welcome, {user.name}</h1>

      {/* Once, above both sections: both are read from the same list. */}
      {eventsError && (
        <ErrorNotice message={eventsError.message} onRetry={eventsError.retryable ? retry : undefined} />
      )}

      {/* First, because a clarification waiting on the Organiser blocks the review. */}
      <section>
        <h2>Needs your response</h2>
        <ul>
          {deadlines.map((event) => {
            return (
              <li key={event.id} className="dashboard--organiser__deadline-row">
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{event.clarificationNote || "The Event Coordinator requested an amendment."}</p>
                </div>
                <div className="dashboard--organiser__deadline-meta">
                  <StatusBadge tone="warning">
                    {event.clarificationReplyByDate
                      ? isReplyOverdue(event.clarificationReplyByDate)
                        ? "Overdue since"
                        : "Reply by"
                      : "Amend before event starts"}
                  </StatusBadge>
                  <span>
                    {event.clarificationReplyByDate
                      ? formatDay(event.clarificationReplyByDate)
                      : formatDateTime(event.proposedStart, "Date not set")}
                  </span>
                </div>
                <Link
                  to="/events"
                  state={{ openClarificationRequestId: event.id }}
                  className="ui-button ui-button--link"
                >
                  Respond in My Events
                </Link>
              </li>
            );
          })}
        </ul>
        {eventsLoading && <LoadingText />}
        {!eventsLoading && !eventsError && deadlines.length === 0 && (
          <EmptyState
            message="No outstanding amendments before your event dates."
            nextStep="When a Coordinator asks you a question about an event, it will appear here."
          />
        )}
      </section>

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
                      <StatusBadge tone={statusTone(statusDisplay.group)}>
                        {statusDisplay.label}
                      </StatusBadge>
                      <NeedsAttentionBadge event={event} />
                    </span>
                    <span className="dashboard--organiser__event-date">
                      {formatDateTime(event.proposedStart, "Date not set")}
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
                    <dd>{formatDateTime(event.proposedStart, "Date not set")}</dd>
                    <dt>Proposed end</dt>
                    <dd>{formatDateTime(event.proposedEnd, "Date not set")}</dd>
                    <dt>Expected attendance</dt>
                    <dd>{event.expectedAttendance ?? "Not specified"}</dd>
                    <dt>Venue requirements</dt>
                    <dd>{event.venueRequirements || "Not specified"}</dd>
                    <dt>Accessibility requirements</dt>
                    <dd>{event.accessibilityRequirements || "Not specified"}</dd>
                    <dt>Equipment requirements</dt>
                    <dd>{event.equipmentRequirements || "Not specified"}</dd>
                  </dl>
                  <SafetyApprovalNotice status={event.status} />
                  {event.clarificationNote && (
                    <p className="dashboard--organiser__clarification">
                      <strong>Coordinator clarification:</strong> {event.clarificationNote}
                    </p>
                  )}
                  {event.clarificationReplyByDate && (
                    <p className="dashboard--organiser__clarification">
                      Reply by {formatDay(event.clarificationReplyByDate)}
                      {isReplyOverdue(event.clarificationReplyByDate) && (
                        <strong className="clarification-overdue"> — Overdue</strong>
                      )}
                    </p>
                  )}
                  {/* My Events scrolls to and highlights the row it is sent to. */}
                  <Link
                    to="/events"
                    state={{ focusEventRequestId: event.id }}
                    className="ui-button ui-button--link"
                  >
                    Open in My Events
                  </Link>
                </details>
              </li>
            );
          })}
        </ul>
        {eventsLoading && <LoadingText />}
        {/* The empty state carries the create link, so it is not shown twice. */}
        {showEmptyEvents ? (
          <EmptyState
            message="You haven't created any events yet."
            nextStep="Create an event request to get started."
            action={createEventLink}
          />
        ) : (
          createEventLink
        )}
      </section>
      <NotificationInbox />
    </div>
  );
}
