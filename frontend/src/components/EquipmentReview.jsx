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
import { formatTimestamp } from "../services/displayFormat";
import { formatEventPeriod } from "../services/eventPeriodFormat";
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
      <span className="er-label">Stock check</span>
      <strong>{availability.result}</strong>
      <span>{availabilitySummary(availability)}</span>
      {breakdown && (
        <p className="equipment-review__muted">
          {`${breakdown.total} in stock, ${breakdown.damagedOrUnderMaintenance} damaged or under maintenance, ${breakdown.reserved} reserved for this period.`}
        </p>
      )}
      {reservations.length > 0 && (
        <details>
          <summary>{`Other events using this equipment (${reservations.length})`}</summary>
          <ul>
            {reservations.map((reservation) => (
              <li key={reservation.id}>
                {`${reservation.eventName ?? "Another event"}: ${reservation.quantity} ${
                  reservation.quantity === 1 ? "unit" : "units"
                }, ${formatEventPeriod(reservation.startAt, reservation.endAt)}`}
                {reservation.flagged ? " (flagged for review)" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Where a line belongs on the screen. A flagged reservation or missing units need the
 * reviewer; a line that is fully reserved, or marked "cannot be provided", is dealt with.
 */
function lineState(line) {
  if ((line.flaggedCount ?? 0) > 0) return "flagged";
  if (line.outcome === "cannot_be_provided") return "cannot";
  if (line.shortBy > 0) return "short";
  return "ok";
}

const NEEDS_ATTENTION = new Set(["flagged", "short"]);

const STEP_LABELS = ["Start the review", "Reserve the equipment", "Complete the review"];

/** Which of the three steps the reviewer is on. A finished request counts as past step 3. */
function currentStep({ status, reviewing, flaggedTotal, shortCount }) {
  if (status === "arranged" || status === "cannot_be_fully_arranged" || status === "cancelled") return 4;
  if (!reviewing) return 1;
  return flaggedTotal === 0 && shortCount === 0 ? 3 : 2;
}

/** The one thing to do next, in a sentence. Tone only picks the colour. */
function nextStep({ status, isReviewer, reviewerName, flaggedTotal, shortCount, lineCount }) {
  if (status === "pending_review") {
    return {
      tone: "action",
      title: "Start the review",
      text: "Start the review to reserve equipment or mark lines.",
    };
  }
  if (status === "cannot_be_fully_arranged") {
    return {
      tone: "warn",
      title: "Some equipment could not be provided",
      text: "Review again if stock has changed and you want to try the missing lines once more.",
    };
  }
  if (status === "arranged") {
    return { tone: "ok", title: "All equipment is arranged", text: "Nothing more to do unless the event changes." };
  }
  if (status === "cancelled") {
    return { tone: "muted", title: "This request was cancelled", text: "Its reservations have been released." };
  }
  if (status === "under_review" && !isReviewer) {
    return {
      tone: "warn",
      title: `${reviewerName ?? "Another staff member"} is reviewing this`,
      text: "You can look, but only the reviewer can change anything. Take over if they are away.",
    };
  }
  if (flaggedTotal > 0) {
    return {
      tone: "warn",
      title: `Decide on ${flaggedTotal} flagged reservation${flaggedTotal === 1 ? "" : "s"}`,
      text: `${flaggedTotal} reservation${flaggedTotal === 1 ? " is" : "s are"} flagged because something changed after it was made. Find the orange box below and choose one option. The request cannot be Arranged while any is flagged.`,
    };
  }
  if (shortCount > 0) {
    return {
      tone: "action",
      title: "Reserve the rest of the equipment",
      text: `${shortCount} of ${lineCount} line${lineCount === 1 ? "" : "s"} ${shortCount === 1 ? "still needs" : "still need"} equipment. For each one, reserve what is available, or say it cannot be provided and why.`,
    };
  }
  return {
    tone: "ok",
    title: "Ready to complete",
    text: "Every line is dealt with. Press Complete review at the bottom of the page.",
  };
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

  // null until the reviewer picks a tab: then the screen shows what needs attention, or what is done.
  const [pickedTab, setPickedTab] = useState(null);

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
  const attentionLines = lines.filter((line) => NEEDS_ATTENTION.has(lineState(line)));
  const doneLines = lines.filter((line) => !NEEDS_ATTENTION.has(lineState(line)));
  const tab = pickedTab ?? (attentionLines.length > 0 ? "attention" : "done");
  const visibleLines = tab === "attention" ? attentionLines : tab === "done" ? doneLines : lines;
  const eventPeriod = formatEventPeriod(event?.proposedStart, event?.proposedEnd);
  const next = nextStep({
    status,
    isReviewer,
    reviewerName: request.reviewerName,
    flaggedTotal,
    shortCount: shortLines.length,
    lineCount: lines.length,
  });
  const stepNumber = currentStep({ status, reviewing, flaggedTotal, shortCount: shortLines.length });

  return (
    <div className="dashboard dashboard--tech-support equipment-review">
      <h1>Equipment request review</h1>

      <section className="equipment-review__event">
        <div className="er-event-head">
          <h2>{event?.name ?? "Event"}</h2>
          <span className={`equipment-review__status equipment-review__status--${STATUS_CLASS[status] ?? "pending"}`}>
            {request.statusLabel}
          </span>
        </div>
        <dl className="er-facts">
          <div>
            <dt>When</dt>
            <dd>{eventPeriod}</dd>
          </div>
          <div>
            <dt>Venue</dt>
            <dd>{event?.venue ? event.venue.name : "No venue booked."}</dd>
          </div>
          <div>
            <dt>Coordinator</dt>
            <dd>{event?.assignedCoordinatorName ?? "No coordinator assigned."}</dd>
          </div>
        </dl>
        <button type="button" className="er-btn er-btn--link" disabled={busy} onClick={load}>
          Refresh
        </button>
      </section>

      <ol className="er-steps" aria-label="Review progress">
        {STEP_LABELS.map((label, index) => (
          <li
            key={label}
            className={`er-step${index + 1 < stepNumber ? " er-step--done" : ""}${index + 1 === stepNumber ? " er-step--current" : ""}`}
            aria-current={index + 1 === stepNumber ? "step" : undefined}
          >
            <span className="er-step__num" aria-hidden="true">
              {index + 1 < stepNumber ? "✓" : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      <section className={`er-next er-next--${next.tone}`} aria-label="Next step">
        <h2>{next.title}</h2>
        <p>{next.text}</p>
        {status === "under_review" && (
          <p className="er-next__who">
            {isReviewer
              ? `You are reviewing this request (since ${formatTimestamp(request.reviewStartedAt)}).`
              : `Being reviewed by ${request.reviewerName ?? "another staff member"} since ${formatTimestamp(
                  request.reviewStartedAt,
                )}.`}
          </p>
        )}
        {(canStart || canTakeOver) && (
          <div className="equipment-review__actions">
            {canStart && (
              <button type="button" className="er-btn er-btn--primary" disabled={busy} onClick={handleStart}>
                {status === "cannot_be_fully_arranged" ? "Review again" : "Start review"}
              </button>
            )}
            {canTakeOver && (
              <button type="button" className="er-btn er-btn--primary" disabled={busy} onClick={handleTakeOver}>
                Take over review
              </button>
            )}
          </div>
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
        <div className="er-tabs" role="tablist" aria-label="Show lines">
          {[
            ["attention", "Needs attention", attentionLines.length, "attention"],
            ["done", "Done", doneLines.length, "done"],
            ["all", "All", lines.length, "all"],
          ].map(([id, label, count, tone]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`er-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="er-tabpanel"
              className={`er-tab er-tab--${tone}${tab === id ? " er-tab--active" : ""}`}
              onClick={() => setPickedTab(id)}
            >
              {label}
              <span className="er-tab__count">{count}</span>
            </button>
          ))}
        </div>
        <div id="er-tabpanel" role="tabpanel" aria-labelledby={`er-tab-${tab}`}>
        {visibleLines.length === 0 && (
          <p className="er-empty">
            {tab === "attention"
              ? "Nothing needs attention. Every line is reserved or marked as not provided. Check the Done tab, then complete the review."
              : tab === "done"
                ? "Nothing is finished yet. Reserve equipment on the Needs attention tab and lines will move here."
                : "This request has no lines."}
          </p>
        )}
        <ul>
          {visibleLines.map((line) => {
            const marked = line.outcome === "cannot_be_provided";
            const reservations = line.reservations ?? [];
            const editingThisLine = editor?.lineId === line.id;
            const percent = line.quantity > 0 ? Math.min(100, Math.round((line.reserved / line.quantity) * 100)) : 0;
            const lineDone = line.shortBy <= 0;
            const canReserveNow = reservableNow(line);
            return (
              <li key={line.id} className={`equipment-review__line er-line--${lineState(line)}`}>
                <div className="equipment-review__line-head">
                  <strong>{line.name}</strong>
                  {!marked && (
                    <span className={`er-pill ${lineDone ? "er-pill--ok" : "er-pill--todo"}`}>
                      {lineDone ? "Fully reserved" : `${line.shortBy} more needed`}
                    </span>
                  )}
                  {line.typeRetired && <small>This equipment type has been retired.</small>}
                </div>
                <div className="er-counts">
                  <span>{`Requested: ${line.quantity}`}</span>
                  <span>{`Reserved: ${line.reserved} of ${line.quantity}`}</span>
                </div>
                <div className="er-progress" aria-hidden="true">
                  <span style={{ width: `${percent}%` }} />
                </div>
                <p className="equipment-review__notes">
                  <span className="er-label">Technical notes</span>
                  {line.technicalNotes ?? "No technical notes."}
                </p>

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
                        const period = formatEventPeriod(reservation.startAt, reservation.endAt);
                        return (
                          <li
                            key={reservation.id}
                            className={`equipment-review__reservation${
                              reservation.flagged ? " equipment-review__reservation--flagged" : ""
                            }`}
                          >
                            <div className="er-res__main">
                              <strong>{`${reservation.quantity} reserved`}</strong>
                              <span>{period}</span>
                            </div>

                            {reservation.flagged && (
                              <div className="er-conflict">
                                <h4>Needs your decision</h4>
                                <p className="equipment-review__flag">
                                  <strong>Flagged</strong>
                                  {reservation.flagReason ? `: ${reservation.flagReason}` : ""}
                                </p>
                                <dl className="er-compare">
                                  <div>
                                    <dt>Reserved for</dt>
                                    <dd>{period}</dd>
                                  </div>
                                  <div>
                                    <dt>The event is now</dt>
                                    <dd>{eventPeriod}</dd>
                                  </div>
                                </dl>
                                {reviewing && !editingThis && (
                                  <ul className="er-choices">
                                    <li>
                                      <button
                                        type="button"
                                        className="er-btn er-btn--primary"
                                        aria-label={`Move to new time: ${line.name}`}
                                        disabled={busy}
                                        onClick={() => handleResolve("move", line, reservation)}
                                      >
                                        Move to new time
                                      </button>
                                      <span>Reserve the same units for the event's new date and time. Only works if enough are free then.</span>
                                    </li>
                                    <li>
                                      <button
                                        type="button"
                                        className="er-btn er-btn--secondary"
                                        aria-label={`Keep old time: ${line.name}`}
                                        disabled={busy}
                                        onClick={() => handleResolve("keep", line, reservation)}
                                      >
                                        Keep old time
                                      </button>
                                      <span>Leave the reservation as it is and clear the flag. Choose this if the old time still works.</span>
                                    </li>
                                    {reservation.quantity > 1 && (
                                      <li>
                                        <button
                                          type="button"
                                          className="er-btn er-btn--secondary"
                                          aria-label={`Reduce quantity: ${line.name}`}
                                          disabled={busy}
                                          onClick={() =>
                                            openEditor(
                                              { kind: "reduce", lineId: line.id, reservationId: reservation.id },
                                              reservation.quantity - 1,
                                            )
                                          }
                                        >
                                          Reduce quantity
                                        </button>
                                        <span>Keep fewer than {reservation.quantity} and let the rest go. You will be asked why.</span>
                                      </li>
                                    )}
                                    <li>
                                      <button
                                        type="button"
                                        className="er-btn er-btn--danger"
                                        aria-label={`Release all: ${line.name}`}
                                        disabled={busy}
                                        onClick={() =>
                                          openEditor({ kind: "release", lineId: line.id, reservationId: reservation.id })
                                        }
                                      >
                                        Release all
                                      </button>
                                      <span>{`Give all ${reservation.quantity} back so other events can use them. You will be asked why.`}</span>
                                    </li>
                                  </ul>
                                )}
                              </div>
                            )}

                            {reviewing && !reservation.flagged && !editingThis && (
                              <div className="er-res__actions">
                                {reservation.quantity > 1 && (
                                  <button
                                    type="button"
                                    className="er-btn er-btn--secondary"
                                    aria-label={`Reduce quantity: ${line.name}`}
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor(
                                        { kind: "reduce", lineId: line.id, reservationId: reservation.id },
                                        reservation.quantity - 1,
                                      )
                                    }
                                  >
                                    Reduce quantity
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="er-btn er-btn--danger"
                                  aria-label={`Release all: ${line.name}`}
                                  disabled={busy}
                                  onClick={() =>
                                    openEditor({ kind: "release", lineId: line.id, reservationId: reservation.id })
                                  }
                                >
                                  Release all
                                </button>
                              </div>
                            )}

                            {reviewing && editingThis && (
                              <form
                                className="equipment-review__form"
                                noValidate
                                onSubmit={(e) => handleEditorSubmit(e, line, reservation)}
                              >
                                <h4>
                                  {editor.kind === "reduce"
                                    ? `Reduce the ${line.name} reservation`
                                    : `Release the ${line.name} reservation`}
                                </h4>
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
                                  <button
                                    type="submit"
                                    className={`er-btn ${editor.kind === "release" ? "er-btn--danger" : "er-btn--primary"}`}
                                    disabled={busy}
                                  >
                                    {busy ? "Saving..." : editor.kind === "reduce" ? "Reduce" : "Release"}
                                  </button>
                                  <button type="button" className="er-btn er-btn--secondary" disabled={busy} onClick={resetEditors}>
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
                  <div className="er-line-actions">
                    <div className="equipment-review__actions">
                      <button
                        type="button"
                        className="er-btn er-btn--primary"
                        aria-label={`Reserve ${line.name}`}
                        disabled={busy}
                        onClick={() => {
                          openEditor({ kind: "reserve", lineId: line.id }, canReserveNow === null ? line.shortBy : canReserveNow || "");
                        }}
                      >
                        Reserve
                      </button>
                      <button
                        type="button"
                        className="er-btn er-btn--secondary"
                        aria-label={`${marked ? "Edit note for" : "Mark as cannot be provided:"} ${line.name}`}
                        disabled={busy}
                        onClick={() => openMark(line)}
                      >
                        {marked ? "Edit note" : "Cannot be provided"}
                      </button>
                      {marked && (
                        <button
                          type="button"
                          className="er-btn er-btn--secondary"
                          aria-label={`Remove mark on ${line.name}`}
                          disabled={busy}
                          onClick={() => handleClear(line)}
                        >
                          Remove mark
                        </button>
                      )}
                    </div>
                    <p className="equipment-review__muted">
                      {marked
                        ? "Marked as not provided. You can still reserve what is available."
                        : canReserveNow === 0
                          ? "Nothing can be reserved right now. If it cannot be supplied, say so."
                          : canReserveNow === null
                            ? "Reserve units for this event, or say this line cannot be provided."
                            : `${canReserveNow} can be reserved right now. If the rest cannot be supplied, say so.`}
                    </p>
                  </div>
                )}

                {reviewing && editingThisLine && editor.kind === "reserve" && (
                  <form className="equipment-review__form" noValidate onSubmit={(e) => handleEditorSubmit(e, line)}>
                    <h4>{`Reserve ${line.name}`}</h4>
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
                    {canReserveNow !== null && (
                      <p className="equipment-review__muted">
                        {canReserveNow === 0
                          ? "None can be reserved right now."
                          : `Up to ${canReserveNow} can be reserved right now.`}
                      </p>
                    )}
                    {editorError && (
                      <p className="equipment-review__error" role="alert">
                        {editorError}
                      </p>
                    )}
                    <div className="equipment-review__actions">
                      <button type="submit" className="er-btn er-btn--primary" disabled={busy}>
                        {busy ? "Saving..." : "Reserve"}
                      </button>
                      <button type="button" className="er-btn er-btn--secondary" disabled={busy} onClick={resetEditors}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {reviewing && markingId === line.id && (
                  <form className="equipment-review__form" noValidate onSubmit={(e) => handleMark(e, line)}>
                    <h4>{`${line.name} cannot be provided`}</h4>
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
                      <button type="submit" className="er-btn er-btn--primary" disabled={busy}>
                        {busy ? "Saving..." : "Save note"}
                      </button>
                      <button type="button" className="er-btn er-btn--secondary" disabled={busy} onClick={resetEditors}>
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
      </section>

      {reviewing && (
        <section className="equipment-review__complete">
          <h2>Finish review</h2>
          <ul className="er-checklist">
            {lines.map((line) => {
              const flagged = (line.flaggedCount ?? 0) > 0;
              const done = !flagged && (line.shortBy <= 0 || line.outcome === "cannot_be_provided");
              return (
                <li key={line.id} className={done ? "er-check er-check--ok" : "er-check er-check--todo"}>
                  <span aria-hidden="true">{done ? "✓" : "!"}</span>
                  {`${line.name}: ${line.reserved} of ${line.quantity} reserved`}
                  {flagged
                    ? " (has a flagged reservation to decide)"
                    : line.shortBy > 0 && line.outcome !== "cannot_be_provided"
                      ? " (reserve more or mark it cannot be provided)"
                      : line.shortBy > 0
                        ? " (marked cannot be provided)"
                        : ""}
                </li>
              );
            })}
          </ul>
          {!confirmingComplete ? (
            <button
              type="button"
              className="er-btn er-btn--primary"
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
                <button type="button" className="er-btn er-btn--primary" disabled={busy} onClick={handleComplete}>
                  {busy ? "Completing..." : "Yes, complete review"}
                </button>
                <button type="button" className="er-btn er-btn--secondary" disabled={busy} onClick={() => setConfirmingComplete(false)}>
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
