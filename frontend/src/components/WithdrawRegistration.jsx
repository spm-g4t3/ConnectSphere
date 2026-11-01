import { useRef, useState } from "react";
import { withdrawRegistration } from "../services/attendeeEventService";
import { withdrawalFailure } from "../services/withdrawalErrors";
import { REGISTRATION_STATUS } from "../services/registrationStatus";
import Button from "./ui/Button";

/**
 * Asks first, inline, as the other destructive actions here do (there is no
 * modal in this frontend). Nothing on screen changes until the backend has
 * withdrawn the registration; onWithdrawn then gets its reply.
 *
 * A final refusal goes to the page through onRefused and comes back as
 * `refusal`: a reload remounts this component, and must not bring the action back.
 */
export default function WithdrawRegistration({ registrationId, refusal, onWithdrawn, onRefused }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // A failure that may pass on a later try; it offers a retry.
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
      if (result?.status !== REGISTRATION_STATUS.WITHDRAWN) throw new Error("Unexpected withdrawal reply");
      onWithdrawn(result);
    } catch (err) {
      const outcome = withdrawalFailure(err);
      if (outcome.rejected) onRefused(outcome.message);
      else setFailure(outcome);
      setConfirming(false);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  if (refusal) {
    return (
      <section className="withdraw-registration" aria-label="Withdraw registration">
        <p className="withdraw-registration__error" role="alert">{refusal}</p>
      </section>
    );
  }

  return (
    <section className="withdraw-registration" aria-label="Withdraw registration">
      {failure && (
        <div className="browse-open-events__error" role="alert">
          <p>{failure.message}</p>
          <Button variant="secondary" disabled={submitting} onClick={handleConfirm}>
            {submitting ? "Withdrawing..." : "Try again"}
          </Button>
        </div>
      )}
      {confirming ? (
        <>
          <p>Withdraw your registration? Your place will be released to other attendees.</p>
          <div className="withdraw-registration__actions">
            <Button variant="danger" disabled={submitting} onClick={handleConfirm}>
              {submitting ? "Withdrawing..." : "Confirm withdrawal"}
            </Button>
            <Button variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>
              Keep my registration
            </Button>
          </div>
        </>
      ) : !failure && (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Withdraw registration
        </Button>
      )}
    </section>
  );
}
