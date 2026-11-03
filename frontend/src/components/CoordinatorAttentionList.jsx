// CoordinatorAttentionList.jsx
//
// SCRUM-384 (SCRUM-379 AC7): the coordinator's Needs attention list, beside My events on their
// dashboard. One row per reason an event of theirs needs them (an ended event to mark completed,
// an event not confirmed in time, a clarification gone overdue, a venue or equipment problem),
// each linking to the event.
//
// The list is the server's: GET /event-requests/needs-attention works out the reasons and their
// order, so this component only shows them. It is not the per-event "Needs attention" badge and
// reasons SCRUM-266 and SCRUM-315 put on the rows of My events (NeedsAttentionBadge,
// NeedsAttentionReasons); that is one event's flags, this is the coordinator's to-do list.
//
// `refreshKey` lets the dashboard ask it to read again after something happened in My events
// (an event completed there leaves this list). It also reads again when the coordinator comes
// back to the tab, as My events does.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { canRetryRead } from "../services/apiErrors";
import { getNeedsAttention } from "../services/eventRequestService";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import useFocusAfterRetry from "./useFocusAfterRetry";

const LOAD_ERROR_MESSAGES = {
  403: "Only Event Coordinators have a Needs attention list.",
};

export default function CoordinatorAttentionList({ refreshKey = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryable, setRetryable] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await getNeedsAttention();
      setItems(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(
        LOAD_ERROR_MESSAGES[err.response?.status] ||
          "Your Needs attention list could not be loaded.",
      );
      setRetryable(canRetryRead(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useRefetchOnReturn(load);

  // Only Try again shows Loading: a refetch on return keeps the list and its count
  // on screen. The button goes as the read starts, so focus moves to the heading.
  const reload = useCallback(() => {
    setLoading(true);
    return load();
  }, [load]);
  const { headingRef, retry } = useFocusAfterRetry(reload);

  return (
    <section className="coordinator-attention" aria-labelledby="coordinator-attention-heading">
      <h2 id="coordinator-attention-heading" ref={headingRef} tabIndex={-1}>
        Needs attention
        {!loading && !error && items.length > 0 && (
          <span className="coordinator-attention__count">{` (${items.length})`}</span>
        )}
      </h2>

      {loading && <LoadingText />}
      {/* Hidden while a read is in flight, so Try again cannot start a second one. */}
      {error && !loading && <ErrorNotice message={error} onRetry={retryable ? retry : undefined} />}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          message="Nothing needs your attention right now."
          nextStep="Your events appear here when one needs you to act."
        />
      )}
      {!error && items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item.id} className="coordinator-attention__item">
              <div className="coordinator-attention__summary">
                <Link to={item.link}>{item.eventName}</Link>
                <strong className="coordinator-attention__reason">{item.reason}</strong>
                <span className="coordinator-attention__meta">
                  <span>{formatVenuePeriod(item.proposedStart, item.proposedEnd, "Date not set")}</span>
                  {item.organiserName && <span>Organiser: {item.organiserName}</span>}
                </span>
              </div>
              <Button aria-label={`Open ${item.eventName}`} onClick={() => navigate(item.link)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
