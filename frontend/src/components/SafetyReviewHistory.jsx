import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  getSafetyReview,
  getSafetyReviewHistory,
} from "../services/safetyReviewService";
import { formatRange, formatTimestamp } from "../services/displayFormat";
import { OUTCOME_LABELS, OUTCOME_TONES } from "./safetyReviewLabels";
import { SafetyReviewDetail } from "./SafetyReviewDetail";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";

export default function SafetyReviewHistory() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const rowButtons = useRef(new Map());
  const listHeadingRef = useRef(null);
  const returnFocusId = useRef(null);

  useEffect(() => {
    let active = true;
    getSafetyReviewHistory()
      .then((rows) => {
        if (active) setHistory(rows);
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError.response?.data?.error ?? "The review history could not be loaded.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

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
      setError(requestError.response?.data?.error ?? "The event's safety details could not be loaded.");
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
          {detailLoading && <p>Loading event arrangements...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
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
          {loading && <p>Loading...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {!loading && !error && history.length === 0 && <p>No events have been reviewed yet.</p>}
          <ul className="safety-review__queue">
            {history.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{formatRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>
                    Outcome:{" "}
                    <StatusBadge tone={OUTCOME_TONES[event.outcome] ?? "neutral"}>
                      {OUTCOME_LABELS[event.outcome] ?? event.outcome}
                    </StatusBadge>
                  </p>
                  {event.note && <p>Note: {event.note}</p>}
                  <p>Reviewed by: {event.safetyOfficerName ?? "Not recorded"}</p>
                  <p>Reviewed: {formatTimestamp(event.respondedAt)}</p>
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
