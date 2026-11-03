import { useCallback, useEffect, useState } from "react";
import {
  getEventClarificationHistory,
  respondToEventClarification,
} from "../services/eventRequestService";
import ClarificationHistory from "./ClarificationHistory";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import LoadingText from "./ui/LoadingText";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";
import {
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";
import { formatDateTime, formatDay } from "../services/displayFormat";
import { canRetryRead } from "../services/apiErrors";

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

const FIELD_ORDER = Object.keys(FIELD_LABELS);

function initialValues(request) {
  return {
    eventName: request.eventName ?? "",
    purpose: request.purpose ?? "",
    description: request.description ?? "",
    proposedStart: toDatetimeLocalValue(request.proposedStart),
    proposedEnd: toDatetimeLocalValue(request.proposedEnd),
    expectedAttendance: request.expectedAttendance ?? "",
    venueRequirements: request.venueRequirements ?? "",
    accessibilityRequirements: request.accessibilityRequirements ?? "",
    equipmentRequirements: request.equipmentRequirements ?? "",
  };
}

function toAmendments(fields, form) {
  const amendments = {};
  for (const field of fields) {
    const value = form[field];
    if (field === "proposedStart" || field === "proposedEnd") {
      amendments[field] = toOffsetIsoString(value) ?? null;
    } else if (field === "expectedAttendance") {
      amendments[field] = value === "" ? null : Number(value);
    } else {
      amendments[field] = value.trim() || null;
    }
  }
  return amendments;
}

function readOnlyValue(field, request) {
  const value = request[field];
  if (value === null || value === undefined || value === "") return "Not provided";
  if (field === "proposedStart" || field === "proposedEnd") return formatDateTime(value);
  return String(value);
}

export default function ClarificationReplyForm({ request, onSaved }) {
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(() => initialValues(request));
  const [requestedFields, setRequestedFields] = useState([]);
  const [loadingFields, setLoadingFields] = useState(true);
  // Kept apart: a failed read can be tried again, a failed send is sent again.
  const [loadError, setLoadError] = useState(null); // { message, retryable }
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  const loadFields = useCallback((isActive = () => true) =>
    getEventClarificationHistory(request.id)
      .then((history) => {
        if (isActive()) {
          const openQuestion = [...history].reverse().find((entry) => entry.type === "question");
          setRequestedFields(openQuestion?.requestedFields ?? []);
        }
      })
      .catch((err) => {
        if (isActive()) {
          setLoadError({ message: "Could not load the clarification details.", retryable: canRetryRead(err) });
        }
      })
      .finally(() => {
        if (isActive()) setLoadingFields(false);
      }), [request.id]);

  useEffect(() => {
    let cancelled = false;
    loadFields(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadFields]);

  function reloadFields() {
    setLoadingFields(true);
    setLoadError(null);
    return loadFields();
  }
  const { headingRef, retry } = useFocusAfterRetry(reloadFields);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!message.trim()) {
      setError("Your reply cannot be blank.");
      return;
    }

    setSending(true);
    setError(null);
    try {
      await respondToEventClarification(
        request.id,
        message.trim(),
        toAmendments(requestedFields, form),
      );
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || "Could not send your reply.");
    } finally {
      setSending(false);
    }
  }

  function renderField(field) {
    const label = FIELD_LABELS[field];
    if (field === "proposedStart" || field === "proposedEnd") {
      return (
        <label key={field}>
          {label}
          <input
            type="datetime-local"
            value={form[field]}
            onChange={(event) => setForm((current) => ({
              ...current,
              [field]: event.target.value,
            }))}
            disabled={loadingFields || sending}
          />
        </label>
      );
    }
    if (field === "expectedAttendance") {
      return (
        <label key={field}>
          {label}
          <input
            type="number"
            min="1"
            value={form[field]}
            onChange={(event) => setForm((current) => ({
              ...current,
              [field]: event.target.value,
            }))}
            disabled={loadingFields || sending}
          />
        </label>
      );
    }

    const isName = field === "eventName";
    return (
      <label key={field}>
        {label}
        {isName ? (
          <input
            type="text"
            value={form[field]}
            onChange={(event) => setForm((current) => ({
              ...current,
              [field]: event.target.value,
            }))}
            required
            disabled={loadingFields || sending}
          />
        ) : (
          <textarea
            value={form[field]}
            onChange={(event) => setForm((current) => ({
              ...current,
              [field]: event.target.value,
            }))}
            rows={field === "purpose" ? 2 : 3}
            disabled={loadingFields || sending}
          />
        )}
      </label>
    );
  }

  return (
    <form className="clarification-reply" onSubmit={handleSubmit}>
      <h1>Reply to the Coordinator</h1>
      {request.clarificationNote && (
        <blockquote>{request.clarificationNote}</blockquote>
      )}
      {request.clarificationReplyByDate && (
        <p>Please reply by {formatDay(request.clarificationReplyByDate)}.</p>
      )}

      <details className="clarification-reply__history">
        <summary>View clarification history</summary>
        <ClarificationHistory eventRequestId={request.id} isOpen />
      </details>

      {loadingFields ? (
        <section className="clarification-amendments" aria-label="Event amendments" ref={headingRef} tabIndex={-1}>
          <LoadingText />
        </section>
      ) : loadError ? (
        <section className="clarification-amendments" aria-label="Event amendments" ref={headingRef} tabIndex={-1}>
          <ErrorNotice message={loadError.message} onRetry={loadError.retryable ? retry : undefined} />
        </section>
      ) : (
        <section className="clarification-amendments" aria-label="Event amendments" ref={headingRef} tabIndex={-1}>
          <div className="clarification-amendments__heading">
            <div>
              <h2>Event amendments</h2>
              <p>Only fields approved by your Coordinator can be changed.</p>
            </div>
            <StatusBadge tone={requestedFields.length ? "success" : "neutral"}>
              {requestedFields.length
                ? `${requestedFields.length} field${requestedFields.length === 1 ? "" : "s"} editable`
                : "Reply only"}
            </StatusBadge>
          </div>

          {requestedFields.length > 0 ? (
            <fieldset className="clarification-reply__amendments">
              <legend>Update the requested event details</legend>
              <div className="clarification-amendments__grid">
                {requestedFields.map(renderField)}
              </div>
            </fieldset>
          ) : (
            <>
              <div className="clarification-amendments__empty">
                <strong>No event fields were selected for this clarification.</strong>
                <span>You can still send your written reply. To amend the request, ask your Coordinator to send a new clarification with the relevant fields enabled.</span>
              </div>
              <details className="clarification-amendments__readonly">
                <summary>Review current event details</summary>
                <dl>
                  {FIELD_ORDER.map((field) => (
                    <div key={field}>
                      <dt>{FIELD_LABELS[field]}</dt>
                      <dd>{readOnlyValue(field, request)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </>
          )}
        </section>
      )}

      <label>
        Your reply
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={5}
          maxLength={2000}
          required
          disabled={loadingFields || sending}
        />
      </label>
      {/* No Try again: sending again is the retry. */}
      {error && <ErrorNotice message={error} />}
      <Button type="submit" disabled={loadingFields || sending || !message.trim()}>
        {sending ? "Sending..." : "Send reply"}
      </Button>
    </form>
  );
}
