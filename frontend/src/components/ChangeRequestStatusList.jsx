// ChangeRequestStatusList.jsx
// Shows the current state of every change request the Organiser has
// submitted for a given event, so they can tell what's outstanding vs
// processed (SCRUM-34).

import { getChangeRequests } from "../services/changeRequestService";
import { useEffect, useState, useCallback } from "react";

const POLL_INTERVAL_MS = 15000;

// Adjust these to whatever statuses your backend actually uses — this
// mirrors the description's three states (outstanding, in progress, processed).
const STATUS_CONFIG = {
  outstanding: { label: "Outstanding", className: "status--outstanding" },
  in_progress: { label: "In Progress", className: "status--in-progress" },
  processed: { label: "Processed", className: "status--processed" },
};

const DECISION_CONFIG = {
  approved: { label: "Approved", className: "change-request-outcome--approved" },
  rejected: { label: "Rejected", className: "change-request-outcome--rejected" },
};

function useChangeRequests(eventRequestId) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRequests = useCallback(async () => {
    try {
      const data = await getChangeRequests(eventRequestId);
      setRequests(data);
      setError(null);
    } catch (err) {
      setError("Could not load your change requests.");
    } finally {
      setLoading(false);
    }
  }, [eventRequestId]);

  useEffect(() => {
    fetchRequests();
    const interval = setInterval(fetchRequests, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  return { requests, loading, error };
}

export default function ChangeRequestStatusList({ eventRequestId }) {
  const { requests, loading, error } = useChangeRequests(eventRequestId);

  if (loading) {
    return <p>Loading change requests...</p>;
  }

  if (error) {
    return <p className="change-request-status__error">{error}</p>;
  }

  if (requests.length === 0) {
    return <p>You haven't requested any changes for this event.</p>;
  }

  return (
    <ul className="change-request-status-list">
      {requests.map((req) => {
        const config = STATUS_CONFIG[req.status] || {
          label: req.status,
          className: "status--unknown",
        };
        const decision = DECISION_CONFIG[req.decision];

        return (
          <li key={req.id} className="change-request-status-list__item">
            <div className="change-request-status-list__field">{req.fieldLabel}</div>
            <div className="change-request-status-list__details">{req.details}</div>
            <div className="change-request-status-list__statuses">
              <span className={`change-request-status-list__badge ${config.className}`}>
                {config.label}
              </span>
              {decision && (
                <span className={`change-request-status-list__badge ${decision.className}`}>
                  Outcome: {decision.label}
                </span>
              )}
            </div>
            {req.decisionNotes && (
              <p className="change-request-status-list__decision-notes">
                <strong>Coordinator note:</strong> {req.decisionNotes}
              </p>
            )}
            <span className="change-request-status-list__date">
              Requested {new Date(req.createdAt).toLocaleDateString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
