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
// The override is a two-step inline confirm rather than a modal or
// window.confirm, for the reason VenueCatalogue's retire button gives: there
// is no modal primitive anywhere in this frontend, and a state variable and
// two buttons are not a new one to maintain.
//
// The ids handed to onConfirmOverride are the ones on screen -- the list the
// Venue Staff member actually saw -- so the backend can refuse an override
// over a booking that arrived after they looked.

import { useState } from "react";
import { shortId } from "../services/displayFormat";
import { formatOccupiedPeriod } from "../services/occupiedPeriodDisplay";

/** "1 approved booking" / "3 approved bookings". */
function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The set of bookings a confirm was opened for, independent of order.
 *
 * The confirm is remembered against this rather than as a bare boolean, so
 * when the parent replaces the list with a different set -- a stale override
 * came back with a new 409 -- the confirm closes by itself: the user never
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
}) {
  // The signature the confirm was opened for, or null when it is closed.
  const [confirmingFor, setConfirmingFor] = useState(null);

  if (conflicts.length === 0) return null;

  const signature = signatureOf(conflicts);
  const confirming = confirmingFor !== null && confirmingFor === signature;
  const count = conflicts.length;

  return (
    <section className="block-conflicts">
      <div role="status">
        <h3>This period overlaps {countLabel(count, "approved booking")}</h3>
      </div>

      <ul className="block-conflicts__list">
        {conflicts.map((conflict, i) => (
          <li key={conflict.bookingId ?? i}>
            <strong>{conflict.eventName || "Unnamed event"}</strong>
            <span>{formatOccupiedPeriod(conflict)}</span>
            <code title={conflict.eventRequestId ?? undefined}>
              {conflict.eventRequestId ? shortId(conflict.eventRequestId) : "no event"}
            </code>
          </li>
        ))}
      </ul>

      <div className="block-conflicts__actions">
        <button type="button" onClick={() => onChangePeriod?.()} disabled={submitting}>
          Choose a different period
        </button>

        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirmingFor(signature)}
            disabled={submitting}
          >
            Override and flag {countLabel(count, "booking")}
          </button>
        )}

        {confirming && (
          <>
            <span>Flag these bookings for review and notify each event's coordinator?</span>
            <button
              type="button"
              onClick={() => onConfirmOverride?.(conflicts.map((c) => c.bookingId))}
              disabled={submitting}
            >
              {submitting ? "Flagging..." : "Yes, override"}
            </button>
            <button type="button" onClick={() => setConfirmingFor(null)} disabled={submitting}>
              Cancel
            </button>
          </>
        )}
      </div>
    </section>
  );
}
