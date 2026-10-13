import { useEffect, useState } from "react";
import {
  getSafetyReview,
  getSafetyReviewHistory,
} from "../services/safetyReviewService";
import { formatRange, formatTimestamp } from "../services/displayFormat";
import { OUTCOME_LABELS, SafetyReviewDetail } from "./SafetyOfficerDashboard";

const noop = () => {};

export default function SafetyReviewHistory() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
          <button
            className="safety-review__back"
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
              setError(null);
            }}
          >
            &larr; Back to Review history
          </button>
          {detailLoading && <p>Loading event arrangements...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {detail && <SafetyReviewDetail detail={detail} onSubmitted={noop} onError={noop} />}
        </section>
      ) : (
        <section>
          {loading && <p>Loading...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {!loading && !error && history.length === 0 && <p>No events have been reviewed yet.</p>}
          <ul className="safety-review__queue">
            {history.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{formatRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>Outcome: {OUTCOME_LABELS[event.outcome] ?? event.outcome}</p>
                  {event.note && <p>Note: {event.note}</p>}
                  <p>Reviewed by: {event.safetyOfficerName ?? "Not recorded"}</p>
                  <p>Reviewed: {formatTimestamp(event.respondedAt)}</p>
                </div>
                <button type="button" onClick={() => openDetail(event.id)}>View details</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
