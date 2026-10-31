import { useEffect, useRef, useState } from "react";
import { submitSafetyReviewResponse } from "../services/safetyReviewService";
import { formatDateTime } from "../services/displayFormat";
import { EVENT_STATUS_BADGES, OUTCOME_LABELS, OUTCOME_TONES, eventRange } from "./safetyReviewLabels";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";

function recorded(value) {
  return typeof value === "string" && value.trim() ? value : "Not recorded";
}

export function SafetyReviewDetail({ detail, onSubmitted, onError, readOnly = false }) {
  const [outcome, setOutcome] = useState("approved");
  const [note, setNote] = useState("");
  const [affectedBookingIds, setAffectedBookingIds] = useState([]);
  const [equipmentAffected, setEquipmentAffected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const headingRef = useRef(null);

  const { event, venues, equipment, history } = detail;

  // Opening an event moves focus to its name so screen readers start there.
  // Keyed on the id: a refresh of the same event after a response keeps focus put.
  useEffect(() => {
    headingRef.current?.focus();
  }, [event.id]);
  const canMarkArrangements = outcome !== "approved";
  const responseAllowed = event.status === "safety_review";
  const closedStatus = EVENT_STATUS_BADGES[event.status];

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
      <h2 ref={headingRef} tabIndex={-1}>{event.eventName}</h2>
      <dl className="safety-review__facts">
        <dt>Expected attendance</dt>
        <dd>{event.expectedAttendance ?? "Not recorded"}</dd>
        <dt>Event date and times</dt>
        <dd>{eventRange(event.startsAt, event.endsAt, "Not recorded")}</dd>
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
              </dl>
              {!readOnly && canMarkArrangements && responseAllowed && (
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
          {!readOnly && canMarkArrangements && responseAllowed && (
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
              <StatusBadge tone={OUTCOME_TONES[response.outcome] ?? "neutral"}>
                {OUTCOME_LABELS[response.outcome] ?? response.outcome}
              </StatusBadge>
              <span>{response.safetyOfficerName ?? "Safety Officer"} · {formatDateTime(response.createdAt)}</span>
              {response.note && <p>{response.note}</p>}
              <p>
                Affected bookings: {response.affectedBookingIds.length};
                equipment request affected: {response.equipmentAffected ? "yes" : "no"}.
              </p>
            </li>
          ))}
        </ol>
      )}

      {!readOnly && (responseAllowed ? (
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
          <Button type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit response"}
          </Button>
        </form>
      ) : (
        <p role="status">
          This event is now{" "}
          <StatusBadge tone={closedStatus?.tone ?? "neutral"}>
            {closedStatus?.label ?? event.status}
          </StatusBadge>
          . No further response can be submitted.
        </p>
      ))}
    </section>
  );
}
