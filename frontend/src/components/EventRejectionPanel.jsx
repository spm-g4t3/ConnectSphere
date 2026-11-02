// EventRejectionPanel.jsx
//
// SCRUM-347: the assigned coordinator rejects an Approved event whose essential
// arrangements cannot be met. The outstanding lines come from the confirmation
// readiness check (N07); the coordinator decides, nothing rejects on its own.

import { useEffect, useState } from "react";
import { getEventReadiness, rejectApprovedEvent } from "../services/eventRequestService";
import ReadinessChecklist from "./ReadinessChecklist";
import { formatDateTime } from "../services/displayFormat";
// Generic despite its name: a 400, 403 or 404 answers the same if read again.
import { canRetryEquipmentRead } from "../services/equipmentErrors";
import Button from "./ui/Button";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";

const ERROR_MESSAGES = {
  403: "Only the coordinator assigned to this event can reject it.",
  404: "This event is no longer available.",
};

function rejectionErrorMessage(error) {
  const status = error?.response?.status;
  const serverMessage = error?.response?.data?.error;
  // 400 and 409 carry the database's own sentence, which names the current status.
  if ((status === 400 || status === 409) && typeof serverMessage === "string") return serverMessage;
  return ERROR_MESSAGES[status] ?? "The event could not be rejected. No changes have been made; try again.";
}

export default function EventRejectionPanel({ eventRequest, onRejected, onBack, onCancelInstead }) {
  const [readiness, setReadiness] = useState(null);
  const [readError, setReadError] = useState(null);
  // Bumped by Try again to read the outstanding arrangements again.
  const [readVersion, setReadVersion] = useState(0);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState(null);

  const approved = eventRequest.status === "approved";

  useEffect(() => {
    if (!approved) return undefined;
    let cancelled = false;
    getEventReadiness(eventRequest.id)
      .then((result) => {
        if (!cancelled) setReadiness(result);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setReadError({
            message: ERROR_MESSAGES[requestError?.response?.status]
              ?? "The outstanding arrangements could not be loaded.",
            retryable: canRetryEquipmentRead(requestError),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequest.id, approved, readVersion]);

  function readAgain() {
    setReadError(null);
    setReadVersion((version) => version + 1);
  }

  const back = onBack && <Button variant="link" onClick={onBack}>Back to event</Button>;

  if (eventRequest.status === "rejected") {
    return (
      <main className="event-cancellation-page">
        {back}
        <p className="eyebrow">Rejection recorded</p>
        <h1>{eventRequest.eventName}</h1>
        <section className="event-cancellation">
          <h2>Event rejected</h2>
          <dl>
            <dt>Reason</dt>
            <dd>{eventRequest.decisionNote || "No reason recorded."}</dd>
            <dt>Rejected on</dt>
            <dd>{formatDateTime(eventRequest.decidedAt, "Not recorded")}</dd>
          </dl>
          <p>Its venue bookings, holds and equipment have been released. The organiser can revise and resubmit it.</p>
        </section>
      </main>
    );
  }

  if (!approved) return null;

  const outstanding = (readiness?.items ?? []).filter((item) => !item.met);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!reason.trim() || rejecting) return;
    setRejecting(true);
    setError(null);
    try {
      const updated = await rejectApprovedEvent(eventRequest.id, { reason: reason.trim() });
      onRejected?.(updated);
    } catch (requestError) {
      setError({
        message: rejectionErrorMessage(requestError),
        cancelInstead: requestError?.response?.data?.code === "CANCEL_INSTEAD",
      });
    } finally {
      setRejecting(false);
    }
  }

  return (
    <main className="event-cancellation-page">
      {back}
      <p className="eyebrow">Coordinator action</p>
      <h1>Reject {eventRequest.eventName}</h1>
      <p className="event-cancellation-page__intro">
        Reject this event if its essential arrangements cannot be met. Its venue
        bookings, holds and equipment are released straight away, and the
        organiser can revise and resubmit it.
      </p>
      <section className="event-cancellation">
        {!readiness && !readError && <LoadingText />}
        {readError && (
          <ErrorNotice message={readError.message} onRetry={readError.retryable ? readAgain : undefined} />
        )}
        {readiness && (outstanding.length > 0
          ? <ReadinessChecklist caption="Still outstanding" items={outstanding} />
          : <p>Every essential arrangement is currently met.</p>)}
        <form onSubmit={handleSubmit}>
          <label>
            Reason for rejection
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              required
              maxLength={4000}
              rows={3}
            />
          </label>
          <Button type="submit" variant="danger" disabled={rejecting || !reason.trim()}>
            {rejecting ? "Rejecting..." : "Reject event"}
          </Button>
        </form>
        {error && <ErrorNotice message={error.message} />}
        {error?.cancelInstead && onCancelInstead && (
          <Button variant="secondary" onClick={onCancelInstead}>Cancel event instead</Button>
        )}
      </section>
    </main>
  );
}
