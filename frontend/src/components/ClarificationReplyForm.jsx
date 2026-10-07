import { useEffect, useState } from "react";
import {
  getEventClarificationHistory,
  respondToEventClarification,
} from "../services/eventRequestService";
import ClarificationHistory from "./ClarificationHistory";
import {
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";

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
  if (field === "proposedStart" || field === "proposedEnd") {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
  }
  return String(value);
}

export default function ClarificationReplyForm({ request, onSaved }) {
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(() => initialValues(request));
  const [requestedFields, setRequestedFields] = useState([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getEventClarificationHistory(request.id)
      .then((history) => {
        if (!cancelled) {
          const openQuestion = [...history].reverse().find((entry) => entry.type === "question");
          setRequestedFields(openQuestion?.requestedFields ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the clarification details.");
      })
      .finally(() => {
        if (!cancelled) setLoadingFields(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request.id]);

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
      <h2>Reply to the Coordinator</h2>
      {request.clarificationNote && (
        <blockquote>{request.clarificationNote}</blockquote>
      )}
      {request.clarificationReplyByDate && (
        <p>Please reply by {request.clarificationReplyByDate}.</p>
      )}

      <details className="clarification-reply__history">
        <summary>View clarification history</summary>
        <ClarificationHistory eventRequestId={request.id} isOpen />
      </details>

      {loadingFields ? (
        <section className="clarification-amendments" aria-label="Event amendments">
          <p>Loading amendment options...</p>
        </section>
      ) : (
        <section className="clarification-amendments" aria-label="Event amendments">
          <div className="clarification-amendments__heading">
            <div>
              <h3>Event amendments</h3>
              <p>Only fields approved by your Coordinator can be changed.</p>
            </div>
            <span className={`clarification-amendments__badge${requestedFields.length ? " clarification-amendments__badge--active" : ""}`}>
              {requestedFields.length
                ? `${requestedFields.length} field${requestedFields.length === 1 ? "" : "s"} editable`
                : "Reply only"}
            </span>
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
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={loadingFields || sending || !message.trim()}>
        {sending ? "Sending..." : "Send reply"}
      </button>
    </form>
  );
}
