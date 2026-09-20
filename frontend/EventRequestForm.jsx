// EventRequestForm.jsx
//
// Shared UI for both SCRUM-10 (create a new draft) and SCRUM-11 (save/edit
// an existing draft). Same fields, same layout, same validation either way
// — the only difference is whether it's pre-filled with an existing draft
// and whether it calls create or update on submit.
//
// Fields: event name, purpose, date, expected attendance, requirements.
//
// Field mapping to the real backend schema (001_event_requests.sql):
//   event_name          <- Event name
//   purpose             <- Purpose
//   proposed_start/end  <- Date (start and end)
//   expected_attendance <- Expected attendance
//   description         <- Requirements — the schema doesn't have a
//                          separate "requirements" column, so this assumes
//                          requirements go in `description`. CONFIRM this
//                          with your backend teammate.
//
// Usage:
//   Create (SCRUM-10):  <EventRequestForm onSaved={...} />
//   Edit   (SCRUM-11):  <EventRequestForm existingRequest={draft} onSaved={...} />

import { useState } from "react";
import {
  createEventRequest,
  updateEventRequest,
} from "../services/eventRequestService";

/** Converts an ISO timestamp from the backend into the value <input type="datetime-local"> expects. */
function toDatetimeLocal(isoString) {
  if (!isoString) return "";
  // Slice off seconds/timezone — datetime-local wants "YYYY-MM-DDTHH:mm"
  return isoString.slice(0, 16);
}

export default function EventRequestForm({ existingRequest = null, onSaved }) {
  const isEditMode = Boolean(existingRequest);

  const [form, setForm] = useState({
    eventName: existingRequest?.eventName ?? existingRequest?.event_name ?? "",
    purpose: existingRequest?.purpose ?? "",
    proposedStart: toDatetimeLocal(
      existingRequest?.proposedStart ?? existingRequest?.proposed_start,
    ),
    proposedEnd: toDatetimeLocal(
      existingRequest?.proposedEnd ?? existingRequest?.proposed_end,
    ),
    expectedAttendance:
      existingRequest?.expectedAttendance ??
      existingRequest?.expected_attendance ??
      "",
    requirements: existingRequest?.description ?? "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function validate() {
    if (!form.eventName.trim()) {
      return "Event name is required.";
    }
    if (
      form.proposedStart &&
      form.proposedEnd &&
      new Date(form.proposedEnd) <= new Date(form.proposedStart)
    ) {
      return "End time must be after the start time.";
    }
    if (
      form.expectedAttendance &&
      (!Number.isInteger(Number(form.expectedAttendance)) ||
        Number(form.expectedAttendance) <= 0)
    ) {
      return "Expected attendance must be a positive whole number.";
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload = {
      eventName: form.eventName.trim(),
      purpose: form.purpose.trim() || null,
      proposedStart: form.proposedStart || null,
      proposedEnd: form.proposedEnd || null,
      expectedAttendance: form.expectedAttendance
        ? Number(form.expectedAttendance)
        : null,
      description: form.requirements.trim() || null,
    };

    try {
      const saved = isEditMode
        ? await updateEventRequest(existingRequest.id, payload)
        : await createEventRequest(payload);
      onSaved?.(saved);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          `Could not ${isEditMode ? "save" : "create"} your event request. Please try again.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="event-request-form">
      <h1>{isEditMode ? "Edit draft request" : "Create event request"}</h1>

      <label>
        Event name
        <input
          type="text"
          value={form.eventName}
          onChange={(e) => updateField("eventName", e.target.value)}
          required
        />
      </label>

      <label>
        Purpose
        <textarea
          value={form.purpose}
          onChange={(e) => updateField("purpose", e.target.value)}
          rows={2}
          placeholder="Why is this event happening?"
        />
      </label>

      <div className="event-request-form__row">
        <label>
          Start date &amp; time
          <input
            type="datetime-local"
            value={form.proposedStart}
            onChange={(e) => updateField("proposedStart", e.target.value)}
          />
        </label>

        <label>
          End date &amp; time
          <input
            type="datetime-local"
            value={form.proposedEnd}
            onChange={(e) => updateField("proposedEnd", e.target.value)}
          />
        </label>
      </div>

      <label>
        Expected attendance
        <input
          type="number"
          min="1"
          value={form.expectedAttendance}
          onChange={(e) => updateField("expectedAttendance", e.target.value)}
        />
      </label>

      <label>
        Requirements
        <textarea
          value={form.requirements}
          onChange={(e) => updateField("requirements", e.target.value)}
          rows={4}
          placeholder="Venue needs, equipment, accessibility requirements, etc."
        />
      </label>

      {error && <p className="event-request-form__error" role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting
          ? isEditMode
            ? "Saving..."
            : "Creating..."
          : isEditMode
            ? "Save changes"
            : "Create event request"}
      </button>
    </form>
  );
}
