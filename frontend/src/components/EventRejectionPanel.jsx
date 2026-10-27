// EventRejectionPanel.jsx
//
// SCRUM-347: the assigned coordinator rejects an Approved event whose essential
// arrangements cannot be met. The outstanding lines come from the confirmation
// readiness check (N07); the coordinator decides, nothing rejects on its own.

import { useEffect, useState } from "react";
import { getEventReadiness, rejectApprovedEvent } from "../services/eventRequestService";
import ReadinessChecklist from "./ReadinessChecklist";
import { SESSION_EXPIRED } from "../services/apiErrors";
import { formatTimestamp } from "../services/displayFormat";

const ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
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
          setReadError(ERROR_MESSAGES[requestError?.response?.status]
            ?? "The outstanding arrangements could not be loaded. Please try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequest.id, approved]);

  const back = onBack && (
    <button className="event-cancellation-page__back" type="button" onClick={onBack}>Back to event</button>
  );

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
            <dd>{formatTimestamp(eventRequest.decidedAt, "Not recorded")}</dd>
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
        {!readiness && !readError && <p role="status">Loading the outstanding arrangements...</p>}
        {readError && <p role="alert">{readError}</p>}
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
          <button type="submit" disabled={rejecting || !reason.trim()}>
            {rejecting ? "Rejecting..." : "Reject event"}
          </button>
        </form>
        {error && <p role="alert">{error.message}</p>}
        {error?.cancelInstead && onCancelInstead && (
          <button type="button" onClick={onCancelInstead}>Cancel event instead</button>
        )}
      </section>
    </main>
  );
}
