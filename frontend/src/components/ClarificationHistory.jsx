import { useEffect, useState } from "react";
import { getEventClarificationHistory } from "../services/eventRequestService";

const ENTRY_LABELS = {
  question: "Coordinator question",
  reply: "Organiser reply",
  closure: "Coordinator closed clarification",
};

const FIELD_LABELS = {
  eventName: "Event name",
  purpose: "Purpose",
  description: "Description",
  proposedStart: "Proposed start",
  proposedEnd: "Proposed end",
  expectedAttendance: "Expected attendance",
  venueRequirements: "Venue requirements",
  accessibilityRequirements: "Accessibility requirements",
  equipmentRequirements: "Equipment requirements",
};

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function ClarificationHistory({ eventRequestId, isOpen = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getEventClarificationHistory(eventRequestId)
      .then((history) => {
        if (!cancelled) setEntries(history);
      })
      .catch(() => {
        if (!cancelled) setError("Clarification history could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  if (loading) return <p>Loading clarification history...</p>;
  if (error) return <p role="alert">{error}</p>;
  if (entries.length === 0) return <p>No clarification history yet.</p>;

  return (
    <ol className="clarification-history">
      {entries.map((entry) => {
        const overdue = isOpen &&
          entry.type === "question" &&
          entry.replyByDate &&
          entry.replyByDate < new Date().toISOString().slice(0, 10) &&
          entries.at(-1)?.id === entry.id;
        return (
          <li key={entry.id} className={overdue ? "clarification-history__entry clarification-history__entry--overdue" : "clarification-history__entry"}>
            <strong>{ENTRY_LABELS[entry.type] || "Clarification update"}</strong>
            <p>{entry.message}</p>
            {entry.type === "question" && entry.requestedFields?.length > 0 && (
              <p>
                Organiser may amend: {entry.requestedFields
                  .map((field) => FIELD_LABELS[field] || field)
                  .join(", ")}
              </p>
            )}
            <small>
              {entry.authorName || "Unknown user"} · {formatTimestamp(entry.createdAt)}
              {entry.replyByDate && ` · Reply by ${entry.replyByDate}`}
              {overdue && " · Overdue"}
            </small>
          </li>
        );
      })}
    </ol>
  );
}
