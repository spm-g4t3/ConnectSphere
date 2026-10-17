// FlaggedBookingReasonForm.jsx
//
// The required reason behind resolving a flagged booking: Venue Staff's
// reinstate and cancel, and the coordinator's cancel on the event screen.
// Checked here as the server checks it, so a refusal shows beside the field.

import { useState } from "react";

// The server's limit on the reason (booking_resolutions, 076).
const MAX_TEXT = 1000;

/** The reason as sent, or the message to show beside the field instead. */
function checkReason(reason, verb) {
  const trimmed = reason.trim();
  if (!trimmed) return { error: `Enter a reason for ${verb} this booking.` };
  // Code points, as the server counts them.
  if (Array.from(trimmed).length > MAX_TEXT) {
    return { error: `The reason must be ${MAX_TEXT} characters or fewer.` };
  }
  return { reason: trimmed };
}

/** One reason form: a required textarea and its submit button. */
export default function FlaggedBookingReasonForm({ id, label, verb, busy, sendingLabel, buttonLabel, onSubmit }) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(null);
  const errorId = `${id}-error`;

  function handleSubmit(e) {
    e.preventDefault();
    const checked = checkReason(reason, verb);
    setReasonError(checked.error ?? null);
    if (checked.reason) onSubmit(checked.reason);
  }

  return (
    <form className="pending-bookings__reject" onSubmit={handleSubmit} noValidate>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={reason}
        maxLength={MAX_TEXT}
        required
        aria-invalid={reasonError ? "true" : undefined}
        aria-describedby={reasonError ? errorId : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {reasonError && (
        <p id={errorId} className="pending-bookings__field-error">
          {reasonError}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {sendingLabel ?? buttonLabel}
      </button>
    </form>
  );
}
