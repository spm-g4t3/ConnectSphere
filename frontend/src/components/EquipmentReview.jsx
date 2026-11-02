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
import { equipmentStatusClass } from "../services/equipmentRequestStatus";
import { formatTimestamp } from "../services/displayFormat";
import { SERVER_TEXT_MAX_LENGTH } from "../services/textLimits";
import { formatEventPeriod } from "../services/eventPeriodFormat";
import "./EquipmentReview.css";

const RESULT_CLASS = {
  "Fully available": "fully",
  "Partially available": "partially",
  Unavailable: "unavailable",
};

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

/** A number box with a minus and a plus either side. The server still decides what is allowed. */
function QuantityStepper({ id, name, value, max, disabled, onChange }) {
  const n = Math.floor(Number(value) || 0);
  return (
    <div className="er-stepper">
      <button
        type="button"
        className="er-stepper__btn"
        aria-label={`One fewer ${name}`}
        disabled={disabled || n <= 1}
        onClick={() => onChange(String(Math.max(1, n - 1)))}
      >
        {"\u2212"}
      </button>
      <input
        id={id}
        type="number"
        min="1"
        step="1"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="er-stepper__btn"
        aria-label={`One more ${name}`}
        disabled={disabled || (max !== null && n >= max)}
        onClick={() => onChange(String(n + 1))}
      >
        +
      </button>
    </div>
  );
}

function stockSentence(availability, requested) {
  if (availability.message) return availability.message;
  if (availability.result === "Fully available") return `Enough in stock: ${availability.quantityAvailable} available.`;
  if (availability.result === "Partially available") {
    return `Only ${availability.quantityAvailable} of ${requested} available.`;
  }
  return "None available.";
}

function Availability({ availability }) {
  if (!availability) return <p className="equipment-review__muted">Availability is not shown for this item.</p>;
  const { breakdown, reservations } = availability;
  const requested = availability.quantityRequested;

  return (
    <div
      className={`equipment-review__availability equipment-review__availability--${
        RESULT_CLASS[availability.result] ?? "unavailable"
      }`}
    >
      <p className="er-stock">
        <span className="er-stock__dot" aria-hidden="true" />
        {stockSentence(availability, requested)}
      </p>
      {(breakdown || reservations.length > 0) && (
        <details className="er-stock__details">
          <summary>Stock details</summary>
          {breakdown && (
            <p className="er-stock__breakdown">
              {`${breakdown.total} in stock, ${breakdown.damagedOrUnderMaintenance} damaged or under maintenance, ${breakdown.reserved} reserved for this period.`}
            </p>
          )}
          {reservations.length > 0 && (
            <>
              <p className="er-stock__others">{`Other events using this equipment (${reservations.length})`}</p>
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
            </>
          )}
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

/** The one thing to do next, in a sentence. Tone only picks the colour. */
function nextStep({ status, isReviewer, reviewerName, flaggedTotal, unmarkedCount }) {
  if (status === "pending_review") {
    return {
      tone: "action",
      title: "Start the review",
      text: "Start the review to reserve equipment or mark items.",
    };
  }
  if (status === "cannot_be_fully_arranged") {
    return {
      tone: "warn",
      title: "Some equipment could not be provided",
      text: "Review again if stock has changed and you want to try the missing items once more.",
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
      text: `Something changed after ${flaggedTotal === 1 ? "this reservation was" : "these reservations were"} made. Open the item marked "Needs decision" and choose one option.`,
    };
  }
  if (unmarkedCount > 0) {
    return {
      tone: "action",
      title: "Reserve the rest of the equipment",
      text: `${unmarkedCount} ${unmarkedCount === 1 ? "item still needs" : "items still need"} equipment. Reserve what is available, or mark it as not provided.`,
    };
  }
  return {
    tone: "ok",
    title: "Ready to complete",
    text: "Every item is dealt with. Press Complete review at the bottom.",
  };
}

/**
 * Whether stock has come back for the missing items, from reservableNow alone. A
 * hint, never a promise: the server checks the stock again when units are reserved.
 * Null when no missing line has availability to go on.
 */
function stockBack(lines) {
  const missing = lines.filter((line) => line.shortBy > 0);
  if (!missing.some((line) => reservableNow(line) !== null)) return null;
  const found = missing
    .map((line) => ({ line, now: reservableNow(line) ?? 0 }))
    .filter(({ now }) => now > 0);
  if (found.length === 0) {
    return { outcome: "none", text: "No new stock yet. None of the missing items can now be reserved." };
  }
  const items = found
    .map(({ line, now }) => `${line.name} ×${now}${now < line.shortBy ? ` of ${line.shortBy}` : ""}`)
    .join(", ");
  if (found.length === missing.length && found.every(({ line, now }) => now === line.shortBy)) {
    return {
      outcome: "all",
      text:
        missing.length === 1
          ? `The missing item can now be reserved: ${items}. Review again to reserve it.`
          : `All ${missing.length} missing items can now be reserved: ${items}. Review again to reserve them.`,
    };
  }
  return {
    outcome: "some",
    text: `${found.length} of ${missing.length} missing item${missing.length === 1 ? "" : "s"} can now be reserved: ${items}.`,
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

  // How many of each short line to reserve, by line id. A line with no entry reserves as many as it can.
  const [reserveQty, setReserveQty] = useState({});
  const [reserveError, setReserveError] = useState(null);

  // The one open reservation editor: { kind: "change" | "reduce" | "release", lineId, reservationId }.
  const [editor, setEditor] = useState(null);
  const [quantityInput, setQuantityInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [editorError, setEditorError] = useState(null);

  // null until the reviewer picks a tab: then the screen shows what needs attention, or what is done.
  const [pickedTab, setPickedTab] = useState(null);
  // The one line that is open. undefined: not chosen yet (a lone line opens itself); null: all closed.
  const [openLineId, setOpenLineId] = useState(undefined);

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
    setReserveError(null);
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
      if (editor.kind === "change" && quantity === reservation.quantity) {
        setEditorError("That is the current quantity. Enter a different number.");
        return;
      }
    }
    // Giving units back needs a reason. Reserving more does not.
    const reducing = editor.kind === "reduce" || (editor.kind === "change" && quantity < reservation.quantity);
    if ((editor.kind === "release" || reducing) && reason === "") {
      setEditorError("Add a reason.");
      return;
    }

    setEditorError(null);
    const actions = {
      reduce: [
        () => reduceEquipmentReservation(eventId, reservation?.id, quantity, reason),
        `Reduced the ${line.name} reservation to ${quantity}.`,
      ],
      change: reducing
        ? [
            () => reduceEquipmentReservation(eventId, reservation?.id, quantity, reason),
            `Reduced the ${line.name} reservation to ${quantity}.`,
          ]
        : [
            () => reserveEquipment(eventId, line.id, quantity - (reservation?.quantity ?? 0)),
            `Reserved ${quantity - (reservation?.quantity ?? 0)} more ${line.name}.`,
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

  /** One click: reserve the number shown beside the button. */
  async function handleReserve(line, quantity) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      setReserveError({ lineId: line.id, message: "Enter a whole number of 1 or more." });
      return;
    }
    setMarkingId(null);
    setEditor(null);
    setReserveError(null);
    const ok = await run(() => reserveEquipment(eventId, line.id, quantity), {
      onError: (message) => setReserveError({ lineId: line.id, message }),
      success: `Reserved ${quantity} of ${line.name}.`,
    });
    if (ok) setReserveQty((all) => ({ ...all, [line.id]: undefined }));
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
  const openId = openLineId !== undefined ? openLineId : visibleLines.length === 1 ? visibleLines[0].id : null;
  function toggleLine(id) {
    resetEditors();
    setOpenLineId(openId === id ? null : id);
  }
  const eventPeriod = formatEventPeriod(event?.proposedStart, event?.proposedEnd);
  const next = nextStep({
    status,
    isReviewer,
    reviewerName: request.reviewerName,
    flaggedTotal,
    unmarkedCount: shortLines.filter((line) => line.outcome !== "cannot_be_provided").length,
  });
  const stock = status === "cannot_be_fully_arranged" ? stockBack(lines) : null;
  // Review again stands out only when every missing item can now be reserved.
  const startClass = status === "cannot_be_fully_arranged" && stock?.outcome !== "all" ? "er-btn--secondary" : "er-btn--primary";

  return (
    <div className="dashboard dashboard--tech-support equipment-review">
      <h1>Equipment request review</h1>

      <section className="equipment-review__event">
        <div className="er-event-head">
          <h2>{event?.name ?? "Event"}</h2>
          <span className={`equipment-review__status equipment-review__status--${equipmentStatusClass(status)}`}>
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

      <section className={`er-next er-next--${next.tone}`} aria-label="Next step">
        <h2>{next.title}</h2>
        <p>{next.text}</p>
        {stock && (
          <p className={`er-next__stock er-next__stock--${stock.outcome}`} role="status">
            {stock.text}
          </p>
        )}
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
              <button type="button" className={`er-btn ${startClass}`} disabled={busy} onClick={handleStart}>
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
        <h2>Equipment requested</h2>
        <div className="er-tabs" role="tablist" aria-label="Show equipment items">
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
              onClick={() => {
                setPickedTab(id);
                setOpenLineId(undefined);
              }}
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
              ? "Nothing needs attention. Every item is reserved or marked as not provided. Check the Done tab, then complete the review."
              : tab === "done"
                ? "Nothing is finished yet. Reserve equipment on the Needs attention tab and items will move here."
                : "This request has no equipment items."}
          </p>
        )}
        <ul>
          {visibleLines.map((line) => {
            const marked = line.outcome === "cannot_be_provided";
            const reservations = line.reservations ?? [];
            const editingThisLine = editor?.lineId === line.id;
            const percent = line.quantity > 0 ? Math.min(100, Math.round((line.reserved / line.quantity) * 100)) : 0;
            const isOpen = openId === line.id;
            const canReserveNow = reservableNow(line);
            const reserveMax = canReserveNow ?? line.shortBy;
            const reserveValue = reserveQty[line.id] ?? String(reserveMax);
            const reserveText = reserveValue === "" ? "Reserve" : `Reserve ${reserveValue}${line.reserved > 0 ? " more" : ""}`;
            return (
              <li key={line.id} className={`equipment-review__line er-line--${lineState(line)}`}>
                <h3 className="er-line__heading">
                  <button
                    type="button"
                    className="er-line__toggle"
                    aria-expanded={isOpen}
                    aria-controls={`er-line-${line.id}`}
                    onClick={() => toggleLine(line.id)}
                  >
                    <span className="er-line__top">
                      <strong>{line.name}</strong>
                      {(lineState(line) === "flagged" || lineState(line) === "cannot") && (
                        <span className={`er-pill er-pill--${lineState(line)}`}>
                          {lineState(line) === "flagged" ? "Needs decision" : "Not provided"}
                        </span>
                      )}
                      {line.typeRetired && <small>This equipment type has been retired.</small>}
                      <span className="er-line__chevron" aria-hidden="true">
                        {isOpen ? "Hide \u25B4" : "Open \u25BE"}
                      </span>
                    </span>
                    <span className="er-counts">{`${line.reserved} of ${line.quantity} reserved`}</span>
                    <span className="er-progress" aria-hidden="true">
                      <span style={{ width: `${percent}%` }} />
                    </span>
                  </button>
                </h3>
                {isOpen && (
                <div id={`er-line-${line.id}`} className="er-line__body">
                <Availability availability={line.availability} />
                {line.technicalNotes && (
                  <p className="equipment-review__notes er-notes">{`Note: ${line.technicalNotes}`}</p>
                )}

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
                                    {reservation.canKeep && (
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
                                    )}
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
                                {(reservation.quantity > 1 || (line.shortBy > 0 && canReserveNow !== 0)) && (
                                  <button
                                    type="button"
                                    className="er-btn er-btn--secondary"
                                    aria-label={`Change quantity: ${line.name}`}
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor(
                                        { kind: "change", lineId: line.id, reservationId: reservation.id },
                                        reservation.quantity,
                                      )
                                    }
                                  >
                                    Change quantity
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
                                  {editor.kind === "release"
                                    ? `Release the ${line.name} reservation`
                                    : editor.kind === "change"
                                      ? `Change the ${line.name} reservation`
                                      : `Reduce the ${line.name} reservation`}
                                </h4>
                                {editor.kind !== "release" && (
                                  <>
                                    <label htmlFor={`er-qty-${reservation.id}`}>
                                      {`New quantity (currently ${reservation.quantity})`}
                                    </label>
                                    <QuantityStepper
                                      id={`er-qty-${reservation.id}`}
                                      name={line.name}
                                      value={quantityInput}
                                      max={editor.kind === "change" ? reservation.quantity + (canReserveNow ?? line.shortBy) : reservation.quantity - 1}
                                      disabled={busy}
                                      onChange={(value) => {
                                        setQuantityInput(value);
                                        setEditorError(null);
                                      }}
                                    />
                                  </>
                                )}
                                {(editor.kind === "release" ||
                                  editor.kind === "reduce" ||
                                  (editor.kind === "change" && Number(quantityInput) < reservation.quantity)) && (
                                  <label>
                                    {editor.kind === "release" ? "Why is it being released?" : "Why is it being reduced?"}
                                    <textarea
                                      value={reasonInput}
                                      maxLength={SERVER_TEXT_MAX_LENGTH}
                                      disabled={busy}
                                      onChange={(e) => {
                                        setReasonInput(e.target.value);
                                        setEditorError(null);
                                      }}
                                    />
                                  </label>
                                )}
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
                                    {busy
                                      ? "Saving..."
                                      : editor.kind === "release"
                                        ? "Release"
                                        : editor.kind === "change" && Number(quantityInput) > reservation.quantity
                                          ? `Reserve ${Number(quantityInput) - reservation.quantity} more`
                                          : "Reduce"}
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

                {reviewing && line.shortBy > 0 && markingId !== line.id && (
                  <div className="er-line-actions">
                    <form
                      className="er-quick"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleReserve(line, Number(reserveValue));
                      }}
                    >
                      {canReserveNow !== 0 && !editingThisLine && (
                        <div className="er-quick__reserve">
                          <label htmlFor={`er-qty-${line.id}`} className="er-quick__label">
                            {`How many ${line.name} to reserve?`}
                          </label>
                          <QuantityStepper
                            id={`er-qty-${line.id}`}
                            name={line.name}
                            value={reserveValue}
                            max={reserveMax}
                            disabled={busy}
                            onChange={(value) => {
                              setReserveQty((all) => ({ ...all, [line.id]: value }));
                              setReserveError(null);
                            }}
                          />
                          <button
                            type="submit"
                            className="er-btn er-btn--primary"
                            aria-label={`${reserveText}: ${line.name}`}
                            disabled={busy}
                          >
                            {busy ? "Saving..." : reserveText}
                          </button>
                        </div>
                      )}
                      {canReserveNow === 0 && (
                        <p className="equipment-review__muted">None can be reserved right now.</p>
                      )}
                      {canReserveNow !== null && canReserveNow > 0 && canReserveNow < line.shortBy && (
                        <p className="equipment-review__muted">{`Only ${canReserveNow} can be reserved right now.`}</p>
                      )}
                      {reserveError?.lineId === line.id && (
                        <p className="equipment-review__error" role="alert">
                          {reserveError.message}
                        </p>
                      )}
                      <div className="equipment-review__actions">
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
                    </form>
                  </div>
                )}

                {reviewing && markingId === line.id && (
                  <form className="equipment-review__form" noValidate onSubmit={(e) => handleMark(e, line)}>
                    <h4>{`${line.name} cannot be provided`}</h4>
                    <label>
                      {`Why can ${line.name} not be provided?`}
                      <textarea
                        value={markNote}
                        maxLength={SERVER_TEXT_MAX_LENGTH}
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
                </div>
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
                  <span aria-hidden="true">{done ? "\u2713" : "!"}</span>
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
          {shortLines.length === 0 ? (
            <p>
              Every line is fully reserved, so there is nothing to complete. The request is marked Arranged as soon
              as no reservation is flagged.
            </p>
          ) : !confirmingComplete ? (
            <button
              type="button"
              className="er-btn er-btn--primary"
              disabled={busy || flaggedTotal > 0}
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
                {`${shortLines.length} item${shortLines.length === 1 ? " is" : "s are"} not fully reserved. Each needs a "Cannot be provided" note, and the request will be marked Cannot be fully arranged. Reservations already made are kept.`}
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
