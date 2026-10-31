import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  getSafetyReview,
  getSafetyReviewHistory,
} from "../services/safetyReviewService";
import { formatDateTime } from "../services/displayFormat";
import { OUTCOME_LABELS, OUTCOME_TONES, eventRange } from "./safetyReviewLabels";
import { SafetyReviewDetail } from "./SafetyReviewDetail";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";

export default function SafetyReviewHistory() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const rowButtons = useRef(new Map());
  const listHeadingRef = useRef(null);
  const returnFocusId = useRef(null);

  // State is set only in the promise callbacks, and only while isActive()
  // holds, so a first load that settles after unmounting is dropped.
  const loadHistory = useCallback((isActive = () => true) =>
    getSafetyReviewHistory()
      .then((rows) => {
        if (!isActive()) return;
        setHistory(rows);
        setListError(null);
      })
      .catch((requestError) => {
        if (isActive()) {
          setListError(requestError.response?.data?.error ?? "The review history could not be loaded.");
        }
      })
      .finally(() => {
        if (isActive()) setLoading(false);
      }), []);

  useEffect(() => {
    let active = true;
    loadHistory(() => active);
    return () => {
      active = false;
    };
  }, [loadHistory]);

  // Loading starts true, so only a retry needs to raise it.
  function retryHistory() {
    setLoading(true);
    setListError(null);
    loadHistory();
  }

  // Back returns focus to the row that was opened, or to the list heading if
  // that row is no longer listed.
  useEffect(() => {
    if (selectedId || loading || returnFocusId.current === null) return;
    const target = rowButtons.current.get(returnFocusId.current) ?? listHeadingRef.current;
    returnFocusId.current = null;
    target?.focus();
  }, [selectedId, loading]);

  async function openDetail(id) {
    setSelectedId(id);
    setDetail(null);
    setError(null);
    setDetailLoading(true);
    try {
      setDetail(await getSafetyReview(id));
    } catch (requestError) {
      setError({
        message: requestError.response?.data?.error ?? "The event's safety details could not be loaded.",
        retry: () => openDetail(id),
      });
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="dashboard dashboard--safety-officer">
      <h1>Review history</h1>

      {selectedId ? (
        <section>
          <Button
            variant="link"
            onClick={() => {
              returnFocusId.current = selectedId;
              setSelectedId(null);
              setDetail(null);
              setError(null);
            }}
          >
            &larr; Back to Review history
          </Button>
          {detailLoading && <LoadingText />}
          {error && <ErrorNotice message={error.message} onRetry={error.retry} />}
          {detail && (
            <>
              {detail.event.status === "safety_review" && (
                <p>
                  This event is in the live queue.{" "}
                  <Link to="/safety-review">Open the Safety review queue</Link>
                </p>
              )}
              <SafetyReviewDetail detail={detail} readOnly />
            </>
          )}
        </section>
      ) : (
        <section>
          <h2 ref={listHeadingRef} tabIndex={-1}>Reviewed events</h2>
          {loading && <LoadingText />}
          {listError && <ErrorNotice message={listError} onRetry={retryHistory} />}
          {!loading && !listError && history.length === 0 && (
            <EmptyState
              message="No events have been reviewed yet."
              nextStep="An event appears here once a Safety Officer responds to it in Safety review."
            />
          )}
          <ul className="safety-review__queue">
            {history.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{eventRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>
                    Outcome:{" "}
                    <StatusBadge tone={OUTCOME_TONES[event.outcome] ?? "neutral"}>
                      {OUTCOME_LABELS[event.outcome] ?? event.outcome}
                    </StatusBadge>
                  </p>
                  {event.note && <p>Note: {event.note}</p>}
                  <p>Reviewed by: {event.safetyOfficerName ?? "Not recorded"}</p>
                  <p>Reviewed: {formatDateTime(event.respondedAt)}</p>
                </div>
                <Button
                  ref={(node) => {
                    if (node) rowButtons.current.set(event.id, node);
                    else rowButtons.current.delete(event.id);
                  }}
                  onClick={() => openDetail(event.id)}
                >
                  View details
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
