import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSafetyReview,
  getSafetyReviewQueue,
} from "../services/safetyReviewService";
import NotificationInbox from "./NotificationInbox";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import { SafetyReviewDetail } from "./SafetyReviewDetail";
import { OUTCOME_LABELS, eventRange } from "./safetyReviewLabels";
import useReturnFocus from "./useReturnFocus";

function waitingLabel(seconds) {
  const elapsed = Math.max(0, Number(seconds) || 0);
  if (elapsed < 60) return "Less than a minute";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} minute${Math.floor(elapsed / 60) === 1 ? "" : "s"}`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} hour${Math.floor(elapsed / 3600) === 1 ? "" : "s"}`;
  const days = Math.floor(elapsed / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export default function SafetyOfficerDashboard({ user }) {
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState(null);
  // The review pane shows open, refresh and submit failures in one place, so
  // each carries the retry for what failed (none for a form error).
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [detailFocusRequest, setDetailFocusRequest] = useState(0);
  // The open event as of now, not as of a render: a reply for an event the
  // officer has since left must not land on the one now open.
  const selectedIdRef = useRef(null);
  const { listHeadingRef, rowRef, returnFocusTo } = useReturnFocus(selectedId, loading);

  const refreshQueue = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setQueue(await getSafetyReviewQueue());
    } catch (requestError) {
      setListError(requestError.response?.data?.error ?? "The safety review list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  function select(id) {
    selectedIdRef.current = id;
    setSelectedId(id);
  }

  function isOpen(id) {
    return selectedIdRef.current === id;
  }

  async function openReview(id) {
    select(id);
    setDetail(null);
    setMessage(null);
    setError(null);
    setDetailLoading(true);
    try {
      const fresh = await getSafetyReview(id);
      if (isOpen(id)) setDetail(fresh);
    } catch (requestError) {
      if (!isOpen(id)) return;
      setError({
        message: requestError.response?.data?.error ?? "The event's safety details could not be loaded.",
        retry: () => openReview(id),
      });
    } finally {
      if (isOpen(id)) setDetailLoading(false);
    }
  }

  async function reloadDetail(id, failureMessage, retried = false) {
    try {
      const fresh = await getSafetyReview(id);
      if (!isOpen(id)) return;
      setDetail(fresh);
      setError(null);
      // Try again had focus and has now gone, so focus returns to the event.
      if (retried) setDetailFocusRequest((count) => count + 1);
    } catch {
      if (isOpen(id)) setError({ message: failureMessage, retry: () => reloadDetail(id, failureMessage, true) });
    }
  }

  async function responseSubmitted(id, outcome) {
    if (isOpen(id)) {
      setMessage(`Response recorded: ${OUTCOME_LABELS[outcome]}.`);
      setError(null);
    }
    await Promise.all([
      refreshQueue(),
      reloadDetail(id, "The response was recorded, but the safety history could not be refreshed."),
    ]);
  }

  async function responseError(id, responseError) {
    if (!isOpen(id)) return;
    if (!responseError) {
      setError(null);
      return;
    }
    // Submitting again is the retry for a form error, so none is offered.
    setError({ message: responseError.message });
    if (responseError.status === 409) {
      await refreshQueue();
      try {
        const fresh = await getSafetyReview(id);
        if (isOpen(id)) setDetail(fresh);
      } catch {
        if (!isOpen(id)) return;
        const failureMessage = `${responseError.message} The latest safety history could not be loaded.`;
        setError({ message: failureMessage, retry: () => reloadDetail(id, failureMessage, true) });
      }
    }
  }

  return (
    <div className="dashboard dashboard--safety-officer">
      <h1>Safety review</h1>
      <p>Signed in as {user.name ?? user.email}.</p>

      {selectedId ? (
        <section>
          <Button
            variant="link"
            onClick={() => {
              returnFocusTo(selectedId);
              select(null);
              setDetail(null);
              setDetailLoading(false);
              setError(null);
              setMessage(null);
            }}
          >
            &larr; Back to Safety review
          </Button>
          {detailLoading && <LoadingText />}
          {message && <p className="safety-review__success" role="status">{message}</p>}
          {error && <ErrorNotice message={error.message} onRetry={error.retry} />}
          {detail && (
            <SafetyReviewDetail
              detail={detail}
              onSubmitted={responseSubmitted}
              onError={(failure) => responseError(selectedId, failure)}
              focusRequest={detailFocusRequest}
            />
          )}
        </section>
      ) : (
        <section>
          <h2 ref={listHeadingRef} tabIndex={-1}>Waiting for review</h2>
          {loading && <LoadingText />}
          {listError && <ErrorNotice message={listError} onRetry={refreshQueue} />}
          {!loading && !listError && queue.length === 0 && (
            <EmptyState
              message="No events are waiting for a safety review."
              nextStep="Events appear here when a coordinator sends them for a safety check."
            />
          )}
          <ul className="safety-review__queue">
            {queue.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{eventRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>Venues: {event.venues.length ? event.venues.join(", ") : "Not recorded"}</p>
                  <p>Expected attendance: {event.expectedAttendance ?? "Not recorded"}</p>
                  <p>Coordinator: {event.coordinatorName ?? "Not recorded"}</p>
                  <p>Waiting: {waitingLabel(event.waitingSeconds)}</p>
                </div>
                <Button
                  ref={rowRef(event.id)}
                  onClick={() => openReview(event.id)}
                >
                  Review event
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NotificationInbox />
    </div>
  );
}
