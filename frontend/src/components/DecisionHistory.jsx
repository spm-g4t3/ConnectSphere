// DecisionHistory.jsx
//
// SCRUM-355: the decisions a request has had that are no longer current, such
// as the rejection it was reopened from, or the approval a rejection replaced
// (SCRUM-347). Renders nothing for a request with no past decisions, so it can
// sit on any draft or review screen.

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
  // Tagged with the request it was read for, so switching requests never shows
  // the previous one's decisions or error while the new read is in flight.
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getEventDecisionHistory(eventRequestId)
      .then((entries) => {
        if (!cancelled) setResult({ id: eventRequestId, entries });
      })
      .catch(() => {
        if (!cancelled) setResult({ id: eventRequestId, error: "Previous decisions could not be loaded." });
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  if (result?.id !== eventRequestId) return null;
  if (result.error) return <p className="decision-history__state" role="alert">{result.error}</p>;
  const { entries } = result;
  if (entries.length === 0) return null;

  // Only a reopen makes a resubmission: an approval superseded by a rejection
  // (SCRUM-347) is history too. The newest rejection is the one being answered.
  const resubmitted = entries.some((entry) => entry.supersededReason === "reopened_for_revision");
  const latestRejection = [...entries].reverse().find((entry) => entry.decision === "rejected");

  return (
    <section className="decision-history" aria-label="Previous decisions">
      {view === "coordinator" && resubmitted && (
        <p className="decision-history__resubmission" role="status">
          This request is a resubmission. It has been decided {entries.length === 1 ? "once" : `${entries.length} times`} before.
        </p>
      )}
      {view !== "coordinator" && latestRejection && (
        <div className="decision-history__reason">
          <strong>Why it was rejected</strong>
          <p>{latestRejection.decisionNote || "No reason was recorded."}</p>
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
