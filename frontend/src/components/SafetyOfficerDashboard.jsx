import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSafetyReview,
  getSafetyReviewQueue,
} from "../services/safetyReviewService";
import { formatRange } from "../services/displayFormat";
import NotificationInbox from "./NotificationInbox";
import Button from "./ui/Button";
import { SafetyReviewDetail } from "./SafetyReviewDetail";
import { OUTCOME_LABELS } from "./safetyReviewLabels";

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
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const rowButtons = useRef(new Map());
  const listHeadingRef = useRef(null);
  const returnFocusId = useRef(null);

  const refreshQueue = useCallback(async () => {
    setLoading(true);
    try {
      setQueue(await getSafetyReviewQueue());
      setError(null);
    } catch (requestError) {
      setError(requestError.response?.data?.error ?? "The safety review list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  // Back returns focus to the row that was opened; a reviewed event has left
  // the queue, so the list heading takes focus instead.
  useEffect(() => {
    if (selectedId || loading || returnFocusId.current === null) return;
    const target = rowButtons.current.get(returnFocusId.current) ?? listHeadingRef.current;
    returnFocusId.current = null;
    target?.focus();
  }, [selectedId, loading]);

  async function openReview(id) {
    setSelectedId(id);
    setDetail(null);
    setMessage(null);
    setError(null);
    setDetailLoading(true);
    try {
      setDetail(await getSafetyReview(id));
    } catch (requestError) {
      setError(requestError.response?.data?.error ?? "The event's safety details could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function responseSubmitted(id, outcome) {
    setMessage(`Response recorded: ${OUTCOME_LABELS[outcome]}.`);
    setError(null);
    await refreshQueue();
    try {
      setDetail(await getSafetyReview(id));
    } catch {
      setError("The response was recorded, but the safety history could not be refreshed.");
    }
  }

  async function responseError(responseError) {
    if (!responseError) {
      setError(null);
      return;
    }
    setError(responseError.message);
    if (responseError.status === 409 && selectedId) {
      await refreshQueue();
      setError(responseError.message);
      try {
        setDetail(await getSafetyReview(selectedId));
      } catch {
        setError(`${responseError.message} The latest safety history could not be loaded.`);
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
              returnFocusId.current = selectedId;
              setSelectedId(null);
              setDetail(null);
              setError(null);
              setMessage(null);
            }}
          >
            &larr; Back to Safety review
          </Button>
          {detailLoading && <p>Loading event arrangements...</p>}
          {message && <p className="safety-review__success" role="status">{message}</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {detail && (
            <SafetyReviewDetail
              detail={detail}
              onSubmitted={responseSubmitted}
              onError={responseError}
            />
          )}
        </section>
      ) : (
        <section>
          <h2 ref={listHeadingRef} tabIndex={-1}>Waiting for review</h2>
          {loading && <p>Loading...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {!loading && !error && queue.length === 0 && <p>No events are waiting for a safety review.</p>}
          <ul className="safety-review__queue">
            {queue.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{formatRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>Venues: {event.venues.length ? event.venues.join(", ") : "Not recorded"}</p>
                  <p>Expected attendance: {event.expectedAttendance ?? "Not recorded"}</p>
                  <p>Coordinator: {event.coordinatorName ?? "Not recorded"}</p>
                  <p>Waiting: {waitingLabel(event.waitingSeconds)}</p>
                </div>
                <Button
                  ref={(node) => {
                    if (node) rowButtons.current.set(event.id, node);
                    else rowButtons.current.delete(event.id);
                  }}
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
