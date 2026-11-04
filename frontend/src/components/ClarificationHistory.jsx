import { useCallback, useEffect, useState } from "react";
import { getEventClarificationHistory } from "../services/eventRequestService";
import { formatDateTime, formatDay } from "../services/displayFormat";
import { isReplyOverdue } from "../services/datetimeFormat";
import { canRetryRead } from "../services/apiErrors";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";

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

export default function ClarificationHistory({
  eventRequestId,
  isOpen = false,
  omitLatestQuestionMessage,
}) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { message, retryable }

  // State is set only while still wanted, so a reply for an event the dialog
  // has moved on from is dropped. Resolves once settled, for Try again's focus.
  const loadHistory = useCallback((isActive = () => true) =>
    getEventClarificationHistory(eventRequestId)
      .then((history) => {
        if (isActive()) setEntries(history);
      })
      .catch((err) => {
        if (isActive()) {
          setError({ message: "Clarification history could not be loaded.", retryable: canRetryRead(err) });
        }
      })
      .finally(() => {
        if (isActive()) setLoading(false);
      }), [eventRequestId]);

  useEffect(() => {
    let cancelled = false;
    loadHistory(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  function reload() {
    setLoading(true);
    setError(null);
    return loadHistory();
  }
  const { headingRef, retry } = useFocusAfterRetry(reload);

  // Every state renders in this box, so focus has somewhere to land after Try again.
  const box = (content) => <div ref={headingRef} tabIndex={-1}>{content}</div>;

  if (loading) return box(<LoadingText />);
  if (error) {
    return box(<ErrorNotice message={error.message} onRetry={error.retryable ? retry : undefined} />);
  }
  if (entries.length === 0) {
    return box(
      <EmptyState
        message="No clarification updates yet."
        nextStep="Questions and replies about this event will appear here."
      />,
    );
  }

  const latestQuestion = [...entries].reverse().find((entry) => entry.type === "question");
  const visibleEntries = omitLatestQuestionMessage &&
    latestQuestion?.message === omitLatestQuestionMessage
    ? entries.filter((entry) => entry.id !== latestQuestion.id)
    : entries;

  if (visibleEntries.length === 0) {
    return box(<p className="clarification-history__state">No earlier messages.</p>);
  }

  return box(
    <div className="clarification-history" aria-label="Clarification conversation">
      {visibleEntries.map((entry) => {
        const overdue = isOpen &&
          entry.type === "question" &&
          entry.replyByDate &&
          isReplyOverdue(entry.replyByDate) &&
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
                {formatDateTime(entry.createdAt, "Date not recorded")}
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
                Reply by <time dateTime={entry.replyByDate}>{formatDay(entry.replyByDate)}</time>
              </p>
            )}
          </article>
        );
      })}
    </div>,
  );
}
