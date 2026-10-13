import { useEffect, useState } from "react";
import { getEventClarificationHistory } from "../services/eventRequestService";

const ENTRY_LABELS = {
  question: "Coordinator question",
  reply: "Organiser reply",
  closure: "Clarification closed",
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
  if (!value) return "Date not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
}

function formatReplyByDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export default function ClarificationHistory({
  eventRequestId,
  isOpen = false,
  omitLatestQuestionMessage,
}) {
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

  if (loading) {
    return <p className="clarification-history__state">Loading clarification history...</p>;
  }
  if (error) return <p className="clarification-history__state" role="alert">{error}</p>;
  if (entries.length === 0) {
    return <p className="clarification-history__state">No clarification updates yet.</p>;
  }

  const latestQuestion = [...entries].reverse().find((entry) => entry.type === "question");
  const visibleEntries = omitLatestQuestionMessage &&
    latestQuestion?.message === omitLatestQuestionMessage
    ? entries.filter((entry) => entry.id !== latestQuestion.id)
    : entries;

  if (visibleEntries.length === 0) {
    return <p className="clarification-history__state">No earlier messages.</p>;
  }

  return (
    <div className="clarification-history" aria-label="Clarification conversation">
      {visibleEntries.map((entry) => {
        const overdue = isOpen &&
          entry.type === "question" &&
          entry.replyByDate &&
          entry.replyByDate < new Date().toISOString().slice(0, 10) &&
          entries.at(-1)?.id === entry.id;
        return (
          <article
            key={entry.id}
            className={`clarification-history__entry clarification-history__entry--${entry.type}${overdue ? " clarification-history__entry--overdue" : ""}`}
          >
            <header className="clarification-history__header">
              <strong>{ENTRY_LABELS[entry.type] || "Clarification update"}</strong>
              {overdue && <span className="clarification-history__overdue">Overdue</span>}
              <span className="clarification-history__author">{entry.authorName || "Unknown user"}</span>
              <time
                className="clarification-history__meta"
                dateTime={entry.createdAt || undefined}
              >
                {formatTimestamp(entry.createdAt)}
              </time>
            </header>
            <p className="clarification-history__message">{entry.message}</p>
            {entry.type === "question" && entry.requestedFields?.length > 0 && (
              <div className="clarification-history__fields">
                <strong>Fields to update:</strong>{" "}
                {entry.requestedFields
                  .map((field) => FIELD_LABELS[field] || field)
                  .join(", ")}
              </div>
            )}
            {entry.replyByDate && (
              <p className="clarification-history__deadline">
                Reply by <time dateTime={entry.replyByDate}>{formatReplyByDate(entry.replyByDate)}</time>
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
