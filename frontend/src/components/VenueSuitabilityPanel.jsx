// VenueSuitabilityPanel.jsx
//
// SCRUM-191 (SCRUM-188 AC1/AC2). "Check suitability" for one venue, opened in
// place inside the coordinator's event view by EventVenueFinder, the same way
// BookingRequestPanel opens. It runs SCRUM-190's check on mount and shows the
// answer with VenueSuitabilityResult.
//
// Rules worth keeping:
//
//   - `requirements` is the snapshot the finder took when the check was
//     pressed, not the live form. The finder remounts this panel (a new key)
//     for each check, so what is shown always matches what was sent, and an
//     edit to the form afterwards never silently changes the answer.
//   - A venue that is not suitable is an answer, not an error: it shows as a
//     result. Only a failed call shows role="alert", with "Check again".
//   - "Request this venue" hands the result to the parent (onRequest), which
//     opens BookingRequestPanel with it, so the unsuitable warning and its
//     confirmation are there up front rather than after a refused send. It is
//     shown only when the parent says a request can be made (canRequest);
//     the server checks everything again on submit regardless.
//   - It renders as its own <section>, beside the search form and never in
//     it, the same rule as BookingRequestPanel. data.error is never shown;
//     see venueSuitabilityErrors.js.
//
// SCRUM-188 review fixes:
//   - A venue whose Availability is not met is not offered for a request at
//     all: its period is taken, so the server would refuse it whatever the
//     coordinator confirmed. The panel says so instead (AC4/AC7).
//   - A note says the check uses the event's saved date, time and attendance,
//     not the search form's, since the form beside it can say otherwise (AC3).
//     SCRUM-525 (AC2/AC3): attendance is per request now, so the note adds
//     that the request form can change it for this venue and checks again.
//
// SCRUM-525 (AC1, R13): `requestBlockedReason` is the finder's sentence for a
// venue this event already has a live request for. It shows in place of
// "Request this venue", so a locked venue is never offered here either.
//   - On opening, focus moves to the heading and the panel scrolls into view,
//     and the live status names the venue, so a keyboard or screen reader
//     user knows the check opened and what it answered (AC1).

import { useEffect, useRef, useState } from "react";
import { checkVenueSuitability } from "../services/venueSuitabilityService";
import { suitabilityErrorMessage } from "../services/venueSuitabilityErrors";
import VenueSuitabilityResult from "./VenueSuitabilityResult";

const UNAVAILABLE_MESSAGE =
  "This venue is not available for this event's period, so it can't be requested.";

/** Is the Availability criterion reported as not met? */
function availabilityUnmet(result) {
  const criteria = Array.isArray(result?.criteria) ? result.criteria : [];
  return criteria.some((c) => c?.criterion === "Availability" && c?.met === false);
}

export default function VenueSuitabilityPanel({
  event,
  venue,
  requirements,
  canRequest,
  requestBlockedReason,
  onRequest,
  onClose,
}) {
  // Starts as loading, so the effect never has to set state before its call.
  const [state, setState] = useState({ status: "loading", result: null, error: null });
  // Bumped by "Check again" to run the effect once more.
  const [attempt, setAttempt] = useState(0);

  const headingRef = useRef(null);

  const eventId = event?.id;
  const venueId = venue?.id;

  // Each check mounts a fresh panel (see the header), so this runs once per
  // check. scrollIntoView is guarded: jsdom does not implement it.
  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus();
    if (typeof heading.scrollIntoView === "function") {
      heading.scrollIntoView({ block: "nearest" });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    checkVenueSuitability(eventId, venueId, requirements)
      .then((result) => {
        if (!cancelled) setState({ status: "done", result, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", result: null, error: suitabilityErrorMessage(err) });
      });
    // A check answered after the panel closed or rechecked is dropped.
    return () => {
      cancelled = true;
    };
  }, [eventId, venueId, requirements, attempt]);

  const unavailable = state.status === "done" && availabilityUnmet(state.result);

  function checkAgain() {
    setState({ status: "loading", result: null, error: null });
    setAttempt((n) => n + 1);
  }

  return (
    <section className="venue-suitability-panel" aria-label={`Suitability of ${venue.name}`}>
      <h3 ref={headingRef} tabIndex={-1}>
        Suitability of {venue.name}
      </h3>
      <p className="venue-suitability-panel__note">
        Checked against this event&apos;s saved date, time and expected attendance, not the search
        form&apos;s. The layout, accessibility features and facilities are the ones chosen in the
        search form. You can change the expected attendance for this venue on the request form, and
        the venue is checked again for that number.
      </p>

      {state.status === "loading" && (
        <p className="venue-suitability-panel__loading" role="status">
          Checking {venue.name} against this event...
        </p>
      )}

      {state.status === "error" && (
        <p className="venue-suitability-panel__error" role="alert">
          {state.error}
        </p>
      )}

      {state.status === "done" && <VenueSuitabilityResult result={state.result} subject={venue.name} />}

      {state.status === "done" && canRequest && unavailable && (
        <p className="venue-suitability-panel__unavailable">{UNAVAILABLE_MESSAGE}</p>
      )}

      {requestBlockedReason && <p className="venue-suitability-panel__blocked">{requestBlockedReason}</p>}

      <div className="venue-suitability-panel__actions">
        {state.status === "done" && canRequest && !unavailable && (
          <button type="button" onClick={() => onRequest?.(venue, state.result)}>
            Request this venue
          </button>
        )}
        {state.status === "error" && (
          <button type="button" onClick={checkAgain}>
            Check again
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </section>
  );
}
