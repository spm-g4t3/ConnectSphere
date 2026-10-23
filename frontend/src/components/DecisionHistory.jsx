// DecisionHistory.jsx
//
// SCRUM-355: the decisions a request has had that are no longer current, such
// as the rejection it was reopened from. Renders nothing for a request that has
// never been resubmitted, so it can sit on any draft or review screen.

import { useEffect, useState } from "react";
import { getEventDecisionHistory } from "../services/eventRequestService";
import { formatMediumTimestamp } from "../services/displayFormat";

const DECISION_LABEL = {
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * @param {object} props
 * @param {string} props.eventRequestId
 * @param {"coordinator"|"organiser"} props.view  the coordinator is also told
 *                                                 the request is a resubmission
 */
export default function DecisionHistory({ eventRequestId, view = "organiser" }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getEventDecisionHistory(eventRequestId)
      .then((history) => {
        if (!cancelled) setEntries(history);
      })
      .catch(() => {
        if (!cancelled) setError("Previous decisions could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  if (loading) return null;
  if (error) return <p className="decision-history__state" role="alert">{error}</p>;
  if (entries.length === 0) return null;

  // The newest is the rejection this round of revision answers.
  const latest = entries[entries.length - 1];

  return (
    <section className="decision-history" aria-label="Previous decisions">
      {view === "coordinator" ? (
        <p className="decision-history__resubmission" role="status">
          This request is a resubmission. It has been decided {entries.length === 1 ? "once" : `${entries.length} times`} before.
        </p>
      ) : (
        <div className="decision-history__reason">
          <strong>Why it was rejected</strong>
          <p>{latest.decisionNote || "No reason was recorded."}</p>
        </div>
      )}
      <h3>Previous decisions</h3>
      <ol className="decision-history__list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <strong>{DECISION_LABEL[entry.decision] ?? entry.decision}</strong>
            {" on "}
            {formatMediumTimestamp(entry.decidedAt, "an unrecorded date")}
            {" by "}
            {entry.decidedByName ?? "a coordinator with no name on record"}
            <p>{entry.decisionNote || "No note was left."}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
