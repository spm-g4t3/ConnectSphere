import { useRef, useState } from "react";
import { withdrawRegistration } from "../services/attendeeEventService";
import { withdrawalFailure } from "../services/withdrawalErrors";
import { REGISTRATION_STATUS } from "../services/registrationStatus";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import ErrorNotice from "./ui/ErrorNotice";

/**
 * Asks first, in a ConfirmDialog. Nothing on screen changes until the backend
 * has withdrawn the registration; onWithdrawn then gets its reply.
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
    } finally {
      setConfirming(false);
      sending.current = false;
      setSubmitting(false);
    }
  }

  if (refusal) {
    // Final, so there is nothing to try again.
    return (
      <section className="withdraw-registration" aria-label="Withdraw registration">
        <ErrorNotice message={refusal} />
      </section>
    );
  }

  return (
    <section className="withdraw-registration" aria-label="Withdraw registration">
      {failure && <ErrorNotice message={failure.message} onRetry={handleConfirm} />}
      {/* A retry sends from here, outside the dialog, so its progress shows here too. */}
      {submitting && !confirming && <p role="status">Withdrawing...</p>}
      {!failure && !submitting && (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Withdraw registration
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        title="Withdraw your registration?"
        confirmLabel={submitting ? "Withdrawing..." : "Confirm withdrawal"}
        cancelLabel="Keep my registration"
        danger
        busy={submitting}
        onConfirm={handleConfirm}
        onCancel={() => setConfirming(false)}
      >
        Your place will be released to other attendees.
      </ConfirmDialog>
    </section>
  );
}
