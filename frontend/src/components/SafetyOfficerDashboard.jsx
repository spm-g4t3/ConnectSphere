import { useCallback, useEffect, useState } from "react";
import {
  getSafetyReview,
  getSafetyReviewQueue,
  submitSafetyReviewResponse,
} from "../services/safetyReviewService";
import { formatRange, formatTimestamp } from "../services/displayFormat";

export const OUTCOME_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Safety arrangement rejected",
};

function waitingLabel(seconds) {
  const elapsed = Math.max(0, Number(seconds) || 0);
  if (elapsed < 60) return "Less than a minute";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} minute${Math.floor(elapsed / 60) === 1 ? "" : "s"}`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} hour${Math.floor(elapsed / 3600) === 1 ? "" : "s"}`;
  const days = Math.floor(elapsed / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function recorded(value) {
  return typeof value === "string" && value.trim() ? value : "Not recorded";
}

export function SafetyReviewDetail({ detail, onSubmitted, onError }) {
  const [outcome, setOutcome] = useState("approved");
  const [note, setNote] = useState("");
  const [affectedBookingIds, setAffectedBookingIds] = useState([]);
  const [equipmentAffected, setEquipmentAffected] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { event, venues, equipment, history } = detail;
  const canMarkArrangements = outcome !== "approved";
  const responseAllowed = event.status === "safety_review";

  function toggleBooking(bookingId) {
    setAffectedBookingIds((current) =>
      current.includes(bookingId)
        ? current.filter((id) => id !== bookingId)
        : [...current, bookingId],
    );
  }

  async function submit(eventObject) {
    eventObject.preventDefault();
    setSubmitting(true);
    onError(null);
    try {
      await submitSafetyReviewResponse(event.id, {
        outcome,
        note,
        affectedBookingIds: canMarkArrangements ? affectedBookingIds : [],
        equipmentAffected: canMarkArrangements && equipmentAffected,
      });
      await onSubmitted(event.id, outcome);
    } catch (error) {
      onError({
        status: error.response?.status,
        message:
          error.response?.data?.error ??
          "The safety review response could not be submitted. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="safety-review__detail" aria-label="Safety review details">
      <h2>{event.eventName}</h2>
      <dl className="safety-review__facts">
        <dt>Expected attendance</dt>
        <dd>{event.expectedAttendance ?? "Not recorded"}</dd>
        <dt>Event date and times</dt>
        <dd>{formatRange(event.startsAt, event.endsAt, "Not recorded")}</dd>
        <dt>Accessibility requirements</dt>
        <dd>{recorded(event.accessibilityRequirements)}</dd>
        <dt>Coordinator's note</dt>
        <dd>{recorded(event.coordinatorNote)}</dd>
      </dl>

      <h3>Booked venues</h3>
      {venues.length === 0 ? (
        <p>No booked venues are recorded.</p>
      ) : (
        <ul className="safety-review__arrangements">
          {venues.map((venue) => (
            <li key={venue.bookingId}>
              <strong>{venue.name}</strong>
              <dl className="safety-review__facts">
                <dt>Location</dt><dd>{recorded(venue.location)}</dd>
                <dt>Capacity</dt><dd>{venue.capacity ?? "Not recorded"}</dd>
                <dt>Layout</dt><dd>{recorded(venue.layout)}</dd>
                <dt>Emergency access</dt><dd>{recorded(venue.emergencyAccess)}</dd>
                <dt>Known restrictions</dt><dd>{recorded(venue.knownRestrictions)}</dd>
                <dt>Booked for</dt>
                <dd>{formatRange(venue.startsAt, venue.endsAt, "Not recorded")}</dd>
              </dl>
              {canMarkArrangements && responseAllowed && (
                <label className="safety-review__affected">
                  <input
                    type="checkbox"
                    checked={affectedBookingIds.includes(venue.bookingId)}
                    onChange={() => toggleBooking(venue.bookingId)}
                  />
                  Mark this booking as affected
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>Arranged equipment</h3>
      {!equipment ? (
        <p>No arranged equipment request is recorded.</p>
      ) : (
        <>
          <ul className="safety-review__arrangements">
            {equipment.lines.map((line) => (
              <li key={line.id}>
                <strong>{line.name}</strong>
                <dl className="safety-review__facts">
                  <dt>Quantity</dt><dd>{line.quantity}</dd>
                  <dt>Technical notes</dt><dd>{recorded(line.technicalNotes)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          {canMarkArrangements && responseAllowed && (
            <label className="safety-review__affected">
              <input
                type="checkbox"
                checked={equipmentAffected}
                onChange={(eventObject) => setEquipmentAffected(eventObject.target.checked)}
              />
              Mark the equipment request as affected
            </label>
          )}
        </>
      )}

      <h3>Safety review history</h3>
      {history.length === 0 ? (
        <p>No earlier safety responses.</p>
      ) : (
        <ol className="safety-review__history">
          {history.map((response) => (
            <li key={response.id}>
              <strong>{OUTCOME_LABELS[response.outcome] ?? response.outcome}</strong>
              <span>{response.safetyOfficerName ?? "Safety Officer"} · {formatTimestamp(response.createdAt)}</span>
              {response.note && <p>{response.note}</p>}
              <p>
                Affected bookings: {response.affectedBookingIds.length};
                equipment request affected: {response.equipmentAffected ? "yes" : "no"}.
              </p>
            </li>
          ))}
        </ol>
      )}

      {responseAllowed ? (
        <form className="safety-review__response" onSubmit={submit}>
          <h3>Record your response</h3>
          <label>
            Response
            <select value={outcome} onChange={(eventObject) => setOutcome(eventObject.target.value)}>
              <option value="approved">Approve</option>
              <option value="changes_requested">Request changes</option>
              <option value="rejected">Reject the safety arrangement</option>
            </select>
          </label>
          <label>
            {outcome === "rejected" ? "Reason" : "Note"}
            <textarea
              value={note}
              onChange={(eventObject) => setNote(eventObject.target.value)}
              required={outcome !== "approved"}
              rows={4}
            />
          </label>
          {outcome !== "approved" && (
            <p>Select each booking or the equipment request that the coordinator needs to change.</p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit response"}
          </button>
        </form>
      ) : (
        <p role="status">This event is now {event.status}; no further response can be submitted.</p>
      )}
    </section>
  );
}

export default function SafetyOfficerDashboard({ user }) {
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const refreshQueue = useCallback(async () => {
    setLoading(true);
    try {
      setQueue(await getSafetyReviewQueue());
      setError(null);
    } catch (requestError) {
      setError(requestError.response?.data?.error ?? "The safety review list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  async function openReview(id) {
    setSelectedId(id);
    setDetail(null);
    setMessage(null);
    setError(null);
    setDetailLoading(true);
    try {
      setDetail(await getSafetyReview(id));
    } catch (requestError) {
      setError(requestError.response?.data?.error ?? "The event's safety details could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function responseSubmitted(id, outcome) {
    setMessage(`Response recorded: ${OUTCOME_LABELS[outcome]}.`);
    setError(null);
    await refreshQueue();
    try {
      setDetail(await getSafetyReview(id));
    } catch {
      setError("The response was recorded, but the safety history could not be refreshed.");
    }
  }

  async function responseError(responseError) {
    if (!responseError) {
      setError(null);
      return;
    }
    setError(responseError.message);
    if (responseError.status === 409 && selectedId) {
      await refreshQueue();
      try {
        setDetail(await getSafetyReview(selectedId));
      } catch {
        setError(`${responseError.message} The latest safety history could not be loaded.`);
      }
    }
  }

  return (
    <div className="dashboard dashboard--safety-officer">
      <h1>Safety Officer</h1>
      <p>Signed in as {user.name ?? user.email}.</p>

      {selectedId ? (
        <section>
          <button
            className="safety-review__back"
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
              setError(null);
              setMessage(null);
            }}
          >
            &larr; Back to Safety review
          </button>
          {detailLoading && <p>Loading event arrangements...</p>}
          {message && <p className="safety-review__success" role="status">{message}</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {detail && (
            <SafetyReviewDetail
              detail={detail}
              onSubmitted={responseSubmitted}
              onError={responseError}
            />
          )}
        </section>
      ) : (
        <section>
          <h2>Safety review</h2>
          {loading && <p>Loading...</p>}
          {error && <p className="safety-review__error" role="alert">{error}</p>}
          {!loading && !error && queue.length === 0 && <p>No events are waiting for a safety review.</p>}
          <ul className="safety-review__queue">
            {queue.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.eventName}</strong>
                  <p>{formatRange(event.startsAt, event.endsAt, "Date and time not recorded")}</p>
                  <p>Venues: {event.venues.length ? event.venues.join(", ") : "Not recorded"}</p>
                  <p>Expected attendance: {event.expectedAttendance ?? "Not recorded"}</p>
                  <p>Coordinator: {event.coordinatorName ?? "Not recorded"}</p>
                  <p>Waiting: {waitingLabel(event.waitingSeconds)}</p>
                </div>
                <button type="button" onClick={() => openReview(event.id)}>Review event</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
