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
// SCRUM-300 adds the reservations. Each line lists its live reservations. The
// reviewer reserves units for a short line, reduces or releases a reservation
// (both need a reason) and, for a flagged one, moves it to the event's current
// date and time or keeps it. A flagged reservation shows why it was flagged, and
// the request cannot be Arranged while any is flagged.
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
  keepEquipmentReservation,
  markEquipmentLineUnavailable,
  moveEquipmentReservation,
  reduceEquipmentReservation,
  releaseEquipmentReservation,
  reserveEquipment,
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

/**
 * How many more can be reserved for a line right now, or null when the line has
 * no availability to go on. SCRUM-23's figure leaves the event's own reservations
 * out, but a new reservation is checked against everything already held, so what
 * this event already holds comes off. The server still decides.
 */
function reservableNow(line) {
  const available = line.availability?.quantityAvailable;
  if (typeof available !== "number") return null;
  return Math.max(0, Math.min(line.shortBy, available - line.reserved));
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

  // The one open reservation editor: { kind: "reserve" | "reduce" | "release", lineId, reservationId? }.
  const [editor, setEditor] = useState(null);
  const [quantityInput, setQuantityInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [editorError, setEditorError] = useState(null);

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
    setEditor(null);
    setQuantityInput("");
    setReasonInput("");
    setEditorError(null);
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
    setEditor(null);
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

  function openEditor(next, quantity = "") {
    setNotice(null);
    setError(null);
    setConfirmingComplete(false);
    setMarkingId(null);
    setMarkError(null);
    setEditor(next);
    setQuantityInput(String(quantity));
    setReasonInput("");
    setEditorError(null);
  }

  async function handleEditorSubmit(submitEvent, line, reservation) {
    submitEvent.preventDefault();
    const quantity = Number(quantityInput);
    const reason = reasonInput.trim();

    if (editor.kind !== "release") {
      if (quantityInput.trim() === "" || !Number.isInteger(quantity) || quantity < 1) {
        setEditorError("Quantity must be a whole number greater than zero.");
        return;
      }
      if (editor.kind === "reduce" && quantity >= reservation.quantity) {
        setEditorError(`Enter a number below ${reservation.quantity}. To give all of it back, release it.`);
        return;
      }
    }
    if (editor.kind !== "reserve" && reason === "") {
      setEditorError("Add a reason.");
      return;
    }

    setEditorError(null);
    const actions = {
      reserve: [() => reserveEquipment(eventId, line.id, quantity), `Reserved ${quantity} of ${line.name}.`],
      reduce: [
        () => reduceEquipmentReservation(eventId, reservation?.id, quantity, reason),
        `Reduced the ${line.name} reservation to ${quantity}.`,
      ],
      release: [
        () => releaseEquipmentReservation(eventId, reservation?.id, reason),
        `Released the ${line.name} reservation.`,
      ],
    };
    const [action, success] = actions[editor.kind];
    const ok = await run(action, { onError: setEditorError, success });
    if (ok) resetEditors();
  }

  async function handleResolve(kind, line, reservation) {
    resetEditors();
    if (kind === "move") {
      await run(() => moveEquipmentReservation(eventId, reservation.id), {
        success: `Moved the ${line.name} reservation to the event's current date and time.`,
      });
    } else {
      await run(() => keepEquipmentReservation(eventId, reservation.id), {
        success: `Kept the ${line.name} reservation as it is.`,
      });
    }
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
  const flaggedTotal = lines.reduce((sum, line) => sum + (line.flaggedCount ?? 0), 0);

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
        {flaggedTotal > 0 && (
          <p className="equipment-review__flag-banner" role="status">
            {`${flaggedTotal} reservation${flaggedTotal === 1 ? " is" : "s are"} flagged. Move, reduce, release or keep each one. The request cannot be Arranged while any is flagged.`}
          </p>
        )}
        <ul>
          {lines.map((line) => {
            const marked = line.outcome === "cannot_be_provided";
            const reservations = line.reservations ?? [];
            const editingThisLine = editor?.lineId === line.id;
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

                {reservations.length > 0 && (
                  <div className="equipment-review__reservations">
                    <h3>{`Reservations (${reservations.length})`}</h3>
                    <ul>
                      {reservations.map((reservation) => {
                        const editingThis = editor?.reservationId === reservation.id;
                        return (
                          <li
                            key={reservation.id}
                            className={`equipment-review__reservation${
                              reservation.flagged ? " equipment-review__reservation--flagged" : ""
                            }`}
                          >
                            <span>{`${reservation.quantity} reserved, ${formatRange(reservation.startAt, reservation.endAt)}`}</span>
                            {reservation.flagged && (
                              <span className="equipment-review__flag">
                                <strong>Flagged</strong>
                                {reservation.flagReason ? `: ${reservation.flagReason}` : ""}
                              </span>
                            )}
                            {reviewing && !editingThis && (
                              <div className="equipment-review__actions">
                                {reservation.flagged && (
                                  <>
                                    <button
                                      type="button"
                                      aria-label={`Move the ${line.name} reservation`}
                                      disabled={busy}
                                      onClick={() => handleResolve("move", line, reservation)}
                                    >
                                      Move
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Keep the ${line.name} reservation`}
                                      disabled={busy}
                                      onClick={() => handleResolve("keep", line, reservation)}
                                    >
                                      Keep
                                    </button>
                                  </>
                                )}
                                {reservation.quantity > 1 && (
                                  <button
                                    type="button"
                                    aria-label={`Reduce the ${line.name} reservation`}
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor(
                                        { kind: "reduce", lineId: line.id, reservationId: reservation.id },
                                        reservation.quantity - 1,
                                      )
                                    }
                                  >
                                    Reduce
                                  </button>
                                )}
                                <button
                                  type="button"
                                  aria-label={`Release the ${line.name} reservation`}
                                  disabled={busy}
                                  onClick={() =>
                                    openEditor({ kind: "release", lineId: line.id, reservationId: reservation.id })
                                  }
                                >
                                  Release
                                </button>
                              </div>
                            )}
                            {reviewing && editingThis && (
                              <form
                                className="equipment-review__form"
                                noValidate
                                onSubmit={(e) => handleEditorSubmit(e, line, reservation)}
                              >
                                {editor.kind === "reduce" && (
                                  <label>
                                    {`New quantity (currently ${reservation.quantity})`}
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      value={quantityInput}
                                      disabled={busy}
                                      onChange={(e) => {
                                        setQuantityInput(e.target.value);
                                        setEditorError(null);
                                      }}
                                    />
                                  </label>
                                )}
                                <label>
                                  {editor.kind === "reduce" ? "Why is it being reduced?" : "Why is it being released?"}
                                  <textarea
                                    value={reasonInput}
                                    maxLength={MAX_NOTE_LENGTH}
                                    disabled={busy}
                                    onChange={(e) => {
                                      setReasonInput(e.target.value);
                                      setEditorError(null);
                                    }}
                                  />
                                </label>
                                {editorError && (
                                  <p className="equipment-review__error" role="alert">
                                    {editorError}
                                  </p>
                                )}
                                <div className="equipment-review__actions">
                                  <button type="submit" disabled={busy}>
                                    {busy ? "Saving..." : editor.kind === "reduce" ? "Reduce" : "Release"}
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
                  </div>
                )}

                {reviewing && line.shortBy > 0 && markingId !== line.id && !(editingThisLine && editor.kind === "reserve") && (
                  <div className="equipment-review__actions">
                    <button
                      type="button"
                      aria-label={`Reserve ${line.name}`}
                      disabled={busy}
                      onClick={() => {
                        const now = reservableNow(line);
                        openEditor({ kind: "reserve", lineId: line.id }, now === null ? line.shortBy : now || "");
                      }}
                    >
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

                {reviewing && editingThisLine && editor.kind === "reserve" && (
                  <form className="equipment-review__form" noValidate onSubmit={(e) => handleEditorSubmit(e, line)}>
                    <label>
                      {`How many ${line.name} to reserve? (${line.shortBy} still needed)`}
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={quantityInput}
                        disabled={busy}
                        onChange={(e) => {
                          setQuantityInput(e.target.value);
                          setEditorError(null);
                        }}
                      />
                    </label>
                    {reservableNow(line) !== null && (
                      <p className="equipment-review__muted">
                        {reservableNow(line) === 0
                          ? "None can be reserved right now."
                          : `Up to ${reservableNow(line)} can be reserved right now.`}
                      </p>
                    )}
                    {editorError && (
                      <p className="equipment-review__error" role="alert">
                        {editorError}
                      </p>
                    )}
                    <div className="equipment-review__actions">
                      <button type="submit" disabled={busy}>
                        {busy ? "Saving..." : "Reserve"}
                      </button>
                      <button type="button" disabled={busy} onClick={resetEditors}>
                        Cancel
                      </button>
                    </div>
                  </form>
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
