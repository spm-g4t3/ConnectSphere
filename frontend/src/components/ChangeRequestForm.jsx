// ChangeRequestForm.jsx
// Lets an Event Organiser request changes to a submitted event and specify
// which event information or arrangement needs updating (SCRUM-32).
//
// AC covered here: "can request changes after submission" and "can specify
// the information or arrangement that needs to be changed". Tracking whether
// it's processed, and applying the change once processed, are separate
// concerns — likely the other two subtasks you're about to send me.

import { useState } from "react";
import { submitChangeRequest } from "../services/changeRequestService";
import {
  CHANGE_FIELD_OPTIONS,
  toChangeField,
} from "../services/eventChangeFields";

const DATE_CHANGE_FIELDS = new Set(["proposed_start", "proposed_end"]);

export default function ChangeRequestForm({ eventRequestId, onSubmitted }) {
  const [field, setField] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // The backend reports a rejected value as [{ field, message }] -- notably
  // for expected_attendance, where checkRequestedChange refuses anything
  // non-numeric. Kept separate from `error` so "about 200 people" produces
  // the sentence that explains itself instead of a generic retry message the
  // Organiser could read forever without learning what to do.
  const [detailErrors, setDetailErrors] = useState([]);
  const [success, setSuccess] = useState(false);

  // Which enum member this choice will travel as. Read during render too, for
  // the notice below, so it is computed once here rather than twice.
  const changeField = toChangeField(field);

  async function handleSubmit(e) {
    e.preventDefault();

    if (!field) {
      setError("Please choose what you'd like to change.");
      return;
    }
    if (!details.trim()) {
      setError("Please describe the change you're requesting.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setDetailErrors([]);

    try {
      const requestedChange = DATE_CHANGE_FIELDS.has(changeField)
        ? new Date(details).toISOString()
        : details.trim();

      // Mapped exactly once, here. The dropdown's values are the form's own
      // vocabulary; `field` on the wire is the Postgres enum
      // event_change_field. Sending the option value straight through -- which
      // is what this used to do -- was a 400 on every single choice.
      await submitChangeRequest(eventRequestId, {
        field: changeField,
        details: requestedChange,
      });
      setSuccess(true);
      setField("");
      setDetails("");
      onSubmitted?.();
    } catch (err) {
      const problems = err.response?.data?.details;
      if (Array.isArray(problems) && problems.length > 0) {
        setDetailErrors(problems);
      } else {
        setError(
          err.response?.data?.error ||
            "Could not submit your change request. Please try again.",
        );
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
    <form onSubmit={handleSubmit} className="change-request-form">
      <h2>Request a change</h2>

      <label>
        What needs to change?
        <select
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setDetails("");
            setError(null);
            setDetailErrors([]);
          }}
          required
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

      {/*
        Shown when the choice has no enum member of its own and travels as
        "Something else" -- accessibility today, and anything added later that
        the database has no heading for. Said out loud rather than done
        silently: the Coordinator's list will show this request as "Something
        else", and an Organiser who expected to see "Accessibility" there
        would otherwise think it had gone to the wrong place.
      */}
      {changeField === "other" && field !== "other" && (
        <p className="change-request-form__notice">
          This will be recorded as "Something else" — there is no separate
          category for it yet, so please describe it fully below.
        </p>
      )}

      <label>
        Describe the change
        {DATE_CHANGE_FIELDS.has(changeField) ? (
          <input
            type="datetime-local"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            required
          />
        ) : changeField === "expected_attendance" ? (
          <input
            type="number"
            min="1"
            step="1"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            required
          />
        ) : (
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            rows={4}
            placeholder="Describe the new value or arrangement"
            required
          />
        )}
      </label>

      {error && <p className="change-request-form__error" role="alert">{error}</p>}

      {/*
        The same renderer EventRequestForm uses for a submit's details[], and
        the same reasoning: the backend already names every fault precisely,
        so flattening them into one generic sentence throws away the only
        thing that tells the Organiser what to type instead.
      */}
      {detailErrors.length > 0 && (
        <div className="change-request-form__details-errors" role="alert">
          <p>Your change request can't be submitted yet:</p>
          <ul>
            {detailErrors.map((problem, i) => (
              <li key={i}>
                {problem.field ? `${problem.field}: ` : ""}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit change request"}
      </button>
    </form>
  );
}
