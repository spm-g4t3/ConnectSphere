// EquipmentReview.jsx
//
// SCRUM-296, for SCRUM-290 (Review an Equipment Request - Technical Support
// Staff). Route /equipment-review/:eventId, technical support staff only.
//
// Shows one event's equipment request the way a reviewer needs it: the event,
// who holds the review, and each line with what was asked for, how much is
// reserved, whether the stock is there (SCRUM-23's result, unchanged) and, for
// the reviewer, the "Cannot be provided" action with its note.
//
// What the screen decides and what the server decides. Every button here is a
// convenience: the screen hides what the current user cannot do so nobody is
// offered a button that can only be refused. The gate is the database function
// behind each route (038), which checks the reviewer and the status under the
// event's row lock. When the server refuses anyway because this copy was
// stale, a sentence says so and the state is read again.
//
// Reserving a line is SCRUM-300. Its button is shown disabled so the layout is
// final, and says why.
//
// Every call answers with the whole review state and that replaces what is on
// screen. Nothing is spliced by hand.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  clearEquipmentLineOutcome,
  completeEquipmentReview,
  getEquipmentReview,
  markEquipmentLineUnavailable,
  startEquipmentReview,
  takeOverEquipmentReview,
} from "../services/equipmentReviewService";
import { isStaleRefusal, reviewErrorMessage } from "../services/equipmentReviewErrors";
import { formatRange, formatTimestamp } from "../services/displayFormat";
import "./EquipmentReview.css";

/** The backend's limit on an outcome note (equipmentReviewValidation.js). */
const MAX_NOTE_LENGTH = 1000;

const RESULT_CLASS = {
  "Fully available": "fully",
  "Partially available": "partially",
  Unavailable: "unavailable",
};

const STATUS_CLASS = {
  pending_review: "pending",
  under_review: "under",
  arranged: "arranged",
  cannot_be_fully_arranged: "cannot",
  cancelled: "cancelled",
};

function availabilitySummary(result) {
  if (result.message) return result.message;
  if (result.result === "Fully available") {
    return `${result.quantityRequested} requested, ${result.quantityAvailable} available.`;
  }
  if (result.result === "Partially available") {
    return `Only ${result.quantityAvailable} of ${result.quantityRequested} requested are available.`;
  }
  return `None of the ${result.quantityRequested} requested are available.`;
}

function Availability({ availability }) {
  if (!availability) return <p className="equipment-review__muted">Availability is not shown for this line.</p>;
  const { breakdown, reservations } = availability;

  return (
    <div
      className={`equipment-review__availability equipment-review__availability--${
        RESULT_CLASS[availability.result] ?? "unavailable"
      }`}
    >
      <strong>{availability.result}</strong>
      <span>{availabilitySummary(availability)}</span>
      {breakdown && (
        <p className="equipment-review__muted">
          {`${breakdown.total} in stock, ${breakdown.damagedOrUnderMaintenance} damaged or under maintenance, ${breakdown.reserved} reserved for this period.`}
        </p>
      )}
      {reservations.length > 0 && (
        <details>
          <summary>{`Overlapping reservations (${reservations.length})`}</summary>
          <ul>
            {reservations.map((reservation) => (
              <li key={reservation.id}>
                {`${reservation.eventName ?? "Another event"}: ${reservation.quantity}, ${formatRange(
                  reservation.startAt,
                  reservation.endAt,
                )}`}
                {reservation.flagged ? " (flagged for review)" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function EquipmentReview() {
  const { eventId } = useParams();
  const { user } = useAuth();

  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [markingId, setMarkingId] = useState(null);
  const [markNote, setMarkNote] = useState("");
  const [markError, setMarkError] = useState(null);
  const [confirmingComplete, setConfirmingComplete] = useState(false);

  const load = useCallback(async () => {
    try {
      setReview(await getEquipmentReview(eventId));
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err?.response?.status === 404 || err?.response?.status === 400
          ? "That event could not be found."
          : "Could not load this equipment request.",
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const request = review?.request ?? null;
  const event = review?.event ?? null;
  const lines = request?.lines ?? [];
  const status = request?.status;
  const isReviewer = Boolean(user?.id) && request?.reviewerId === user.id;
  const reviewing = status === "under_review" && isReviewer;

  /** Run one write: replace the state on success, say why on failure. */
  async function run(action, { onError, success } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setReview(await action());
      if (success) setNotice(success);
      return true;
    } catch (err) {
      (onError ?? setError)(reviewErrorMessage(err));
      if (isStaleRefusal(err)) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  function resetEditors() {
    setMarkingId(null);
    setMarkNote("");
    setMarkError(null);
    setConfirmingComplete(false);
  }

  async function handleStart() {
    resetEditors();
    await run(() => startEquipmentReview(eventId), { success: "You are now reviewing this request." });
  }

  async function handleTakeOver() {
    resetEditors();
    await run(() => takeOverEquipmentReview(eventId), { success: "You have taken over this review." });
  }

  function openMark(line) {
    setNotice(null);
    setError(null);
    setConfirmingComplete(false);
    setMarkingId(line.id);
    setMarkNote(line.outcomeNote ?? "");
    setMarkError(null);
  }

  async function handleMark(submitEvent, line) {
    submitEvent.preventDefault();
    const note = markNote.trim();
    if (note === "") {
      setMarkError("Add a note explaining why this cannot be provided.");
      return;
    }
    setMarkError(null);
    const ok = await run(() => markEquipmentLineUnavailable(eventId, line.id, note), {
      onError: setMarkError,
      success: `${line.name} marked as cannot be provided.`,
    });
    if (ok) resetEditors();
  }

  async function handleClear(line) {
    await run(() => clearEquipmentLineOutcome(eventId, line.id), { success: `The mark on ${line.name} was removed.` });
  }

  async function handleComplete() {
    const ok = await run(() => completeEquipmentReview(eventId), { success: "Review completed." });
    if (ok) resetEditors();
  }

  if (loading) {
    return (
      <div className="dashboard dashboard--tech-support equipment-review">
        <h1>Equipment request review</h1>
        <p>Loading equipment request...</p>
      </div>
    );
  }

  if (loadError || !request) {
    return (
      <div className="dashboard dashboard--tech-support equipment-review">
        <h1>Equipment request review</h1>
        <p role="alert">{loadError ?? "This event has no equipment request to review."}</p>
        {loadError && (
          <button type="button" onClick={load}>
            Try again
          </button>
        )}
      </div>
    );
  }

  const canStart = status === "pending_review" || status === "cannot_be_fully_arranged";
  const canTakeOver = status === "under_review" && !isReviewer;
  const shortLines = lines.filter((line) => line.shortBy > 0);

  return (
    <div className="dashboard dashboard--tech-support equipment-review">
      <h1>Equipment request review</h1>

      <section className="equipment-review__event">
        <h2>{event?.name ?? "Event"}</h2>
        <p>{formatRange(event?.proposedStart, event?.proposedEnd, "Not set")}</p>
        <p>{event?.venue ? `Venue: ${event.venue.name}` : "No venue booked."}</p>
        <p>
          {event?.assignedCoordinatorName
            ? `Coordinator: ${event.assignedCoordinatorName}`
            : "No coordinator assigned."}
        </p>
        <p className="equipment-review__status-row">
          <span className={`equipment-review__status equipment-review__status--${STATUS_CLASS[status] ?? "pending"}`}>
            {request.statusLabel}
          </span>
          {status === "under_review" && (
            <span>
              {isReviewer
                ? `You are reviewing this request (since ${formatTimestamp(request.reviewStartedAt)}).`
                : `Being reviewed by ${request.reviewerName ?? "another staff member"} since ${formatTimestamp(
                    request.reviewStartedAt,
                  )}.`}
            </span>
          )}
        </p>

        <div className="equipment-review__actions">
          {canStart && (
            <button type="button" disabled={busy} onClick={handleStart}>
              {status === "cannot_be_fully_arranged" ? "Review again" : "Start review"}
            </button>
          )}
          {canTakeOver && (
            <button type="button" disabled={busy} onClick={handleTakeOver}>
              Take over review
            </button>
          )}
          <button type="button" disabled={busy} onClick={load}>
            Refresh
          </button>
        </div>
        {status === "pending_review" && (
          <p className="equipment-review__muted">Start the review to reserve equipment or mark lines.</p>
        )}
      </section>

      {error && (
        <p className="equipment-review__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="equipment-review__notice" role="status">
          {notice}
        </p>
      )}

      <section className="equipment-review__lines">
        <h2>{`Lines (${lines.length})`}</h2>
        <ul>
          {lines.map((line) => {
            const marked = line.outcome === "cannot_be_provided";
            return (
              <li key={line.id} className="equipment-review__line">
                <div className="equipment-review__line-head">
                  <strong>{line.name}</strong>
                  <span>{`Requested: ${line.quantity}`}</span>
                  <span>{`Reserved: ${line.reserved} of ${line.quantity}`}</span>
                  {line.typeRetired && <small>This equipment type has been retired.</small>}
                </div>
                <p className="equipment-review__notes">{line.technicalNotes ?? "No technical notes."}</p>

                <Availability availability={line.availability} />

                {marked && (
                  <div className="equipment-review__outcome">
                    <strong>Cannot be provided</strong>
                    <p>{line.outcomeNote}</p>
                  </div>
                )}

                {reviewing && line.shortBy > 0 && markingId !== line.id && (
                  <div className="equipment-review__actions">
                    <button type="button" disabled title="Reserving equipment is not available yet (SCRUM-300)">
                      Reserve
                    </button>
                    <button
                      type="button"
                      aria-label={`${marked ? "Edit note for" : "Mark as cannot be provided:"} ${line.name}`}
                      disabled={busy}
                      onClick={() => openMark(line)}
                    >
                      {marked ? "Edit note" : "Cannot be provided"}
                    </button>
                    {marked && (
                      <button
                        type="button"
                        aria-label={`Remove mark on ${line.name}`}
                        disabled={busy}
                        onClick={() => handleClear(line)}
                      >
                        Remove mark
                      </button>
                    )}
                  </div>
                )}

                {reviewing && markingId === line.id && (
                  <form className="equipment-review__form" noValidate onSubmit={(e) => handleMark(e, line)}>
                    <label>
                      {`Why can ${line.name} not be provided?`}
                      <textarea
                        value={markNote}
                        maxLength={MAX_NOTE_LENGTH}
                        disabled={busy}
                        onChange={(e) => setMarkNote(e.target.value)}
                      />
                    </label>
                    {markError && (
                      <p className="equipment-review__error" role="alert">
                        {markError}
                      </p>
                    )}
                    <div className="equipment-review__actions">
                      <button type="submit" disabled={busy}>
                        {busy ? "Saving..." : "Save note"}
                      </button>
                      <button type="button" disabled={busy} onClick={resetEditors}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {reviewing && (
        <section className="equipment-review__complete">
          <h2>Finish review</h2>
          {!confirmingComplete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                setError(null);
                setMarkingId(null);
                setConfirmingComplete(true);
              }}
            >
              Complete review
            </button>
          ) : (
            <div className="equipment-review__confirm">
              <p>
                {shortLines.length === 0
                  ? "Every line is fully reserved, so this request will be marked Arranged."
                  : `${shortLines.length} line${shortLines.length === 1 ? " is" : "s are"} not fully reserved. Each needs a "Cannot be provided" note, and the request will be marked Cannot be fully arranged. Reservations already made are kept.`}
              </p>
              <div className="equipment-review__actions">
                <button type="button" disabled={busy} onClick={handleComplete}>
                  {busy ? "Completing..." : "Yes, complete review"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmingComplete(false)}>
                  Not yet
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
