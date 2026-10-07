// MyEventRequests.jsx
//
// The Organiser's hub for event requests — ties SCRUM-10/29 (create),
// SCRUM-11 (edit a draft), and SCRUM-32/34 (request/track changes after
// submission) together in one place.
//
// AC8: only the signed-in Organiser's own requests appear here. This relies
// on the backend scoping GET /event-requests to the authenticated session —
// there's no client-side filtering by organiser id, since the frontend
// should never be trusted to enforce that boundary itself.

import { useEffect, useState, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getMyEventRequests } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";
import EventRequestForm from "./EventRequestForm";
import ChangeRequestForm from "./ChangeRequestForm";
import ChangeRequestStatusList from "./ChangeRequestStatusList";
import AssignmentHistory from "./AssignmentHistory";
import ClarificationHistory from "./ClarificationHistory";
import ClarificationReplyForm from "./ClarificationReplyForm";

function formatEventDate(value) {
  if (!value) return "Not specified";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * SCRUM-334, for SCRUM-327 AC10: the Organiser sees who their coordinator is
 * and how the event got to them, without the handover notes.
 *
 * Inline on the event, collapsed, rather than a fifth panel. The four panels
 * this screen already has are all for doing something: create, edit, respond
 * to a clarification, request a change. This is reading a few lines, and a
 * panel would take the Organiser away from their list to read them. The
 * "Current event details" <details> beside it is the same kind of thing, read
 * on demand from the row, so this uses the same control.
 *
 * Loaded only once opened. The list has one row per request, and reading
 * every row's history on every load, and again on every tab focus, would be
 * one extra request per row for something most rows never open: the N+1 the
 * backend router's header warns about. The cost is that the coordinator's
 * name is behind one click. Showing it on the row itself without that cost
 * needs the backend to send the name with the Organiser's list, which is a
 * backend change and a follow-up. Once opened it stays loaded; closing and
 * reopening does not read it again.
 */
function CoordinatorDetails({ eventRequestId }) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className="my-event-requests__details"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Your coordinator and assignment history</summary>
      {opened && <AssignmentHistory eventRequestId={eventRequestId} view="organiser" />}
    </details>
  );
}

function ClarificationHistoryDetails({ eventRequestId, isOpen }) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className="my-event-requests__details"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Clarification history</summary>
      {opened && <ClarificationHistory eventRequestId={eventRequestId} isOpen={isOpen} />}
    </details>
  );
}

export default function MyEventRequests() {
  const location = useLocation();
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Which panel is open, if any: { mode: "create" } | { mode: "edit", request }
  // | { mode: "change-request", request } | null
  const [activePanel, setActivePanel] = useState(() =>
    location.state?.openNewEventRequest ? { mode: "create" } : null,
  );
  const pendingClarificationId = useRef(location.state?.openClarificationRequestId ?? null);

  useEffect(() => {
    if (location.state?.openNewEventRequest || location.state?.openClarificationRequestId) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyEventRequests();
      setRequests(data);
      const requestedEvent = pendingClarificationId.current
        ? data.find((item) => item.id === pendingClarificationId.current)
        : null;
      if (requestedEvent?.status === "pending_clarification") {
        setActivePanel({ mode: "clarification-response", request: requestedEvent });
      }
      pendingClarificationId.current = null;
      setError(null);
    } catch {
      setError("Could not load your event requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // AC4: the displayed status is updated when the event request changes.
  //
  // Refetch on view rather than polling on a timer or subscribing to a live
  // feed. A Coordinator moving a request is not something the Organiser is
  // sitting and watching for -- they come back to the page to find out. So the
  // moment worth re-reading on is the moment they look at it, which costs one
  // request per visit instead of one every few seconds per open tab.
  //
  // handleSaved already refetches after an edit, so changes made in this app
  // are covered; this covers changes made anywhere else.
  useEffect(() => {
    function refetchIfVisible() {
      if (document.visibilityState === "visible") fetchRequests();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [fetchRequests]);

  function handleSaved() {
    setActivePanel(null);
    fetchRequests();
  }

  if (activePanel?.mode === "create") {
    return (
      <div className="my-event-requests">
        <button className="my-event-requests__back" onClick={() => setActivePanel(null)}>&larr; Back to my requests</button>
        <EventRequestForm
          onSaved={(saved) => {
            fetchRequests();
            if (saved.status !== "draft") setActivePanel(null);
          }}
        />
      </div>
    );
  }

  if (activePanel?.mode === "edit") {
    return (
      <div className="my-event-requests">
        <button className="my-event-requests__back" onClick={() => setActivePanel(null)}>&larr; Back to my requests</button>
        <EventRequestForm existingRequest={activePanel.request} onSaved={handleSaved} />
      </div>
    );
  }

  if (activePanel?.mode === "clarification-response") {
    return (
      <div className="my-event-requests">
        <button className="my-event-requests__back" onClick={handleSaved}>&larr; Back to my requests</button>
        <ClarificationReplyForm request={activePanel.request} onSaved={handleSaved} />
      </div>
    );
  }

  if (activePanel?.mode === "change-request") {
    return (
      <div className="my-event-requests">
        <button className="my-event-requests__back" onClick={handleSaved}>&larr; Back to my requests</button>
        <h2>{activePanel.request.eventName}</h2>
        <ChangeRequestForm
          eventRequestId={activePanel.request.id}
          onSubmitted={handleSaved}
        />
        <ChangeRequestStatusList eventRequestId={activePanel.request.id} />
      </div>
    );
  }

  return (
    <div className="my-event-requests">
      <div className="my-event-requests__header">
        <h1>My event requests</h1>
        <button onClick={() => setActivePanel({ mode: "create" })}>
          + New event request
        </button>
      </div>

      {loading && <p>Loading...</p>}
      {error && <p className="my-event-requests__error">{error}</p>}

      {!loading && !error && requests.length === 0 && (
        <p>You haven't created any event requests yet.</p>
      )}

      <ul className="my-event-requests__list">
        {requests.map((req) => {
          // The labels and descriptions come from the API now (SCRUM-42), so
          // this component no longer interprets a status itself.
          const display = readStatusDisplay(req);
          return (
            <li key={req.id} className="my-event-requests__item">
              <div className="my-event-requests__item-main">
                <strong>{req.eventName}</strong>
                <span className={`status-badge ${statusClassName(display.group)}`}>
                  {display.label}
                </span>
              </div>
              <p className="my-event-requests__item-description">
                {display.description}
              </p>

              {req.status === "pending_clarification" && req.clarificationNote && (
                <p className="my-event-requests__clarification" role="alert">
                  <strong>Coordinator clarification:</strong> {req.clarificationNote}
                </p>
              )}
              {req.status === "pending_clarification" && req.clarificationReplyByDate && (
                <p className="my-event-requests__clarification">
                  Please respond by {req.clarificationReplyByDate}.
                  {req.clarificationReplyByDate < new Date().toISOString().slice(0, 10) && (
                    <strong className="clarification-overdue"> Overdue</strong>
                  )}
                </p>
              )}

              <details className="my-event-requests__details">
                <summary>Current event details</summary>
                <dl>
                  <dt>Purpose</dt>
                  <dd>{req.purpose || "Not specified"}</dd>
                  <dt>Description</dt>
                  <dd>{req.description || "Not specified"}</dd>
                  <dt>Proposed start</dt>
                  <dd>{formatEventDate(req.proposedStart)}</dd>
                  <dt>Proposed end</dt>
                  <dd>{formatEventDate(req.proposedEnd)}</dd>
                  <dt>Expected attendance</dt>
                  <dd>{req.expectedAttendance ?? "Not specified"}</dd>
                  <dt>Venue requirements</dt>
                  <dd>{req.venueRequirements || "Not specified"}</dd>
                  <dt>Accessibility requirements</dt>
                  <dd>{req.accessibilityRequirements || "Not specified"}</dd>
                  <dt>Equipment requirements</dt>
                  <dd>{req.equipmentRequirements || "Not specified"}</dd>
                </dl>
              </details>

              {/* Not on a draft: a coordinator is assigned at submission, so a
                  draft has nobody and no history to show. */}
              {req.status !== "draft" && <CoordinatorDetails eventRequestId={req.id} />}
              {req.status !== "draft" && (
                <ClarificationHistoryDetails
                  eventRequestId={req.id}
                  isOpen={req.status === "pending_clarification"}
                />
              )}

              <div className="my-event-requests__item-actions">
                {req.status === "draft" && (
                  <button onClick={() => setActivePanel({ mode: "edit", request: req })}>
                    Continue editing
                  </button>
                )}

                {req.status === "pending_clarification" && (
                  <button
                    onClick={() =>
                      setActivePanel({ mode: "clarification-response", request: req })
                    }
                  >
                    Respond to clarification
                  </button>
                )}

                {req.status !== "draft" && req.status !== "pending_clarification" && (
                  <button
                    onClick={() => setActivePanel({ mode: "change-request", request: req })}
                  >
                    Request a change
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
