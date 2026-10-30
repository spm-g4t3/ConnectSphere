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
import { getNeedsAttention } from "../services/eventRequestService";
import { SESSION_EXPIRED } from "../services/apiErrors";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";

const LOAD_ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Event Coordinators have a Needs attention list.",
};

export default function CoordinatorAttentionList({ refreshKey = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await getNeedsAttention();
      setItems(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(
        LOAD_ERROR_MESSAGES[err.response?.status] ||
          "Your Needs attention list could not be loaded. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useRefetchOnReturn(load);

  return (
    <section className="coordinator-attention" aria-labelledby="coordinator-attention-heading">
      <h2 id="coordinator-attention-heading">
        Needs attention
        {!loading && !error && items.length > 0 && (
          <span className="coordinator-attention__count">{` (${items.length})`}</span>
        )}
      </h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="review-queue__error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <p>Nothing needs your attention right now.</p>
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
              <button type="button" aria-label={`Open ${item.eventName}`} onClick={() => navigate(item.link)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
