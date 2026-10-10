import { useState } from "react";
import {
  cancelEventRequest,
  getEventCancellationImpact,
} from "../services/eventRequestService";

const CANCELLABLE_STATUSES = new Set([
  "submitted",
  "under_review",
  "pending_clarification",
  "approved",
  "confirmed",
]);

const CANCEL_ERROR_MESSAGES = {
  400: "Enter a cancellation reason and select who initiated it.",
  403: "Only the coordinator assigned to this event can cancel it.",
  404: "This event request no longer exists.",
  409: "This event has changed and can no longer be cancelled in its current status. Reopen it to see where it stands.",
};

function cancellationPreviewErrorMessage(error) {
  const status = error.response?.status;
  const serverMessage = error.response?.data?.error;

  if (status === 401) {
    return "Your session has expired. Sign in again to preview the cancellation.";
  }
  if (status === 403) {
    return serverMessage || "Only the coordinator currently assigned to this event can preview its cancellation.";
  }
  if (status === 404) {
    return serverMessage || "This event request or its cancellation preview is not available.";
  }
  if (status >= 500) {
    return `The server could not load the cancellation preview (${status}). Check the backend error log for details.${serverMessage ? ` Server response: ${serverMessage}` : ""}`;
  }
  if (status) {
    return serverMessage || `The cancellation preview request failed (${status}). Check the reason and try again.`;
  }
  return "The cancellation preview request could not reach the server. Check your connection and try again.";
}

function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function ImpactSection({ title, impact }) {
  const details = impact?.details ?? [];
  return (
    <section>
      <h4>{title}: {impact?.count ?? 0}</h4>
      {details.length > 0 && (
        <ul>
          {details.map((item) => (
            <li key={item.id}>
              {item.venueName || item.equipmentName || item.status || "Item"}
              {item.venueLocation ? ` — ${item.venueLocation}` : ""}
              {item.quantity !== undefined ? ` (quantity ${item.quantity})` : ""}
              {item.startsAt && `, ${formatTimestamp(item.startsAt)}`}
              {item.endsAt && `–${formatTimestamp(item.endsAt)}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CancellationImpact({ impact }) {
  return (
    <div className="event-cancellation__impact" aria-label="Cancellation impact preview">
      <h3>What cancellation will affect</h3>
      <ImpactSection title="Venue bookings to cancel" impact={impact.venueBookings} />
      <ImpactSection title="Pending venue booking requests to withdraw" impact={impact.bookingRequests} />
      <ImpactSection title="Equipment requests to cancel" impact={impact.equipmentRequests} />
      <ImpactSection title="Active equipment reservations to release" impact={impact.equipmentReservations} />
      <p>
        This preview includes arrangements currently recorded in ConnectSphere.
        Registrations, separate tentative holds and on-site assignments are not
        yet available in this system.
      </p>
    </div>
  );
}

export default function EventCancellationPanel({
  eventRequest,
  onCancelled,
  onBack,
}) {
  const [reason, setReason] = useState("");
  const [initiator, setInitiator] = useState("");
  const [attendeeMessage, setAttendeeMessage] = useState("");
  const [impact, setImpact] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);

  if (eventRequest.status === "cancelled") {
    return (
      <main className="event-cancellation-page">
        {onBack && <button className="event-cancellation-page__back" type="button" onClick={onBack}>Back to event</button>}
        <p className="eyebrow">Cancellation recorded</p>
        <h1>{eventRequest.eventName}</h1>
        <section className="event-cancellation">
          <h2>Event cancelled</h2>
          <dl>
            <dt>Reason</dt>
            <dd>{eventRequest.cancellationReason || "No reason recorded."}</dd>
            <dt>Cancelled on</dt>
            <dd>{formatTimestamp(eventRequest.cancelledAt)}</dd>
          </dl>
        </section>
      </main>
    );
  }

  if (!CANCELLABLE_STATUSES.has(eventRequest.status)) return null;

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
      const preview = await getEventCancellationImpact(eventRequest.id);
      setImpact(preview);
    } catch (requestError) {
      setError(
        `${cancellationPreviewErrorMessage(requestError)} No changes have been made.`,
      );
    } finally {
      setLoadingImpact(false);
    }
  }

  async function handleCancel() {
    if (!impact || !confirmed) return;
    setCancelling(true);
    setError(null);
    try {
      const updated = await cancelEventRequest(eventRequest.id, {
        reason: reason.trim(),
        initiator,
        attendeeMessage: attendeeMessage.trim() || undefined,
      });
      onCancelled?.(updated);
    } catch (requestError) {
      setError(
        CANCEL_ERROR_MESSAGES[requestError.response?.status] ||
          "The event could not be cancelled. No changes have been made; try again.",
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <main className="event-cancellation-page">
      {onBack && <button className="event-cancellation-page__back" type="button" onClick={onBack}>Back to event</button>}
      <p className="eyebrow">Coordinator action</p>
      <h1>Cancel {eventRequest.eventName}</h1>
      <p className="event-cancellation-page__intro">
        Review the arrangements this will affect before confirming. Cancellation is final.
      </p>
      <section className="event-cancellation">
        <form onSubmit={handlePreview}>
          <label>
            Internal cancellation reason
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
                name={`cancellation-initiator-${eventRequest.id}`}
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
                name={`cancellation-initiator-${eventRequest.id}`}
                value="connectsphere_decision"
                checked={initiator === "connectsphere_decision"}
                onChange={() => invalidatePreview(() => setInitiator("connectsphere_decision"))}
              />
              A ConnectSphere decision
            </label>
          </fieldset>
          <label>
            Optional message to attendees
            <textarea
              value={attendeeMessage}
              onChange={(event) => invalidatePreview(() => setAttendeeMessage(event.target.value))}
              maxLength={4000}
              rows={3}
            />
          </label>
          <button type="submit" disabled={loadingImpact || cancelling}>
            {loadingImpact ? "Loading impact..." : impact ? "Refresh impact preview" : "Preview cancellation"}
          </button>
        </form>

        {impact && (
          <>
            <CancellationImpact impact={impact} />
            <div className="event-cancellation__confirmation">
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I have reviewed the impact and explicitly confirm cancelling this event.
              </label>
              <button
                type="button"
                onClick={handleCancel}
                disabled={!confirmed || cancelling || loadingImpact}
              >
                {cancelling ? "Cancelling..." : "Confirm event cancellation"}
              </button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
