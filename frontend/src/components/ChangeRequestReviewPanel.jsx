// ChangeRequestReviewPanel.jsx
//
// SCRUM-402 (SCRUM-404, SCRUM-408): the Organiser's change requests on the
// coordinator's event screen, one card per submission. The event's holder
// reviews a group (preview_change_request, 036) and accepts or declines it as a
// whole; everyone else reads it. The server decides who may process what and
// in which status; the buttons here are a convenience, and every refusal is
// keyed on its status and code, never on the server's text.

import { useEffect, useState } from "react";
import {
  getCoordinatorChangeRequests,
  getEventCancellationImpact,
  previewCoordinatorChangeRequest,
  processCoordinatorChangeRequest,
} from "../services/eventRequestService";
import { SESSION_EXPIRED, codeOf, makeErrorMapper } from "../services/apiErrors";
import { formatTimestamp } from "../services/displayFormat";
import {
  changeClassLabel,
  changeFieldLabel,
  formatChangeValue,
  groupChangeRequests,
  outcomeLabel,
} from "../services/changeRequestDisplay";
import { CancellationImpact } from "./EventCancellationPanel";

// AC2: the statuses process_change_request (036) accepts a decision in.
const PROCESSABLE_STATUSES = new Set([
  "under_review", "pending_clarification", "approved", "safety_review", "safety_approved", "confirmed",
]);
const REVIEW_STATUSES = new Set(["under_review", "pending_clarification"]);
const NOTE_MAX_LENGTH = 2000;
const IMPACT_CHANGED = "SIGNIFICANT_CHANGE_IMPACT_CHANGED";
const NOT_REVIEWABLE = "This change request could not be reviewed. Please try again.";

/** The fields the review reads. Without them it would render an empty card. */
function isReviewable(preview) {
  return Array.isArray(preview?.rows) && preview.rows.length > 0
    && preview.rows.every((row) => typeof row?.id === "string" && typeof row.class === "string")
    && (preview.invalid === undefined || Array.isArray(preview.invalid));
}

const errorMessage = makeErrorMapper({
  codeMessages: {
    REVIEW_NOT_STARTED: "Start the review of this event before processing its change requests.",
    EVENT_STATUS_NOT_ALLOWED:
      "This event's status no longer allows its change requests to be processed. Go back to see where it stands.",
    CHANGE_REQUEST_ALREADY_PROCESSED: "This change request has already been processed. The list has been refreshed.",
    [IMPACT_CHANGED]:
      "The arrangements this change affects have changed since you reviewed it. The preview has been refreshed; check it and accept again.",
    EVENT_HOLDS_ARRANGEMENTS:
      "This request still holds bookings, holds or equipment from before it was reopened, so its date, time, attendance or requirements can't change yet. Release them, or decline the change request.",
  },
  statusMessages: {
    400: "This change request can't be applied as it stands. Review it again to see which values are refused, or decline it.",
    401: SESSION_EXPIRED,
    403: "You're no longer the coordinator for this event.",
  },
  notFoundMessages: { process: "This change request no longer exists.", preview: "This change request no longer exists." },
  defaultMessages: {
    process: "The change request could not be processed. Please try again.",
    preview: "The change request could not be reviewed. Please try again.",
  },
  unknownConflictMessage: "This event or change request has changed. Go back to see where it stands.",
});

// The impact's counts and lists, in SignificantEventChangePanel's style. Copied
// small rather than exported from there, which this story does not edit.
function ImpactStat({ label, value }) {
  return (
    <div className="event-significant-change__stat" role="group" aria-label={`${label}: ${value}`}>
      <strong aria-hidden="true">{value}</strong>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function SignificantImpact({ impact }) {
  const bookings = impact.venueBookings ?? [];
  const pending = impact.pendingBookingRequests ?? [];
  return (
    <div className="event-significant-change__impact" aria-label="Significant change impact preview">
      <h4>What the significant part will affect</h4>
      <div className="event-significant-change__stats">
        <ImpactStat label="Venue bookings to flag" value={bookings.length} />
        <ImpactStat label="Equipment reservations to flag" value={(impact.equipmentReservations ?? []).length} />
        <ImpactStat label="Registered attendees to notify" value={impact.registeredAttendeesToNotify ?? 0} />
      </div>
      {bookings.length + pending.length > 0 && (
        <ul className="change-request-review__impact-list">
          {bookings.map((item) => (
            <li key={item.id}>{item.venueName || "Venue"}: flagged for review</li>
          ))}
          {pending.map((item) => (
            <li key={item.id}>{item.venueName || "Venue"}: a pending request still for the old time</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row's field, its current value and what the Organiser asked for. */
function ChangeRow({ row, changeClass }) {
  const showsCurrent = !["other", "cancellation"].includes(row.changeField);
  return (
    <li className="change-request-review__row">
      <strong>{changeFieldLabel(row.changeField)}</strong>
      {changeClass && <span className="change-request-review__tag">{changeClassLabel(changeClass)}</span>}
      {showsCurrent ? (
        <p>
          <span className="change-request-review__current">{formatChangeValue(row.changeField, row.currentValue)}</span>
          {" → "}
          <span className="change-request-review__requested">{formatChangeValue(row.changeField, row.requestedChange ?? row.details)}</span>
        </p>
      ) : (
        <p>{row.requestedChange ?? row.details}</p>
      )}
    </li>
  );
}

/**
 * @param {object} props
 * @param {object} props.eventRequest   the event as the detail holds it now
 * @param {boolean} props.canProcess    the signed-in user holds the event
 * @param {() => void} [props.onProcessed]  re-read the event: fields and status may have changed
 * @param {(text: string) => void} [props.onEquipmentAccepted]  hand off to the equipment section
 */
export default function ChangeRequestReviewPanel({ eventRequest, canProcess, onProcessed, onEquipmentAccepted }) {
  const [listed, setListed] = useState(null);
  const [version, setVersion] = useState(0);
  const [review, setReview] = useState(null);
  const [mode, setMode] = useState(null);
  const [note, setNote] = useState("");
  const [cancelImpact, setCancelImpact] = useState(null);
  const [busy, setBusy] = useState(false);
  // { groupId, text }: shown in that group's card beside its buttons, since a
  // line at the top of the panel can sit off-screen (click-through step 23).
  const [message, setMessage] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getCoordinatorChangeRequests(eventRequest.id)
      .then((rows) => {
        if (!cancelled) setListed({ id: eventRequest.id, groups: groupChangeRequests(rows) });
      })
      .catch(() => {
        if (!cancelled) setListed({ id: eventRequest.id, error: "Could not load organiser change requests." });
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequest.id, version]);

  const processable = canProcess && PROCESSABLE_STATUSES.has(eventRequest.status);

  function closeReview() {
    setReview(null);
    setMode(null);
    setNote("");
    setCancelImpact(null);
  }

  async function loadPreview(group) {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      const preview = await previewCoordinatorChangeRequest(group.id);
      if (!isReviewable(preview)) {
        setMessage({ groupId: group.id, text: NOT_REVIEWABLE });
        return;
      }
      setReview({ group, preview });
      setMode(null);
      setNote("");
    } catch (err) {
      setMessage({ groupId: group.id, text: errorMessage(err, "preview") });
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision, decisionNotes) {
    const { group, preview } = review;
    setBusy(true);
    setMessage(null);
    try {
      await processCoordinatorChangeRequest(group.id, {
        decision,
        decisionNotes,
        ...(decision === "approved" && preview.impact && { expectedImpact: preview.impact }),
      });
      const equipment = group.rows.find((row) => row.changeField === "equipment");
      closeReview();
      const told = decision === "rejected"
        ? "Change request declined. The organiser has been told."
        : preview.rows.some((row) => row.class === "cancellation")
          ? "Change request accepted: the event has been cancelled. The organiser has been told."
          : "Change request accepted. The organiser has been told.";
      setNotice({ groupId: group.id, text: told });
      if (decision === "approved" && equipment) {
        if (REVIEW_STATUSES.has(eventRequest.status)) {
          setNotice({
            groupId: group.id,
            text: "Change request accepted. The equipment requirements now read as the organiser asked; the equipment lines can be edited once the event is approved.",
          });
        } else {
          onEquipmentAccepted?.(equipment.requestedChange ?? equipment.details);
        }
      }
      setVersion((v) => v + 1);
      onProcessed?.();
    } catch (err) {
      setMessage({ groupId: group.id, text: errorMessage(err, "process") });
      if (codeOf(err) === IMPACT_CHANGED) {
        // 395 refused: the arrangements moved since the preview. Re-read it, never retry blindly.
        try {
          const fresh = await previewCoordinatorChangeRequest(group.id);
          if (isReviewable(fresh)) {
            setReview({ group, preview: fresh });
          } else {
            closeReview();
            setMessage({ groupId: group.id, text: NOT_REVIEWABLE });
          }
        } catch (previewErr) {
          setMessage({ groupId: group.id, text: errorMessage(previewErr, "preview") });
        }
      }
      if (codeOf(err) === "CHANGE_REQUEST_ALREADY_PROCESSED") {
        closeReview();
        setVersion((v) => v + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openCancellation() {
    const groupId = review.group.id;
    setBusy(true);
    setMessage(null);
    try {
      const impact = await getEventCancellationImpact(eventRequest.id);
      // CancellationImpact reads its sections off an object; anything else would throw.
      if (impact === null || typeof impact !== "object") {
        setMessage({ groupId, text: "The cancellation's impact could not be loaded. Please try again." });
        return;
      }
      setCancelImpact(impact);
      setNote(review.preview.cancellationReason ?? "");
      setMode("cancel");
    } catch (err) {
      setMessage({ groupId, text: errorMessage(err, "preview") });
    } finally {
      setBusy(false);
    }
  }

  /** A card's own outcome and failure lines, beside its buttons. */
  function cardLines(groupId) {
    return (
      <>
        {notice?.groupId === groupId && <p className="change-request-review__notice" role="status">{notice.text}</p>}
        {message?.groupId === groupId && <p className="coordinator-clarification__error" role="alert">{message.text}</p>}
      </>
    );
  }

  function renderReview() {
    const { preview } = review;
    const { rows } = preview;
    const classOf = Object.fromEntries(rows.map((row) => [row.id, row.class]));
    const invalid = preview.invalid ?? [];
    const isCancellation = rows.some((row) => row.class === "cancellation");
    // Only a request that is all "Something else" needs a note: it changes nothing else.
    const isOther = rows.length > 0 && rows.every((row) => row.class === "other");
    const trimmed = note.trim();
    const tooLong = Array.from(trimmed).length > NOTE_MAX_LENGTH;

    return (
      <div className="change-request-review__preview" aria-label="Change request review">
        <ul className="change-request-review__rows">
          {review.group.rows.map((row) => <ChangeRow key={row.id} row={row} changeClass={classOf[row.id]} />)}
        </ul>
        {invalid.length > 0 && (
          <div className="change-request-review__invalid" role="alert">
            <p>These values can't be applied, so this request can't be accepted. You can decline it with a reason instead.</p>
            <ul>
              {invalid.map((fault, i) => <li key={i}>{fault.field}: {fault.message}</li>)}
            </ul>
          </div>
        )}
        {preview.revertsEvent && (
          <p className="event-significant-change__notice">Accepting returns this event to Approved.</p>
        )}
        {preview.impact && <SignificantImpact impact={preview.impact} />}

        {mode === "cancel" ? (
          <div className="change-request-review__cancel">
            <CancellationImpact impact={cancelImpact} />
            <label>
              Cancellation reason
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button type="button" disabled={busy || !trimmed || tooLong} onClick={() => decide("approved", trimmed)}>
              {busy ? "Cancelling..." : "Confirm cancellation"}
            </button>
          </div>
        ) : mode === "decline" ? (
          <div className="change-request-review__decline">
            <label>
              Reason for declining
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {tooLong && <p className="coordinator-clarification__error">The reason must be 2,000 characters or fewer.</p>}
            <button type="button" disabled={busy || !trimmed || tooLong} onClick={() => decide("rejected", trimmed)}>
              {busy ? "Declining..." : "Confirm decline"}
            </button>
          </div>
        ) : (
          <div className="change-request-review__accept">
            {!isCancellation && (
              <label>
                {isOther ? "Note to the organiser (required)" : "Note to the organiser (optional)"}
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            )}
            {tooLong && <p className="coordinator-clarification__error">The note must be 2,000 characters or fewer.</p>}
            <button
              type="button"
              disabled={busy || invalid.length > 0 || tooLong || (isOther && !trimmed)}
              onClick={() => (isCancellation ? openCancellation() : decide("approved", trimmed || undefined))}
            >
              {busy ? "Saving..." : "Accept"}
            </button>
            <button type="button" disabled={busy} onClick={() => { setMode("decline"); setNote(""); }}>
              Decline
            </button>
          </div>
        )}
        {cardLines(review.group.id)}
        <button type="button" className="change-request-review__close" onClick={closeReview}>
          Close review
        </button>
      </div>
    );
  }

  return (
    <section className="change-request-review" aria-label="Organiser change requests">
      <h3>Organiser change requests</h3>
      {listed?.id !== eventRequest.id && <p>Loading change requests...</p>}
      {listed?.id === eventRequest.id && listed.error && (
        <p className="coordinator-clarification__error" role="alert">{listed.error}</p>
      )}
      {listed?.id === eventRequest.id && listed.groups?.length === 0 && (
        <p>No change requests have been submitted for this event.</p>
      )}
      {canProcess && eventRequest.status === "submitted" && listed?.groups?.some((g) => g.open) && (
        <p className="change-request-review__hint">Start the review to process change requests.</p>
      )}
      {listed?.id === eventRequest.id && listed.groups?.length > 0 && (
        <ul className="coordinator-change-requests">
          {listed.groups.map((group) => (
            <li key={group.id} className="change-request-review__group">
              {review?.group.id === group.id ? renderReview() : (
                <ul className="change-request-review__rows">
                  {group.rows.map((row) => <ChangeRow key={row.id} row={row} />)}
                </ul>
              )}
              {group.organiserNote && (
                <p className="change-request-review__note"><strong>Organiser's note:</strong> {group.organiserNote}</p>
              )}
              <small>Submitted {formatTimestamp(group.createdAt, "Not recorded")}</small>
              {!group.open && (
                <p className="coordinator-change-requests__outcome">
                  {outcomeLabel(group.decision)}
                  {group.decisionNotes && <span> | {group.decisionNotes}</span>}
                  {group.processedAt && <span> | {formatTimestamp(group.processedAt, "Not recorded")}</span>}
                </p>
              )}
              {review?.group.id !== group.id && cardLines(group.id)}
              {group.open && processable && review?.group.id !== group.id && (
                <div className="coordinator-change-requests__actions">
                  <button type="button" disabled={busy} onClick={() => loadPreview(group)}>Review</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
