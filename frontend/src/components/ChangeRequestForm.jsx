// ChangeRequestForm.jsx
// Lets an Event Organiser request changes to a submitted event and specify
// which event information or arrangement needs updating (SCRUM-32).
//
// SCRUM-402: one request may change several fields (C4), sent together as a
// group the coordinator accepts or declines as a whole, with one optional note.
// "Cancel the event" stands alone in a request (D8). Errors are keyed on the
// status, never on the server's text; a 400's details[] go beside their row.

import { useState } from "react";
import { submitChangeRequest } from "../services/changeRequestService";
import { SESSION_EXPIRED } from "../services/apiErrors";
import {
  CHANGE_FIELD_OPTIONS,
  toChangeField,
} from "../services/eventChangeFields";

const DATE_CHANGE_FIELDS = new Set(["proposed_start", "proposed_end"]);
const MAX_CHANGES = 9;
const NOTE_MAX_LENGTH = 2000;

const SUBMIT_ERROR_MESSAGES = {
  400: "Your change request can't be submitted as written. Check each change and try again.",
  401: SESSION_EXPIRED,
  403: "This event can't be changed from your account.",
  404: "This event can't be found. It may have been removed.",
};

let nextKey = 0;
const newRow = () => ({ key: ++nextKey, option: "", details: "" });

/** What the form refuses before sending: blanks, a field twice, a mixed cancellation. */
function rowErrors(rows) {
  const errors = rows.map(() => null);
  const seen = new Map();
  rows.forEach((row, i) => {
    const changeField = toChangeField(row.option);
    if (!row.option) errors[i] = "Choose what you'd like to change.";
    else if (!row.details.trim()) {
      errors[i] = changeField === "cancellation" ? "Say why you want to cancel." : "Describe the change you're requesting.";
    } else if (seen.has(changeField)) {
      // Accessibility and "Something else" both travel as `other` (eventChangeFields.js).
      errors[i] = changeField === "other"
        ? "Put accessibility and other changes in one 'Something else' entry."
        : "This field is already in this request.";
    }
    if (changeField) seen.set(changeField, i);
  });
  return errors;
}

/** A 400's details[] as messages per row, keyed by changes[i].field. */
function serverRowErrors(details, count) {
  const errors = Array.from({ length: count }, () => null);
  const rest = [];
  for (const detail of details) {
    const row = detail?.field?.match(/^changes\[(\d+)\]/);
    if (row && Number(row[1]) < count) errors[Number(row[1])] = detail.message;
    else rest.push(detail);
  }
  return { errors, rest };
}

export default function ChangeRequestForm({ eventRequestId, onSubmitted }) {
  const [rows, setRows] = useState(() => [newRow()]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [errors, setErrors] = useState([]);
  const [otherErrors, setOtherErrors] = useState([]);
  const [success, setSuccess] = useState(false);

  const cancelling = rows.some((row) => toChangeField(row.option) === "cancellation");
  const noteTooLong = Array.from(note.trim()).length > NOTE_MAX_LENGTH;

  function update(index, patch) {
    setRows((current) => {
      const next = current.map((row, i) => (i === index ? { ...row, ...patch } : row));
      // A cancellation stands alone: choosing it removes the other rows.
      return toChangeField(next[index].option) === "cancellation" ? [next[index]] : next;
    });
    setErrors([]);
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const local = rowErrors(rows);
    if (local.some(Boolean) || noteTooLong) {
      setErrors(local);
      setError(noteTooLong ? "The note must be 2,000 characters or fewer." : null);
      return;
    }

    setSubmitting(true);
    setError(null);
    setErrors([]);
    setOtherErrors([]);
    try {
      // Mapped exactly once, here: the dropdown's values are the form's own
      // vocabulary; `field` on the wire is the Postgres enum event_change_field.
      await submitChangeRequest(eventRequestId, {
        changes: rows.map((row) => {
          const field = toChangeField(row.option);
          return {
            field,
            details: DATE_CHANGE_FIELDS.has(field) ? new Date(row.details).toISOString() : row.details.trim(),
          };
        }),
        ...(note.trim() && { note: note.trim() }),
      });
      setSuccess(true);
      setRows([newRow()]);
      setNote("");
      onSubmitted?.();
    } catch (err) {
      const details = err.response?.status === 400 ? err.response.data?.details : null;
      if (Array.isArray(details) && details.length > 0) {
        const { errors: byRow, rest } = serverRowErrors(details, rows.length);
        setErrors(byRow);
        setOtherErrors(rest);
      } else {
        setError(SUBMIT_ERROR_MESSAGES[err.response?.status] || "Could not submit your change request. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="change-request-form__success">
        <p>Your change request has been submitted.</p>
        <button onClick={() => setSuccess(false)}>Request another change</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="change-request-form" noValidate>
      <h2>Request a change</h2>

      {rows.map((row, index) => {
        const changeField = toChangeField(row.option);
        const label = `Change ${index + 1}`;
        return (
          <fieldset key={row.key} className="change-request-form__row" aria-label={label}>
            <label>
              What needs to change?
              <select
                value={row.option}
                onChange={(e) => update(index, { option: e.target.value, details: "" })}
              >
                <option value="" disabled>
                  Select an option
                </option>
                {CHANGE_FIELD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Accessibility has no enum member and travels as "Something else",
                said out loud so the Organiser knows where to look for it. */}
            {changeField === "other" && row.option !== "other" && (
              <p className="change-request-form__notice">
                This will be recorded as "Something else" — there is no separate
                category for it yet, so please describe it fully below.
              </p>
            )}

            <label>
              {changeField === "cancellation" ? "Why do you want to cancel?" : "Describe the change"}
              {DATE_CHANGE_FIELDS.has(changeField) ? (
                <input type="datetime-local" value={row.details} onChange={(e) => update(index, { details: e.target.value })} />
              ) : changeField === "expected_attendance" ? (
                <input type="number" min="1" step="1" value={row.details} onChange={(e) => update(index, { details: e.target.value })} />
              ) : (
                <textarea
                  value={row.details}
                  onChange={(e) => update(index, { details: e.target.value })}
                  rows={changeField === "cancellation" ? 3 : 4}
                  placeholder={changeField === "cancellation" ? "" : "Describe the new value or arrangement"}
                />
              )}
            </label>
            {errors[index] && <p className="change-request-form__error">{errors[index]}</p>}
            {rows.length > 1 && (
              <button type="button" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
                Remove
              </button>
            )}
          </fieldset>
        );
      })}

      {!cancelling && (
        <button type="button" disabled={rows.length >= MAX_CHANGES} onClick={() => setRows((current) => [...current, newRow()])}>
          Add another change
        </button>
      )}

      <label>
        Note for the coordinator (optional)
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </label>

      {error && <p className="change-request-form__error" role="alert">{error}</p>}
      {otherErrors.length > 0 && (
        <div className="change-request-form__details-errors" role="alert">
          <p>Your change request can't be submitted yet:</p>
          <ul>
            {otherErrors.map((problem, i) => <li key={i}>{problem.message}</li>)}
          </ul>
        </div>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit change request"}
      </button>
    </form>
  );
}
