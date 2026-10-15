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
import DecisionOutcome from "./DecisionOutcome";
import ClarificationHistoryDialog from "./ClarificationHistoryDialog";
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
function CoordinatorDetails({ eventRequestId, currentCoordinatorId }) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className="my-event-requests__details"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Your coordinator and assignment history</summary>
      {/* SCRUM-486 TR-03: who holds it now comes from the request, so a
          resubmitted request waiting for the Lead is not shown as still
          held by its old coordinator. */}
      {opened && (
        <AssignmentHistory eventRequestId={eventRequestId} view="organiser" currentCoordinatorId={currentCoordinatorId} />
      )}
    </details>
  );
}

/**
 * SCRUM-486 (SCRUM-520), AC1-05: where a submitted request stands with its
 * coordinator, said on the row, or null when there is nothing to add.
 *
 * Since migration 052 "submitted" covers two situations an Organiser needs to
 * tell apart: nobody has been assigned yet (the Event Coordinator Lead will
 * choose someone), or a coordinator has been and has not started the review.
 * Before SCRUM-486 they were one situation, because a coordinator was assigned
 * in the same transaction as the submission.
 *
 * A line of its own, beside the status, rather than a status display that
 * takes the assignment into account. The display (getStatusDisplay in the
 * backend's domain/eventRequestStatus.js, SCRUM-14's) is keyed on the status
 * alone and is "the one definition of these words" for every screen: it has
 * three call sites in the backend, one of which (withStatusDisplay) puts it on
 * all sixteen event-request responses, and five frontend screens render it,
 * three of them the coordinators' (ReviewQueue, MyAssignedEvents,
 * CoordinatorRequestDetail). Making it depend on the assignment
 * would mean every one of those passing the coordinator in, including
 * GET /:id/status, which reads only the status, or two responses describing
 * the same request differently. And the assignment is not a status: 052
 * deliberately added none. The shared description, "waiting to be picked up
 * by a Coordinator", is still true in both situations; this line says which.
 *
 * Only for "submitted". Under review, pending clarification, approved and
 * confirmed always have a coordinator (052's relaxed constraint still requires
 * one), and the status itself says what is happening; a draft or a cancelled
 * request is waiting for nobody.
 */
function assignmentLine(request) {
  if (request.status !== "submitted") return null;

  if (request.assignedCoordinatorId == null) {
    return "Waiting for the Event Coordinator Lead to assign a coordinator to your request.";
  }

  // AC1-06: named, from the list's own read (assignedCoordinatorName). A
  // coordinator with no name on record is still said to be assigned, never
  // shown as "null".
  const who = request.assignedCoordinatorName ?? "A coordinator";
  return `${who} has been assigned; your request is waiting for them to start the review.`;
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
  // SCRUM-172 (AC7): a notification opened from the inbox names the event to
  // show. Read once, like the clarification shortcut, because the state is
  // cleared below.
  const pendingFocusId = useRef(location.state?.focusEventRequestId ?? null);
  const [focusedId, setFocusedId] = useState(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const focusedRowRef = useRef(null);

  useEffect(() => {
    if (
      location.state?.openNewEventRequest ||
      location.state?.openClarificationRequestId ||
      location.state?.focusEventRequestId
    ) {
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
      // Not in the list means not theirs or gone; say so rather than land on
      // the list as if the link had worked.
      if (pendingFocusId.current) {
        const found = data.some((item) => item.id === pendingFocusId.current);
        setFocusedId(found ? pendingFocusId.current : null);
        setFocusMissing(!found);
      }
      pendingFocusId.current = null;
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

  // jsdom has no scrollIntoView, hence the guard.
  useEffect(() => {
    if (focusedId) focusedRowRef.current?.scrollIntoView?.({ block: "center" });
  }, [focusedId]);

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
      {focusMissing && <p role="status">That event is no longer in your list.</p>}

      {!loading && !error && requests.length === 0 && (
        <p>You haven't created any event requests yet.</p>
      )}

      <ul className="my-event-requests__list">
        {requests.map((req) => {
          // The labels and descriptions come from the API now (SCRUM-42), so
          // this component no longer interprets a status itself.
          const display = readStatusDisplay(req);
          const assignment = assignmentLine(req);
          return (
            <li
              key={req.id}
              ref={req.id === focusedId ? focusedRowRef : undefined}
              className={
                req.id === focusedId
                  ? "my-event-requests__item my-event-requests__item--focused"
                  : "my-event-requests__item"
              }
            >
              <div className="my-event-requests__item-main">
                <strong>{req.eventName}</strong>
                <span className={`status-badge ${statusClassName(display.group)}`}>
                  {display.label}
                </span>
              </div>
              <p className="my-event-requests__item-description">
                {display.description}
              </p>
              {assignment && (
                <p className="my-event-requests__assignment">{assignment}</p>
              )}

              {req.status === "pending_clarification" && req.clarificationNote && (
                <div className="my-event-requests__clarification" role="status">
                  <strong>Coordinator question</strong>
                  <p>{req.clarificationNote}</p>
                </div>
              )}
              {req.status === "pending_clarification" && req.clarificationReplyByDate && (
                <p className="my-event-requests__clarification">
                  Please respond by {formatEventDate(req.clarificationReplyByDate)}.
                  {req.clarificationReplyByDate < new Date().toISOString().slice(0, 10) && (
                    <strong className="clarification-overdue"> Overdue</strong>
                  )}
                </p>
              )}

              {/* SCRUM-133, for SCRUM-19 AC10: once decided, the outcome, the
                  reason or note, and who decided, on the row itself rather than
                  behind a <details>. The coordinator history beside it is
                  collapsed because it is background; the decision is the news
                  this Organiser came back to read, and a rejection's reason is
                  what they need to act on. A rejected request's own status
                  description already says "See the Coordinator notes for the
                  reason", so the reason belongs where that sentence points.

                  Shown whenever a decision is recorded, whatever the status
                  now is, as on the coordinator's panel. The decider's name is
                  one read of the assignment history, made only for decided
                  rows, once per page visit (DecisionOutcome explains where the
                  name comes from). */}
              {req.decision && (
                <div className="my-event-requests__decision">
                  <strong>Decision</strong>
                  <DecisionOutcome request={req} view="organiser" />
                </div>
              )}

              {req.status === "cancelled" && (
                <div className="my-event-requests__cancellation">
                  <strong>Event cancelled</strong>
                  <dl>
                    <dt>Reason</dt>
                    <dd>{req.cancellationReason || "No reason recorded."}</dd>
                    <dt>Cancelled on</dt>
                    <dd>{formatEventDate(req.cancelledAt)}</dd>
                  </dl>
                </div>
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

              {/* Not on a draft: a draft has never had a coordinator, so it has
                  no history to show. (Since 052 a submitted request may not
                  have one yet either; its history then says so, and the line
                  above has already told the Organiser why.) */}
              {req.status !== "draft" && (
                <CoordinatorDetails eventRequestId={req.id} currentCoordinatorId={req.assignedCoordinatorId ?? null} />
              )}
              {req.status !== "draft" && (
                <ClarificationHistoryDialog
                  eventRequestId={req.id}
                  eventName={req.eventName}
                  isOpenQuestion={req.status === "pending_clarification"}
                  latestQuestion={req.clarificationNote}
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

                {req.status !== "draft" &&
                  req.status !== "pending_clarification" &&
                  req.status !== "cancelled" && (
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
