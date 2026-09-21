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

// What an Organiser might reasonably want to change. Adjust to match the
// actual fields your event_requests table supports editing post-submission.
const CHANGEABLE_FIELDS = [
  { value: "event_name", label: "Event name" },
  { value: "description", label: "Description" },
  { value: "proposed_start", label: "Date / start time" },
  { value: "proposed_end", label: "End time" },
  { value: "expected_attendance", label: "Expected attendance" },
  { value: "venue", label: "Venue" },
  { value: "equipment", label: "Equipment" },
  { value: "other", label: "Something else" },
];

export default function ChangeRequestForm({ eventRequestId, onSubmitted }) {
  const [field, setField] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

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

    try {
      await submitChangeRequest(eventRequestId, {
        field,
        details: details.trim(),
      });
      setSuccess(true);
      setField("");
      setDetails("");
      onSubmitted?.();
    } catch (err) {
      setError("Could not submit your change request. Please try again.");
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
        <select value={field} onChange={(e) => setField(e.target.value)} required>
          <option value="" disabled>
            Select an option
          </option>
          {CHANGEABLE_FIELDS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Describe the change
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={4}
          placeholder="e.g. Move the event from 10am to 2pm on the same day"
          required
        />
      </label>

      {error && <p className="change-request-form__error" role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? "Submitting..." : "Submit change request"}
      </button>
    </form>
  );
}
