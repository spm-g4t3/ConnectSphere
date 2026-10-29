// ReviewQueue.jsx
//
// SCRUM-45: every event request awaiting a decision, from every Organiser,
// oldest waiting first — and the detail panel one opens into.
//
// This is the fix for the reported bug. The Coordinator dashboard used to
// call getEventsNeedingAttention, a stub that console.warn'd and returned []
// and did not even accept the user.id it was handed, over a backend where
// every read was scoped to one organiser_id. An Organiser submitted a request
// and nobody on the Coordinator side could see it, because no read existed
// that crossed Organisers at all. GET /event-requests/queue is that read.
//
// Lifted into its own component rather than left inline on
// EventCoordinatorDashboard, for the reason VenueCatalogue was: this is the
// only part of that screen with a route of its own (/review-queue), and
// inline it would mean that route rendering a second copy of the greeting and
// the notifications card.
//
// It renders a <section> and NOT the `dashboard dashboard--coordinator`
// wrapper, so the card styling and the badge rules both come from whichever
// parent mounted it. That is why App.jsx's /review-queue route has to supply
// the wrapper itself: App.css scopes .status-badge to a dashboard class
// deliberately (blast-radius control — see its own comment), so without one
// every badge here renders as bare text.

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { getEventRequestQueue } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";
import CoordinatorRequestDetail from "./CoordinatorRequestDetail";
import useListRead from "./useListRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";

// Keyed by status, the same shape as VenueCatalogue's RETIRE_ERROR_MESSAGES
// and AuthContext's LOGIN_ERROR_MESSAGES.
//
// 403 is the interesting one and the reason a map beats a single line. This
// is the only role-gated read the app makes, so a 403 means the account's
// role is not event_coordinator — an administration problem, not a breakage.
// "Could not load the queue" would send the wrong person looking.
const QUEUE_ERROR_MESSAGES = {
  403: "Only Event Coordinators can see the review queue.",
  500: "The review queue could not be loaded. Please try again.",
};

export default function ReviewQueue() {
  const location = useLocation();
  // Which panel is open, if any: { mode: "detail", request } | null. The same
  // full-page-panel-with-a-back-button pattern MyEventRequests and
  // VenueCatalogue use — there is not one modal, <dialog> or window.confirm
  // anywhere in this frontend and this is not the place to introduce the
  // first.
  const [activePanel, setActivePanel] = useState(() =>
    location.state?.request
      ? { mode: "detail", request: location.state.request }
      : null,
  );

  const {
    data: queue,
    loading,
    error,
    load: fetchQueue,
  } = useListRead(getEventRequestQueue, {
    messages: QUEUE_ERROR_MESSAGES,
    fallback: "The review queue could not be loaded. Please try again.",
  });

  // Refetch when the Coordinator comes back to the tab — the same mechanism
  // MyEventRequests uses, and here for a stronger reason. There, an Organiser
  // might have had a request moved out from under them. Here the entire
  // content of the screen is work other people create while the Coordinator
  // is not looking at it: "what arrived while I was away" is the question
  // this page exists to answer, so the moment worth re-reading on is the
  // moment they look at it. One request per visit, not one every few seconds
  // per open tab.
  useRefetchOnReturn(fetchQueue);

  if (activePanel?.mode === "detail") {
    return (
      <section>
        <button className="review-queue__back" onClick={() => setActivePanel(null)}>
          &larr; Back to the review queue
        </button>
        <CoordinatorRequestDetail
          request={activePanel.request}
          onReviewDecisionProcessed={() => {
            setActivePanel(null);
            fetchQueue();
          }}
          onChangeRequestProcessed={async () => {
            const refreshedQueue = await fetchQueue();
            const refreshedRequest = refreshedQueue?.find(
              (item) => item.id === activePanel.request.id,
            );
            if (refreshedRequest) {
              setActivePanel((current) =>
                current ? { ...current, request: refreshedRequest } : current,
              );
            }
          }}
        />
      </section>
    );
  }

  return (
    <section>
      <h2>Review queue</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="review-queue__error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && queue.length === 0 && (
        <p>Nothing is waiting for review right now.</p>
      )}

      {/* Oldest waiting first, ordered by the backend on submitted_at and
          deliberately not re-sorted here. "Who has waited longest" is a fact
          about the data, and a second opinion about it in the client is how
          two screens start disagreeing. */}
      <ul>
        {queue.map((request) => {
          // Labels and descriptions come from the API, so this component
          // never interprets a status itself.
          const display = readStatusDisplay(request);
          return (
            <li key={request.id}>
              <span>
                <strong>{request.eventName}</strong>
                <span className={`status-badge ${statusClassName(display.group)}`}>
                  {display.label}
                </span>
              </span>
              <button onClick={() => setActivePanel({ mode: "detail", request })}>
                Review
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
