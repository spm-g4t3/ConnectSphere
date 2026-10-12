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
//
// SCRUM-188 review fixes:
//   - A criterion overridden at request time reads "Not met — overridden by
//     coordinator" in the opened result too (AC6), the same as Venue Staff
//     see it.
//   - An item the server could not recheck says why in fixed copy, keyed by
//     its code (STORED_REQUIREMENTS_INVALID, RECHECK_FAILED); never its prose.
//   - onLoaded(items) tells the parent what came back, so the event's
//     "Find a venue" knows on load which venues already have a live request,
//     with each one's status, and does not offer those venues again (every
//     item here is a live booking, an errored one included). SCRUM-525: other
//     venues stay requestable; the lock is per venue.
//
// SCRUM-525 (AC5, R14): each booking also shows its own attendance and
// layout, outside the recheck result, so an item whose recheck failed still
// shows them. The attendance is the number the server applied; when the
// booking has none of its own and the event's was used, it says "(event's)",
// so a fallback is never read as the number requested, and with neither it
// says "Not recorded".
//   - A failed call uses recheckErrorMessage: a 400 here is not about the
//     coordinator's requirement codes, since none are sent.

import { useEffect, useRef, useState } from "react";
import { getEventVenueSuitability } from "../services/venueSuitabilityService";
import { recheckErrorMessage } from "../services/venueSuitabilityErrors";
import VenueSuitabilityResult from "./VenueSuitabilityResult";
import { labelFor } from "../services/venueSuitabilityDisplay";
import { ROOM_LAYOUTS } from "../services/venueLookups";

const RETIRED_MESSAGE = "It can no longer host this event, so request another venue.";
const ITEM_ERROR_MESSAGE = "This venue could not be rechecked. Press Recheck to try again.";
const ITEM_ERROR_MESSAGES = {
  STORED_REQUIREMENTS_INVALID:
    "The requirements saved with this request can no longer be read, so it could not be rechecked.",
  RECHECK_FAILED: "This venue could not be rechecked right now. Try Recheck.",
  // SCRUM-525 (R12): only this booking is affected, so only it says so.
  EVENT_ATTENDANCE_MISSING:
    "Neither this request nor the event has an expected attendance, so its capacity could not be checked.",
};

/** SCRUM-525 (R14): the attendance applied, marked when it is the event's. */
function attendanceText(item) {
  const n = item?.expectedAttendance;
  if (!Number.isInteger(n)) return "Not recorded";
  return item?.attendanceSource === "event" ? `${n} (event's)` : String(n);
}

/** SCRUM-525 (AC5): the booking's layout as its label, or that none was asked for. */
function layoutText(code) {
  return code ? labelFor(code, ROOM_LAYOUTS) : "None requested";
}

/** Fixed copy for an item's error, by its code (never the server's message). */
function itemErrorMessage(error) {
  const code = error?.code;
  return code && Object.hasOwn(ITEM_ERROR_MESSAGES, code) ? ITEM_ERROR_MESSAGES[code] : ITEM_ERROR_MESSAGE;
}

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
  const overridden = item?.suitabilityOverridden ? (item?.atRequest?.unmet ?? []) : [];
  const acceptedUnmet = namesText(overridden);

  let verdict = null;
  if (current) verdict = suitable ? "Suitable" : "Not suitable";

  return (
    <li className="event-venue-suitability__item">
      <h4>{name}</h4>
      <p className="event-venue-suitability__meta">
        {item?.venueLocation && <span>{item.venueLocation}</span>}
        {statusLabel && <span>Booking: {statusLabel}</span>}
        <span>{`Attendance: ${attendanceText(item)}`}</span>
        <span>{`Layout: ${layoutText(item?.roomLayoutCode)}`}</span>
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
          {itemErrorMessage(item.error)}
        </p>
      )}

      {current && !suitable && newlyUnmet && (
        <p className="event-venue-suitability__alert" role="alert">
          {/* SCRUM-525: the request's, since each is judged on its own attendance. */}
          This venue no longer meets this request&apos;s requirements: {newlyUnmet}
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
          <VenueSuitabilityResult result={current} overridden={overridden} />
        </details>
      )}
    </li>
  );
}

export default function EventVenueSuitability({ eventRequestId, onLoaded }) {
  // Starts as loading, so the effect never has to set state before its call.
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  // Bumped by "Recheck" and "Try again" to run the effect once more.
  const [attempt, setAttempt] = useState(0);
  // Read through a ref, so a parent passing a new function each render does
  // not rerun the recheck.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    getEventVenueSuitability(eventRequestId)
      .then((items) => {
        if (!cancelled) {
          const list = Array.isArray(items) ? items : [];
          setState({ status: "done", items: list, error: null });
          onLoadedRef.current?.(list);
        }
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", items: [], error: recheckErrorMessage(err) });
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
