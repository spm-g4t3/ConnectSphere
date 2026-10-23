import { useRef, useState } from "react";
import { withdrawRegistration } from "../services/attendeeEventService";
import { withdrawalFailure } from "../services/withdrawalErrors";

/**
 * Asks first, inline, as the other destructive actions here do (there is no
 * modal in this frontend). Nothing on screen changes until the backend has
 * withdrawn the registration; onWithdrawn then gets its reply.
 */
export default function WithdrawRegistration({ registrationId, onWithdrawn }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // { message, rejected }: a rejection removes the action, other failures offer a retry.
  const [failure, setFailure] = useState(null);
  // State updates are async, so a fast second click could pass a disabled check.
  const sending = useRef(false);

  async function handleConfirm() {
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await withdrawRegistration(registrationId);
      // Success is the backend saying withdrawn, not merely a 2xx.
      if (result?.status !== "withdrawn") throw new Error("Unexpected withdrawal reply");
      onWithdrawn(result);
    } catch (err) {
      setFailure(withdrawalFailure(err));
      setConfirming(false);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  if (failure?.rejected) {
    return (
      <section className="withdraw-registration" aria-label="Withdraw registration">
        <p className="pending-bookings__error" role="alert">{failure.message}</p>
      </section>
    );
  }

  return (
    <section className="withdraw-registration" aria-label="Withdraw registration">
      {failure && (
        <div className="browse-open-events__error" role="alert">
          <p>{failure.message}</p>
          <button type="button" disabled={submitting} onClick={handleConfirm}>
            {submitting ? "Withdrawing..." : "Try again"}
          </button>
        </div>
      )}
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
      ) : !failure && (
        <button type="button" onClick={() => setConfirming(true)}>
          Withdraw registration
        </button>
      )}
    </section>
  );
}
