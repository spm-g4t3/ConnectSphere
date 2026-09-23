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

import { useEffect, useState, useCallback } from "react";
import { getMyEventRequests } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";
import EventRequestForm from "./EventRequestForm";
import ChangeRequestForm from "./ChangeRequestForm";
import ChangeRequestStatusList from "./ChangeRequestStatusList";

export default function MyEventRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Which panel is open, if any: { mode: "create" } | { mode: "edit", request }
  // | { mode: "change-request", request } | null
  const [activePanel, setActivePanel] = useState(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyEventRequests();
      setRequests(data);
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
        <button onClick={() => setActivePanel(null)}>&larr; Back to my requests</button>
        <EventRequestForm onSaved={handleSaved} />
      </div>
    );
  }

  if (activePanel?.mode === "edit") {
    return (
      <div className="my-event-requests">
        <button onClick={() => setActivePanel(null)}>&larr; Back to my requests</button>
        <EventRequestForm existingRequest={activePanel.request} onSaved={handleSaved} />
      </div>
    );
  }

  if (activePanel?.mode === "change-request") {
    return (
      <div className="my-event-requests">
        <button onClick={() => setActivePanel(null)}>&larr; Back to my requests</button>
        <h2>{activePanel.request.eventName}</h2>
        <ChangeRequestForm
          eventRequestId={activePanel.request.id}
          onSubmitted={() => setActivePanel(null)}
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

              <div className="my-event-requests__item-actions">
                {req.status === "draft" && (
                  <button onClick={() => setActivePanel({ mode: "edit", request: req })}>
                    Continue editing
                  </button>
                )}

                {req.status !== "draft" && (
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
