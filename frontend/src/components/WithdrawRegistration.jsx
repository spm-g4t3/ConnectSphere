import { useEffect, useRef, useState } from "react";
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
  const withdrawButtonRef = useRef(null);
  const failureRef = useRef(null);
  const refusalRef = useRef(null);
  const refocusWithdraw = useRef(false);
  const wasRefused = useRef(Boolean(refusal));

  // Cancelling closes the dialog, so focus goes back to the button that opened it.
  useEffect(() => {
    if (confirming || !refocusWithdraw.current) return;
    refocusWithdraw.current = false;
    withdrawButtonRef.current?.focus();
  }, [confirming]);

  // The button that had focus is replaced by the failure, so focus moves to it.
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  // Only a refusal that arrives here moves focus; one already shown after a
  // reload is part of the page as it loads.
  useEffect(() => {
    if (refusal && !wasRefused.current) refusalRef.current?.focus();
    wasRefused.current = Boolean(refusal);
  }, [refusal]);

  async function handleConfirm() {
    /* v8 ignore next -- @preserve ConfirmDialog disables Confirm while busy. */
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
        <div ref={refusalRef} tabIndex={-1}>
          <ErrorNotice message={refusal} />
        </div>
      </section>
    );
  }

  return (
    <section className="withdraw-registration" aria-label="Withdraw registration">
      {failure && (
        <div ref={failureRef} tabIndex={-1}>
          <ErrorNotice message={failure.message} onRetry={handleConfirm} />
        </div>
      )}
      {/* A retry sends from here, outside the dialog, so its progress shows here too. */}
      {submitting && !confirming && <p role="status">Withdrawing...</p>}
      {!failure && !submitting && (
        <Button ref={withdrawButtonRef} variant="danger" onClick={() => setConfirming(true)}>
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
        onCancel={() => {
          refocusWithdraw.current = true;
          setConfirming(false);
        }}
      >
        Your place will be released to other attendees.
      </ConfirmDialog>
    </section>
  );
}
