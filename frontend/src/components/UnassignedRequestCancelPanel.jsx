// UnassignedRequestCancelPanel.jsx
//
// SCRUM-539 (SCRUM-579): the Event Coordinator Lead cancels one request from
// the unassigned queue, opened in place of the list as AssignCoordinatorPanel
// is. The coordinator's form, less the attendee message: a request nobody holds
// has no attendees to tell. The server's cancel_event_request (013) decides
// whether the Lead may cancel it, under the row lock.

import { useState } from "react";
import { cancelEventRequest, getEventCancellationImpact } from "../services/eventRequestService";
import { SESSION_EXPIRED, statusMessageOf } from "../services/apiErrors";
import { CancellationImpact } from "./EventCancellationPanel";

// Keyed by status for both calls, never by the server's text. 403 and 409 are
// the two ways the race with an assignment, or another Lead, is lost (AC5).
const ERROR_MESSAGES = {
  400: "Enter a cancellation reason and select who initiated it.",
  401: SESSION_EXPIRED,
  403: "A coordinator has been assigned to this request since you opened it, so only they can cancel it now. Go back to the queue to see where it stands.",
  404: "This event request no longer exists.",
  409: "This request is no longer waiting in the queue. It may already have been cancelled or assigned. Go back to the queue to see where it stands.",
};
const DEFAULT_ERROR = "The request could not be cancelled. No changes have been made; try again.";

/**
 * @param {object} props
 * @param {object} props.request       the queue row
 * @param {Function} props.onCancel    back to the queue, nothing done
 * @param {Function} props.onCancelled called with the cancelled request
 */
export default function UnassignedRequestCancelPanel({ request, onCancel, onCancelled }) {
  const [reason, setReason] = useState("");
  const [initiator, setInitiator] = useState("");
  const [impact, setImpact] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);

  // A preview is of the inputs it was asked with, so a change discards it.
  function invalidatePreview(update) {
    update();
    setImpact(null);
    setConfirmed(false);
    setError(null);
  }

  async function handlePreview(event) {
    event.preventDefault();
    if (!reason.trim() || !initiator) {
      setError("A non-blank reason and cancellation initiator are required.");
      return;
    }

    setLoadingImpact(true);
    setError(null);
    setConfirmed(false);
    try {
      setImpact(await getEventCancellationImpact(request.id));
    } catch (err) {
      setError(statusMessageOf(err, ERROR_MESSAGES, DEFAULT_ERROR));
    } finally {
      setLoadingImpact(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setError(null);
    try {
      const updated = await cancelEventRequest(request.id, { reason: reason.trim(), initiator });
      onCancelled?.(updated);
    } catch (err) {
      setError(statusMessageOf(err, ERROR_MESSAGES, DEFAULT_ERROR));
      setCancelling(false);
    }
  }

  return (
    <div className="assign-coordinator unassigned-cancel">
      <button className="unassigned-queue__back" type="button" onClick={onCancel}>
        &larr; Back to the unassigned queue
      </button>
      <h2>Cancel {request.eventName}</h2>
      <p>
        This request has no coordinator yet. The Organiser will be told it was
        cancelled, with your reason. Cancelling is final.
      </p>

      <form className="assign-coordinator__form" onSubmit={handlePreview}>
        <label>
          Cancellation reason
          <textarea
            value={reason}
            onChange={(event) => invalidatePreview(() => setReason(event.target.value))}
            required
            maxLength={4000}
            rows={3}
          />
        </label>
        <fieldset>
          <legend>Who initiated the cancellation?</legend>
          <label>
            <input
              type="radio"
              name={`unassigned-cancel-initiator-${request.id}`}
              value="organiser_request"
              checked={initiator === "organiser_request"}
              onChange={() => invalidatePreview(() => setInitiator("organiser_request"))}
              required
            />
            The organiser’s request
          </label>
          <label>
            <input
              type="radio"
              name={`unassigned-cancel-initiator-${request.id}`}
              value="connectsphere_decision"
              checked={initiator === "connectsphere_decision"}
              onChange={() => invalidatePreview(() => setInitiator("connectsphere_decision"))}
            />
            A ConnectSphere decision
          </label>
        </fieldset>
        <div className="assign-coordinator__actions">
          <button type="submit" disabled={loadingImpact || cancelling}>
            {loadingImpact ? "Loading impact..." : impact ? "Refresh impact preview" : "Preview cancellation"}
          </button>
        </div>
      </form>

      {/* A request sent back to the queue can still hold bookings and holds,
          so the Lead sees what will be released before confirming (D6). */}
      {impact && (
        <>
          <CancellationImpact impact={impact} />
          <div className="assign-coordinator__actions">
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I have reviewed the impact and confirm cancelling this request.
            </label>
            <button
              type="button"
              className="unassigned-queue__cancel"
              onClick={handleCancel}
              disabled={!confirmed || cancelling || loadingImpact}
            >
              {cancelling ? "Cancelling..." : "Cancel request"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="unassigned-queue__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
