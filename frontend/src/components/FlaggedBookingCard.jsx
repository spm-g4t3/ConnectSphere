// FlaggedBookingCard.jsx
//
// One booking in Venue Staff's flagged list. Collapsed, a single row (event,
// venue, period, why it was flagged); expanded, the detail and the reinstate
// and cancel forms.
//
// Holds only the two forms' drafts. Whether it is expanded, whether a
// resolution is in flight and what went wrong belong to FlaggedBookings, which
// owns the list and refetches it after every resolution.

import { useState } from "react";
import { statusLabel } from "../services/bookingRequestEligibility";
import { formatTimestamp } from "../services/displayFormat";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { conflictText } from "../services/flaggedBookingErrors";
import { flagReasons } from "../services/flaggedBookingDisplay";

// The server's limit on the reason (booking_resolutions, 076).
const MAX_TEXT = 1000;

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
function ReasonForm({ id, label, verb, busy, sendingLabel, buttonLabel, onSubmit }) {
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

export default function FlaggedBookingCard({
  item,
  expanded,
  onToggle,
  busy,
  resolving,
  error,
  conflicts,
  onReinstate,
  onCancel,
}) {
  const reasons = flagReasons(item);
  const clashes = Array.isArray(conflicts) ? conflicts : [];
  const eventName = item.eventName || "Unnamed event";
  const venueName = item.venueName || "Unknown venue";
  const regionId = `flagged-booking-${item.id}`;

  return (
    <li className="pending-bookings__card">
      {/* Locked while any resolution is in flight, so the resolving card stays
          open and a refusal shown inside it is not lost to another card. */}
      <button
        type="button"
        className="pending-bookings__toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        disabled={busy}
        onClick={() => onToggle(item.id)}
      >
        <strong>{eventName}</strong>
        <span>{venueName}</span>
        <span>{formatVenuePeriod(item.startsAt, item.endsAt)}</span>
        <span>{reasons.map((r) => r.text).join("; ")}</span>
      </button>

      {expanded && (
        <div id={regionId} role="region" aria-label={`${eventName} at ${venueName}`} className="pending-bookings__detail">
          <dl>
            <dt>Event status</dt>
            <dd>{capitalise(statusLabel(item.eventStatus))}</dd>
            <dt>Venue</dt>
            <dd>
              {venueName}
              {item.venueLocation ? `, ${item.venueLocation}` : ""}
            </dd>
            <dt>Booking period</dt>
            <dd>{formatVenuePeriod(item.startsAt, item.endsAt)}</dd>
            <dt>Event&apos;s current period</dt>
            <dd>{formatVenuePeriod(item.eventStartsAt, item.eventEndsAt)}</dd>
            <dt>Flagged</dt>
            <dd>{formatTimestamp(item.flaggedAt, "at an unknown time")}</dd>
          </dl>

          <h3>Why it was flagged</h3>
          <ul className="pending-bookings__overlapping">
            {reasons.map((r) => (
              <li key={r.kind}>
                <strong>{r.text}</strong>
                {r.details.map((detail) => (
                  <span key={detail}>{detail}</span>
                ))}
              </li>
            ))}
          </ul>

          {error && (
            <p className="pending-bookings__error" role="alert">
              {error}
            </p>
          )}
          {clashes.length > 0 && (
            <>
              <h3>What is in the way</h3>
              <ul className="pending-bookings__overlapping">
                {clashes.map((clash, i) => (
                  <li key={`${clash.kind}-${i}`}>
                    <strong>{capitalise(conflictText(clash))}</strong>
                    <span>Occupies {formatVenuePeriod(clash.occupiedStartsAt, clash.occupiedEndsAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {item.reinstatable ? (
            <ReasonForm
              id={`${regionId}-reinstate`}
              label="Reason for reinstating (required)"
              verb="reinstating"
              busy={busy}
              buttonLabel="Reinstate"
              sendingLabel={resolving === "reinstate" ? "Reinstating..." : null}
              onSubmit={(reason) => onReinstate(item, reason)}
            />
          ) : (
            <p className="pending-bookings__event-status">
              Resolve by cancelling; a safety flag can&apos;t be reinstated.
            </p>
          )}

          <ReasonForm
            id={`${regionId}-cancel`}
            label="Reason for cancelling (required)"
            verb="cancelling"
            busy={busy}
            buttonLabel="Cancel booking"
            sendingLabel={resolving === "cancel" ? "Cancelling..." : null}
            onSubmit={(reason) => onCancel(item, reason)}
          />
        </div>
      )}
    </li>
  );
}
