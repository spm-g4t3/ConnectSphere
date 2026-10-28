// ChangeRequestStatusList.jsx
// Shows the current state of every change request the Organiser has
// submitted for a given event, so they can tell what's outstanding vs
// processed (SCRUM-34).
//
// SCRUM-402 AC10: one card per submission (its requestGroupId), with its
// fields, the Organiser's note, the outcome, the coordinator's reason or note
// and when it was processed.

import { getChangeRequests } from "../services/changeRequestService";
import { useEffect, useState, useCallback } from "react";
import { formatTimestamp } from "../services/displayFormat";
import { changeFieldLabel, groupChangeRequests, outcomeLabel } from "../services/changeRequestDisplay";

const POLL_INTERVAL_MS = 15000;

// The three states a change request moves through.
const STATUS_CONFIG = {
  outstanding: { label: "Outstanding", className: "status--outstanding" },
  in_progress: { label: "In Progress", className: "status--in-progress" },
  processed: { label: "Processed", className: "status--processed" },
};

const OUTCOME_CLASS = {
  approved: "change-request-outcome--approved",
  rejected: "change-request-outcome--rejected",
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
    } catch {
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
      {groupChangeRequests(requests).map((group) => {
        const status = group.rows[0].status;
        const config = STATUS_CONFIG[status] || { label: status, className: "status--unknown" };
        const outcome = outcomeLabel(group.decision);

        return (
          <li key={group.id} className="change-request-status-list__item">
            <ul className="change-request-status-list__fields">
              {group.rows.map((row) => (
                <li key={row.id}>
                  <div className="change-request-status-list__field">{changeFieldLabel(row.changeField)}</div>
                  <div className="change-request-status-list__details">{row.details ?? row.requestedChange}</div>
                </li>
              ))}
            </ul>
            {group.organiserNote && (
              <p className="change-request-status-list__note"><strong>Your note:</strong> {group.organiserNote}</p>
            )}
            <div className="change-request-status-list__statuses">
              <span className={`change-request-status-list__badge ${config.className}`}>
                {config.label}
              </span>
              {outcome && (
                <span className={`change-request-status-list__badge ${OUTCOME_CLASS[group.decision] ?? "change-request-outcome--closed"}`}>
                  Outcome: {outcome}
                </span>
              )}
            </div>
            {group.decisionNotes && (
              <p className="change-request-status-list__decision-notes">
                <strong>{group.decision === "rejected" ? "Coordinator's reason:" : "Coordinator note:"}</strong> {group.decisionNotes}
              </p>
            )}
            <span className="change-request-status-list__date">
              Requested {formatTimestamp(group.createdAt, "on an unrecorded date")}
              {group.processedAt && `; processed ${formatTimestamp(group.processedAt, "on an unrecorded date")}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
