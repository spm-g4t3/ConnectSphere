import { useEffect, useId, useRef, useState } from "react";
import { submitSafetyReviewResponse } from "../services/safetyReviewService";
import { formatDateTime } from "../services/displayFormat";
import {
  EVENT_STATUS_BADGES,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  RESPONSE_CHOICES,
  eventRange,
} from "./safetyReviewLabels";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import StatusBadge from "./ui/StatusBadge";

function recorded(value) {
  return typeof value === "string" && value.trim() ? value : "Not recorded";
}

export function SafetyReviewDetail({
  detail,
  onSubmitted,
  onError,
  readOnly = false,
  focusRequest = 0,
}) {
  const [outcome, setOutcome] = useState("approved");
  const [note, setNote] = useState("");
  const [affectedBookingIds, setAffectedBookingIds] = useState([]);
  const [equipmentAffected, setEquipmentAffected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const headingRef = useRef(null);
  const submitButtonRef = useRef(null);
  const closedLineRef = useRef(null);
  const refocusSubmit = useRef(false);
  const choiceId = useId();

  const { event, venues, equipment, history } = detail;
  const canMarkArrangements = outcome !== "approved";
  const responseAllowed = event.status === "safety_review";
  const closedStatus = EVENT_STATUS_BADGES[event.status];
  const wasResponseAllowed = useRef(responseAllowed);

  // A recorded response replaces the form, so focus moves to the line that
  // says the event is closed rather than dropping to the page body.
  useEffect(() => {
    if (wasResponseAllowed.current && !responseAllowed) closedLineRef.current?.focus();
    wasResponseAllowed.current = responseAllowed;
  }, [responseAllowed]);

  // Opening an event moves focus to its name so screen readers start there.
  // A refresh of the same event keeps focus put unless the parent asks for it
  // (its Try again button has gone). Runs after the effect above, so it wins.
  useEffect(() => {
    headingRef.current?.focus();
  }, [event.id, focusRequest]);

  // The dialog, or the disabled state while sending, has gone by the time this
  // runs, so focus can land back on Submit response instead of the page body.
  useEffect(() => {
    if (confirmingReject || submitting || !refocusSubmit.current) return;
    refocusSubmit.current = false;
    submitButtonRef.current?.focus();
  }, [confirmingReject, submitting]);

  function toggleBooking(bookingId) {
    setAffectedBookingIds((current) =>
      current.includes(bookingId)
        ? current.filter((id) => id !== bookingId)
        : [...current, bookingId],
    );
  }

  async function sendResponse() {
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
      refocusSubmit.current = true;
    } finally {
      setSubmitting(false);
      setConfirmingReject(false);
    }
  }

  function submit(eventObject) {
    eventObject.preventDefault();
    // Rejecting stops the arrangement going ahead, so it is confirmed first.
    if (outcome === "rejected") {
      refocusSubmit.current = false;
      setConfirmingReject(true);
      return;
    }
    sendResponse();
  }

  function cancelReject() {
    refocusSubmit.current = true;
    setConfirmingReject(false);
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
          <fieldset className="safety-review__choices">
            <legend>Response</legend>
            {RESPONSE_CHOICES.map((choice) => {
              const nameId = `${choiceId}-${choice.value}-name`;
              const consequenceId = `${choiceId}-${choice.value}-consequence`;
              // The whole row is the click target; the name alone is the label
              // and the consequence is read as its description.
              return (
                <label key={choice.value} className="safety-review__choice">
                  <input
                    type="radio"
                    name={`${choiceId}-outcome`}
                    value={choice.value}
                    checked={outcome === choice.value}
                    onChange={() => setOutcome(choice.value)}
                    aria-labelledby={nameId}
                    aria-describedby={consequenceId}
                  />
                  <span className="safety-review__choice-text">
                    <span id={nameId} className="safety-review__choice-name">{choice.label}</span>
                    <span id={consequenceId} className="safety-review__choice-consequence">
                      {choice.consequence}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
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
          <Button ref={submitButtonRef} type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit response"}
          </Button>
          <ConfirmDialog
            open={confirmingReject}
            title={`Reject the safety arrangement for ${event.eventName}?`}
            confirmLabel="Reject arrangement"
            cancelLabel="Go back"
            danger
            busy={submitting}
            onConfirm={sendResponse}
            onCancel={cancelReject}
          >
            The organiser and coordinator are notified with your reason, and the event goes back to planning.
          </ConfirmDialog>
        </form>
      ) : (
        <p ref={closedLineRef} tabIndex={-1} role="status">
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
