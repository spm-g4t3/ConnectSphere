// VenueHoldForm.jsx
//
// SCRUM-491 (AC2): "a hold is for one Approved event and one venue ... with
// an expiry". The venue is the panel's, so the form asks only the two things
// Venue Staff choose: which Approved event, and when the hold expires.
//
// Presentational on purpose, like VenueBlockForm. It calls no service: the
// parent (VenueHoldsPanel) loads the Approved events and passes them in as
// `candidates`, owns the request, passes `submitting`, and hands back what
// the API said as `serverErrors` (the { field, message } details[]) and
// `formError` (anything else).
//
// onChanged tells the parent a field moved, so it can drop a conflict list
// computed for the old choice.

import { useId, useState } from "react";
import { deviceTimeZoneLabel } from "../services/datetimeFormat";
import { formatRange } from "../services/displayFormat";
import { toHoldPayload, validateHoldInput } from "../services/venueHoldValidation";
import { fieldErrorWiring } from "./fieldErrors";

/** The fields that render their own errors. Anything else goes in the alert. */
const FIELDS = ["eventRequestId", "expiresAt"];

/**
 * One event in the picker: name, period, attendance and coordinator, so two
 * events with the same name can still be told apart.
 */
function candidateLabel(candidate) {
  const parts = [
    candidate.eventName || "Unnamed event",
    formatRange(candidate.proposedStart, candidate.proposedEnd, "no date"),
  ];
  if (Number.isInteger(candidate.expectedAttendance)) {
    parts.push(`${candidate.expectedAttendance} attending`);
  }
  parts.push(`Coordinator: ${candidate.assignedCoordinatorName || "not assigned"}`);
  return parts.join(" · ");
}

export default function VenueHoldForm({
  candidates = [],
  loadingCandidates = false,
  candidatesError,
  onSubmit,
  onCancel,
  submitting = false,
  serverErrors = [],
  formError,
  onChanged,
}) {
  const idPrefix = useId();

  const [form, setForm] = useState({ eventRequestId: "", expiresAt: "" });
  const [clientErrors, setClientErrors] = useState([]);

  const allErrors = [...clientErrors, ...serverErrors];
  const unmatchedServerErrors = serverErrors.filter((err) => !FIELDS.includes(err.field));

  const { messagesFor, errorId, ariaFor } = fieldErrorWiring(idPrefix, allErrors);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Editing a field retires its client errors; server errors are the
    // parent's to clear.
    setClientErrors((prev) => prev.filter((err) => err.field !== field));
    onChanged?.();
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return; // closes the double-click window before it opens

    const errors = validateHoldInput(form);
    setClientErrors(errors);
    if (errors.length > 0) return;

    onSubmit?.(toHoldPayload(form));
  }

  function renderFieldErrors(field) {
    const messages = messagesFor(field);
    if (messages.length === 0) return null;
    return (
      <ul className="venue-hold-form__field-error" id={errorId(field)}>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    );
  }

  const showAlert = Boolean(formError) || unmatchedServerErrors.length > 0;
  const noCandidates = !loadingCandidates && !candidatesError && candidates.length === 0;

  return (
    <form className="venue-hold-form" onSubmit={handleSubmit} noValidate>
      <h2>Place a tentative hold</h2>

      {showAlert && (
        <div className="venue-hold-form__error" role="alert">
          {formError && <p>{formError}</p>}
          {unmatchedServerErrors.length > 0 && (
            <ul>
              {unmatchedServerErrors.map((err, i) => (
                <li key={i}>
                  {err.field ? `${err.field}: ` : ""}
                  {err.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <label>
          Approved event
          <select
            value={form.eventRequestId}
            onChange={(e) => updateField("eventRequestId", e.target.value)}
            disabled={submitting || loadingCandidates}
            {...ariaFor("eventRequestId")}
          >
            <option value="" disabled>
              {loadingCandidates ? "Loading events..." : "Choose an event"}
            </option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidateLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
        {candidatesError && (
          <p className="venue-hold-form__field-error" role="alert">
            {candidatesError}
          </p>
        )}
        {noCandidates && (
          <p className="venue-hold-form__hint">There are no Approved events to hold a venue for.</p>
        )}
        {renderFieldErrors("eventRequestId")}
        <p className="venue-hold-form__hint">
          The hold covers the event&apos;s own period, with this venue&apos;s setup and
          turnaround around it.
        </p>
      </div>

      <div>
        <label>
          Hold expires
          <input
            type="datetime-local"
            value={form.expiresAt}
            onChange={(e) => updateField("expiresAt", e.target.value)}
            disabled={submitting}
            {...ariaFor("expiresAt")}
          />
        </label>
        {renderFieldErrors("expiresAt")}
      </div>

      {/* Disclosure, not a picker -- the same wording VenueBlockForm uses. */}
      <p className="venue-hold-form__hint">
        Times are in your device&apos;s time zone ({deviceTimeZoneLabel()}). When the expiry
        passes, the hold ends on its own and the venue is free again.
      </p>

      <button type="submit" disabled={submitting}>
        {submitting ? "Placing..." : "Place hold"}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      )}
    </form>
  );
}
