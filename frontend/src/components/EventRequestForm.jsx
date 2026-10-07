// EventRequestForm.jsx
//
// Covers SCRUM-29 (create) and SCRUM-11 (edit a draft). Same component,
// same fields either way — pre-filled and calling update instead of create
// when editing.
//
// Two separate actions, matching SCRUM-10's ACs precisely:
//   "Save draft"  -> createEventRequest / updateEventRequest.
//                    Always succeeds even if incomplete (AC3) — a draft is
//                    allowed to be unfinished.
//   "Submit"      -> submitEventRequest, only enabled once the request has
//                    been saved (needs an id). Validates completeness
//                    server-side and shows every failing field at once
//                    (AC4), not just the first.
//
// On successful submit, shows a confirmation with the request's reference
// (its id) per AC7.

import { useState } from "react";
import {
  createEventRequest,
  updateEventRequest,
  submitEventRequest,
} from "../services/eventRequestService";
import {
  toDatetimeLocalValue,
  toOffsetIsoString,
  deviceTimeZoneLabel,
} from "../services/datetimeFormat";

export default function EventRequestForm({
  existingRequest = null,
  onSaved,
}) {
  const [requestId, setRequestId] = useState(existingRequest?.id ?? null);
  const [status, setStatus] = useState(existingRequest?.status ?? "draft");

  const [form, setForm] = useState({
    eventName: existingRequest?.eventName ?? "",
    purpose: existingRequest?.purpose ?? "",
    description: existingRequest?.description ?? "",
    // toDatetimeLocalValue, not the isoString.slice(0, 16) this used to do.
    // The slice took the first sixteen characters of a UTC-normalised string
    // and handed them to a control that renders local time, so a request
    // stored as 01:00+00:00 prefilled as 01:00 for a +08 Organiser instead of
    // 09:00 -- and saving the form then moved their event eight hours.
    proposedStart: toDatetimeLocalValue(existingRequest?.proposedStart),
    proposedEnd: toDatetimeLocalValue(existingRequest?.proposedEnd),
    expectedAttendance: existingRequest?.expectedAttendance ?? "",
    venueRequirements: existingRequest?.venueRequirements ?? "",
    accessibilityRequirements: existingRequest?.accessibilityRequirements ?? "",
    equipmentRequirements: existingRequest?.equipmentRequirements ?? "",
  });

  const [savingDraft, setSavingDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [draftSavedMessage, setDraftSavedMessage] = useState(null);
  // Submission errors are field-specific (AC4: every gap at once), so this
  // is an array of { field, message } rather than a single string.
  const [submitErrors, setSubmitErrors] = useState([]);
  const [confirmation, setConfirmation] = useState(null);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildPayload() {
    return {
      eventName: form.eventName.trim(),
      purpose: form.purpose.trim() || undefined,
      description: form.description.trim() || undefined,
      // An <input type="datetime-local"> emits "2026-06-01T09:00" with no
      // offset, and the backend's TIMESTAMP_PATTERN requires one -- so these
      // two fields 400'd every save that had a date in it. toOffsetIsoString
      // stamps the device's real offset for that instant and returns
      // undefined for "", which is the `|| undefined` this replaces.
      proposedStart: toOffsetIsoString(form.proposedStart),
      proposedEnd: toOffsetIsoString(form.proposedEnd),
      expectedAttendance: form.expectedAttendance
        ? Number(form.expectedAttendance)
        : undefined,
      venueRequirements: form.venueRequirements.trim() || undefined,
      accessibilityRequirements: form.accessibilityRequirements.trim() || undefined,
      equipmentRequirements: form.equipmentRequirements.trim() || undefined,
    };
  }

  async function handleSaveDraft(e) {
    e.preventDefault();

    if (!form.eventName.trim()) {
      setSaveError("Event name is required, even for a draft.");
      return;
    }

    setSavingDraft(true);
    setSaveError(null);
    setDraftSavedMessage(null);

    try {
      const saved = requestId
        ? await updateEventRequest(requestId, buildPayload())
        : await createEventRequest(buildPayload());

      setRequestId(saved.id);
      setStatus(saved.status);
      setDraftSavedMessage("Draft saved. You can submit it when you're ready.");
      onSaved?.(saved);
    } catch (err) {
      setSaveError(
        err.response?.data?.error || "Could not save your draft. Please try again.",
      );
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleSubmit() {
    if (!requestId) {
      setSaveError("Save the draft before submitting it.");
      return;
    }

    setSubmitting(true);
    setSubmitErrors([]);
    setDraftSavedMessage(null);

    try {
      const result = await submitEventRequest(requestId);
      setStatus(result.status);
      setConfirmation(result);
      onSaved?.(result);
    } catch (err) {
      const details = err.response?.data?.details;
      if (Array.isArray(details) && details.length > 0) {
        setSubmitErrors(details);
      } else {
        setSubmitErrors([
          { field: "", message: err.response?.data?.error || "Could not submit your request." },
        ]);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // AC7: confirmation shown with the request's reference once submitted.
  if (confirmation) {
    return (
      <div className="event-request-form__confirmation">
        <h1>Request submitted</h1>
        <p>
          Your event request has been received. Your reference number is:
        </p>
        <p className="event-request-form__reference">{confirmation.id}</p>
        <p>Keep this reference for tracking your request's status.</p>
      </div>
    );
  }

  const isDraft = status === "draft";
  const isEditable = isDraft;

  return (
    <form className="event-request-form">
      <h1>
        {requestId
            ? "Edit draft request"
            : "Create event request"}
      </h1>

      {!isEditable && requestId && (
        <p className="event-request-form__notice">
          This request has already been submitted. To change it now, use
          "Request a change" instead of editing directly.
        </p>
      )}

      <label>
        Event name
        <input
          type="text"
          value={form.eventName}
          onChange={(e) => updateField("eventName", e.target.value)}
          disabled={!isEditable}
          required
        />
      </label>

      <label>
        Purpose
        <textarea
          value={form.purpose}
          onChange={(e) => updateField("purpose", e.target.value)}
          rows={2}
          disabled={!isEditable}
          placeholder="Why is this event happening?"
        />
      </label>

      <label>
        Description
        <textarea
          value={form.description}
          onChange={(e) => updateField("description", e.target.value)}
          rows={3}
          disabled={!isEditable}
          placeholder="General description of the event"
        />
      </label>

      <div className="event-request-form__row">
        <label>
          Proposed start
          <input
            type="datetime-local"
            value={form.proposedStart}
            onChange={(e) => updateField("proposedStart", e.target.value)}
            disabled={!isEditable}
          />
        </label>

        <label>
          Proposed end
          <input
            type="datetime-local"
            value={form.proposedEnd}
            onChange={(e) => updateField("proposedEnd", e.target.value)}
            disabled={!isEditable}
          />
        </label>
      </div>

      {/*
        Disclosure, not a picker. The times above are sent with whatever
        offset this device is on, so the Organiser is told which one that is
        rather than left to assume. A real picker would need a venue to anchor
        the choice to, and no venue is attached to a request at draft time.
      */}
      <p className="event-request-form__hint">
        Times are in your device's time zone ({deviceTimeZoneLabel()}).
      </p>

      <label>
        Expected attendance
        <input
          type="number"
          min="1"
          value={form.expectedAttendance}
          onChange={(e) => updateField("expectedAttendance", e.target.value)}
          disabled={!isEditable}
        />
      </label>

      <label>
        Venue requirements
        <textarea
          value={form.venueRequirements}
          onChange={(e) => updateField("venueRequirements", e.target.value)}
          rows={3}
          disabled={!isEditable}
          placeholder="Size, layout, location, timing, anything else the space needs to support"
        />
      </label>

      <label>
        Accessibility requirements
        <textarea
          value={form.accessibilityRequirements}
          onChange={(e) => updateField("accessibilityRequirements", e.target.value)}
          rows={2}
          disabled={!isEditable}
          placeholder="Step-free access, hearing loop, etc."
        />
      </label>

      <label>
        Equipment requirements
        <textarea
          value={form.equipmentRequirements}
          onChange={(e) => updateField("equipmentRequirements", e.target.value)}
          rows={2}
          disabled={!isEditable}
          placeholder="Microphones, projector, staging, catering hookups, etc."
        />
      </label>

      {saveError && <p className="event-request-form__error" role="alert">{saveError}</p>}
      {draftSavedMessage && <p className="event-request-form__notice" role="status">{draftSavedMessage}</p>}

      {submitErrors.length > 0 && (
        <div className="event-request-form__submit-errors" role="alert">
          <p>Your request can't be submitted yet:</p>
          <ul>
            {submitErrors.map((err, i) => (
              <li key={i}>
                {err.field ? `${err.field}: ` : ""}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isDraft && (
        <div className="event-request-form__actions">
          <button type="button" onClick={handleSaveDraft} disabled={savingDraft}>
            {savingDraft ? "Saving..." : "Save draft"}
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !requestId}
            title={!requestId ? "Save the draft first" : undefined}
          >
            {submitting ? "Submitting..." : "Submit request"}
          </button>
          {!requestId && (
            <p className="event-request-form__submit-hint" role="status">
              Save the draft first to enable submission.
            </p>
          )}
        </div>
      )}

    </form>
  );
}
