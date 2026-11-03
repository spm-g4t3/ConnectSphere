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
// wrapper, so the card styling comes from whichever parent mounted it. That is
// why App.jsx's /review-queue route supplies the wrapper itself.

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { getEventRequestQueue } from "../services/eventRequestService";
import { readStatusDisplay, statusTone } from "../services/eventRequestStatusDisplay";
import CoordinatorRequestDetail from "./CoordinatorRequestDetail";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";
import useFocusAfterRetry from "./useFocusAfterRetry";
import useListRead from "./useListRead";
import useReturnFocus from "./useReturnFocus";
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
  500: "The review queue could not be loaded.",
};

/**
 * @param {object} props
 * @param {boolean} [props.asPage]  true at /review-queue, where the title is the
 *                                  page's h1; on the dashboard it is h2
 */
export default function ReviewQueue({ asPage = false } = {}) {
  const location = useLocation();
  // Which panel is open, if any: { mode: "detail", request } | null. The same
  // full-page-panel-with-a-back-button pattern MyEventRequests and
  // VenueCatalogue use.
  const [activePanel, setActivePanel] = useState(() =>
    location.state?.request
      ? { mode: "detail", request: location.state.request }
      : null,
  );

  const {
    data: queue,
    loading,
    error,
    retryable,
    load: fetchQueue,
  } = useListRead(getEventRequestQueue, {
    messages: QUEUE_ERROR_MESSAGES,
    fallback: "The review queue could not be loaded.",
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

  // Try again goes away as its read starts, so focus moves to the title.
  const { headingRef, retry } = useFocusAfterRetry(fetchQueue);
  // Back puts focus on the row's Review button, or on the title once the row has left the queue.
  const openId = activePanel?.mode === "detail" ? activePanel.request.id : null;
  const { listHeadingRef, rowRef, returnFocusTo } = useReturnFocus(openId, loading);
  function titleRef(node) {
    headingRef.current = node;
    listHeadingRef.current = node;
  }
  function closeDetail() {
    returnFocusTo(openId);
    setActivePanel(null);
  }
  const Title = asPage ? "h1" : "h2";

  // On its own page the h1 stays above the panel, so the page keeps its one h1.
  if (activePanel?.mode === "detail") {
    return (
      <section className="review-queue">
        {asPage && <h1>Review queue</h1>}
        <Button variant="link" onClick={closeDetail}>
          &larr; Back to the review queue
        </Button>
        <CoordinatorRequestDetail
          request={activePanel.request}
          focusOnOpen
          onReviewDecisionProcessed={() => {
            closeDetail();
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
    <section className="review-queue">
      <Title ref={titleRef} tabIndex={-1}>
        Review queue
      </Title>

      {loading && <LoadingText />}
      {/* Hidden while a read is in flight, so Try again cannot start a second one. */}
      {error && !loading && <ErrorNotice message={error} onRetry={retryable ? retry : undefined} />}
      {!loading && !error && queue.length === 0 && (
        <EmptyState
          message="Nothing is waiting for review right now."
          nextStep="Requests appear here when they are waiting for your decision."
        />
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
              <span className="review-queue__title">
                <strong>{request.eventName}</strong>
                <StatusBadge tone={statusTone(display.group)}>{display.label}</StatusBadge>
              </span>
              <Button ref={rowRef(request.id)} onClick={() => setActivePanel({ mode: "detail", request })}>
                Review
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
