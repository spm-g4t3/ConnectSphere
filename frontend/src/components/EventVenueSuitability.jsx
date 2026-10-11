// EventVenueSuitability.jsx
//
// SCRUM-192 (SCRUM-188 AC6, Week 7). The "Venue suitability" section of the
// coordinator's event view: every venue this event has requested or booked,
// rechecked against the event as it is now, with any failure shown on the
// event.
//
// Why it rechecks on view rather than reading a stored flag: the event's
// dates and attendance change through three separate paths (draft edit,
// clarification amendment, approved change request) and a venue's details
// (setup and turnaround included) through the venue edit, and none of them
// share a hook. Asking the server on every view covers all of them, so the
// answer can never be stale. The stored result stays the request-time record
// and is shown only as "Requested although it did not meet: ...".
//
// Rules worth keeping:
//
//   - The parent keys this component by the event's id, period and
//     attendance (and a version bumped after a booking request), so a change
//     that lands while the event is open remounts it and the recheck happens
//     then. "Recheck" covers a venue edited elsewhere in the meantime.
//   - A venue that fails is an answer, not an error. Its role="alert" line
//     names what newly fails (newlyUnmet), so a failure the coordinator
//     already accepted at request time does not raise the alarm again.
//   - Only a failed call shows the error with "Try again". A retired venue
//     fails only its own item; the event's other venues still show.
//   - Server prose is never shown: a retired item's error.message carries a
//     raw venue id, so it is worded here from its code, the same rule as
//     venueSuitabilityErrors.js.
//   - The criteria and checked values are VenueSuitabilityResult's (SCRUM-191),
//     reused unchanged, so the recheck reads the same as the check.

import { useEffect, useState } from "react";
import { getEventVenueSuitability } from "../services/venueSuitabilityService";
import { suitabilityErrorMessage } from "../services/venueSuitabilityErrors";
import VenueSuitabilityResult from "./VenueSuitabilityResult";

const RETIRED_MESSAGE = "It can no longer host this event, so request another venue.";
const ITEM_ERROR_MESSAGE = "This venue could not be rechecked. Press Recheck to try again.";

function namesText(names) {
  return Array.isArray(names) ? names.filter(Boolean).join(", ") : "";
}

function BookingSuitability({ item }) {
  const name = item?.venueName ?? "This venue";
  const statusLabel = item?.statusDisplay?.label ?? item?.status ?? null;
  const retired = item?.error?.code === "VENUE_RETIRED";
  const current = item?.current ?? null;
  const suitable = current?.suitable === true;
  const newlyUnmet = namesText(item?.newlyUnmet);
  const acceptedUnmet = item?.suitabilityOverridden ? namesText(item?.atRequest?.unmet) : "";

  let verdict = null;
  if (current) verdict = suitable ? "Suitable" : "Not suitable";

  return (
    <li className="event-venue-suitability__item">
      <h4>{name}</h4>
      <p className="event-venue-suitability__meta">
        {item?.venueLocation && <span>{item.venueLocation}</span>}
        {statusLabel && <span>Booking: {statusLabel}</span>}
        {verdict && (
          <span
            className={`event-venue-suitability__verdict event-venue-suitability__verdict--${suitable ? "met" : "unmet"}`}
          >
            {verdict}
          </span>
        )}
      </p>

      {retired && (
        <p className="event-venue-suitability__alert" role="alert">
          This venue has been retired. {RETIRED_MESSAGE}
        </p>
      )}

      {!retired && item?.error && (
        <p className="event-venue-suitability__alert" role="alert">
          {ITEM_ERROR_MESSAGE}
        </p>
      )}

      {current && !suitable && newlyUnmet && (
        <p className="event-venue-suitability__alert" role="alert">
          This venue no longer meets the event&apos;s requirements: {newlyUnmet}
        </p>
      )}

      {acceptedUnmet && (
        <p className="event-venue-suitability__note">
          Requested although it did not meet: {acceptedUnmet}
        </p>
      )}

      {current && (
        <details className="event-venue-suitability__details" open={!suitable}>
          <summary>Criteria for {name}</summary>
          <VenueSuitabilityResult result={current} />
        </details>
      )}
    </li>
  );
}

export default function EventVenueSuitability({ eventRequestId }) {
  // Starts as loading, so the effect never has to set state before its call.
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  // Bumped by "Recheck" and "Try again" to run the effect once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getEventVenueSuitability(eventRequestId)
      .then((items) => {
        if (!cancelled) {
          setState({ status: "done", items: Array.isArray(items) ? items : [], error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", items: [], error: suitabilityErrorMessage(err) });
      });
    // An answer for an event this view has since left, or a superseded
    // recheck, is dropped.
    return () => {
      cancelled = true;
    };
  }, [eventRequestId, attempt]);

  function recheck() {
    setState({ status: "loading", items: [], error: null });
    setAttempt((n) => n + 1);
  }

  return (
    <div className="event-venue-suitability">
      {state.status === "loading" && (
        <p className="event-venue-suitability__loading" role="status">
          Rechecking this event&apos;s venues...
        </p>
      )}

      {state.status === "error" && (
        <>
          <p className="event-venue-suitability__error" role="alert">
            {state.error}
          </p>
          <button type="button" onClick={recheck}>
            Try again
          </button>
        </>
      )}

      {state.status === "done" && state.items.length === 0 && (
        <p className="event-venue-suitability__empty">No venue has been requested for this event yet.</p>
      )}

      {state.status === "done" && state.items.length > 0 && (
        <ul className="event-venue-suitability__list" aria-label="Requested venues">
          {state.items.map((item, i) => (
            <BookingSuitability key={item?.bookingId ?? i} item={item} />
          ))}
        </ul>
      )}

      {state.status === "done" && (
        <button type="button" className="event-venue-suitability__recheck" onClick={recheck}>
          Recheck
        </button>
      )}
    </div>
  );
}
