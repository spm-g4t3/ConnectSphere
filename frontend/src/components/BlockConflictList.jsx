// BlockConflictList.jsx
//
// SCRUM-125 (part of SCRUM-17, AC3): "A block that overlaps an existing
// approved booking is not created silently: the conflicting bookings are
// listed to the Venue Staff member, who must either choose a non-overlapping
// period or explicitly confirm the override."
//
// The list, and the two ways out of it. Presentational on purpose, like
// VenueBlockForm: it calls no service. The parent holds the conflicts the API
// returned (the BLOCK_BOOKING_CONFLICT 409's `conflicts`), passes
// `submitting`, and resends the block with the ids this hands back. That
// parent is VenueBlocksPanel (SCRUM-127).
//
// The override asks again in the shared ConfirmDialog before anything is sent.
//
// The ids handed to onConfirmOverride are the ones on screen -- the list the
// Venue Staff member actually saw -- so the backend can refuse an override
// over a booking that arrived after they looked.
//
// The wording props let VenueForm reuse it for bookings that new opening hours
// leave out; each defaults to the block wording, and formatPart writes each
// period (the standard date format when absent).

import { useEffect, useRef, useState } from "react";
import { formatDateTimeRange, shortId } from "../services/displayFormat";
import { formatOccupiedPeriod } from "../services/occupiedPeriodDisplay";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";

/** "1 approved booking" / "3 approved bookings". */
function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The set of bookings the dialog was opened for, independent of order.
 *
 * The dialog is remembered against this rather than as a bare boolean, so
 * when the parent replaces the list with a different set -- a stale override
 * came back with a new 409 -- the dialog closes by itself: the user never
 * confirms bookings they have not seen. The same ids reordered keep it open.
 * No effect and no `key` needed; it is derived on every render.
 */
function signatureOf(conflicts) {
  return conflicts
    .map((conflict) => String(conflict.bookingId))
    .sort()
    .join(",");
}

export default function BlockConflictList({
  conflicts = [],
  onChangePeriod,
  onConfirmOverride,
  submitting = false,
  heading,
  intro,
  changeLabel = "Choose a different period",
  overrideLabel,
  confirmText = "Flag these bookings for review and notify each event's coordinator?",
  confirmLabel = "Override and flag",
  formatPart = formatDateTimeRange,
}) {
  // The signature the dialog was opened for, or null when it is closed.
  const [confirmingFor, setConfirmingFor] = useState(null);
  const overrideButtonRef = useRef(null);

  // The dialog stays open, busy, while the override is in flight, and closes
  // when it ends: success unmounts the list, and a failure's message sits
  // behind the modal, where it could not be read.
  const [wasSubmitting, setWasSubmitting] = useState(submitting);
  if (submitting !== wasSubmitting) {
    setWasSubmitting(submitting);
    if (!submitting) setConfirmingFor(null);
  }

  const signature = signatureOf(conflicts);
  const confirming = confirmingFor !== null && confirmingFor === signature;

  // However the dialog closes, focus goes back to the button that opened it,
  // which is still on the page unless the list itself went away.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) overrideButtonRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (conflicts.length === 0) return null;

  const count = conflicts.length;

  return (
    <section className="block-conflicts">
      <div role="status">
        <h3>{heading ?? `This period overlaps ${countLabel(count, "approved booking")}`}</h3>
        {intro && <p>{intro}</p>}
      </div>

      <ul className="block-conflicts__list">
        {conflicts.map((conflict, i) => (
          <li key={conflict.bookingId ?? i}>
            <strong>{conflict.eventName || "Unnamed event"}</strong>
            <span>{formatOccupiedPeriod(conflict, formatPart)}</span>
            <code title={conflict.eventRequestId ?? undefined}>
              {conflict.eventRequestId ? shortId(conflict.eventRequestId) : "no event"}
            </code>
          </li>
        ))}
      </ul>

      <div className="block-conflicts__actions">
        <Button variant="secondary" onClick={() => onChangePeriod?.()} disabled={submitting}>
          {changeLabel}
        </Button>

        <Button
          ref={overrideButtonRef}
          variant="danger"
          onClick={() => setConfirmingFor(signature)}
          disabled={submitting}
        >
          {overrideLabel ?? `Override and flag ${countLabel(count, "booking")}`}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title={confirmText}
        confirmLabel={submitting ? "Flagging..." : confirmLabel}
        danger
        busy={submitting}
        onConfirm={() => onConfirmOverride?.(conflicts.map((c) => c.bookingId))}
        onCancel={() => setConfirmingFor(null)}
      >
        {countLabel(count, "booking")} will be flagged for review, not cancelled.
      </ConfirmDialog>
    </section>
  );
}
