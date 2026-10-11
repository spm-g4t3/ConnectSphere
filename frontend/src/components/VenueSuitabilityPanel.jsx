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

import { useEffect, useState } from "react";
import { checkVenueSuitability } from "../services/venueSuitabilityService";
import { suitabilityErrorMessage } from "../services/venueSuitabilityErrors";
import VenueSuitabilityResult from "./VenueSuitabilityResult";

export default function VenueSuitabilityPanel({
  event,
  venue,
  requirements,
  canRequest,
  onRequest,
  onClose,
}) {
  // Starts as loading, so the effect never has to set state before its call.
  const [state, setState] = useState({ status: "loading", result: null, error: null });
  // Bumped by "Check again" to run the effect once more.
  const [attempt, setAttempt] = useState(0);

  const eventId = event?.id;
  const venueId = venue?.id;

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

  function checkAgain() {
    setState({ status: "loading", result: null, error: null });
    setAttempt((n) => n + 1);
  }

  return (
    <section className="venue-suitability-panel" aria-label={`Suitability of ${venue.name}`}>
      <h3>Suitability of {venue.name}</h3>

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

      {state.status === "done" && <VenueSuitabilityResult result={state.result} />}

      <div className="venue-suitability-panel__actions">
        {state.status === "done" && canRequest && (
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
