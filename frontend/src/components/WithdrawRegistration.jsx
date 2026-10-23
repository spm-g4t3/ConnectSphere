import { useRef, useState } from "react";
import { withdrawRegistration } from "../services/attendeeEventService";
import { withdrawalErrorMessage } from "../services/withdrawalErrors";

/**
 * Asks first, inline, as the other destructive actions here do (there is no
 * modal in this frontend). Nothing on screen changes until the backend has
 * withdrawn the registration; onWithdrawn then gets its reply.
 */
export default function WithdrawRegistration({ registrationId, onWithdrawn }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // State updates are async, so a fast second click could pass a disabled check.
  const sending = useRef(false);

  async function handleConfirm() {
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await withdrawRegistration(registrationId);
      onWithdrawn(result);
    } catch (err) {
      setError(withdrawalErrorMessage(err));
      setConfirming(false);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="withdraw-registration" aria-label="Withdraw registration">
      {error && <p className="pending-bookings__error" role="alert">{error}</p>}
      {confirming ? (
        <>
          <p>Withdraw your registration? Your place will be released to other attendees.</p>
          <div className="event-venue-bookings__actions">
            <button type="button" disabled={submitting} onClick={handleConfirm}>
              {submitting ? "Withdrawing..." : "Confirm withdrawal"}
            </button>
            <button type="button" disabled={submitting} onClick={() => setConfirming(false)}>
              Keep my registration
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => { setError(null); setConfirming(true); }}>
          Withdraw registration
        </button>
      )}
    </section>
  );
}
