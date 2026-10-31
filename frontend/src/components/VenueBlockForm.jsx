// VenueBlockForm.jsx
//
// SCRUM-126 (part of SCRUM-17, AC1): "a block is created with venue,
// start/end datetime, reason category". Create and edit in one component, the
// way VenueForm and EventRequestForm do it -- `initialBlock` is the only thing
// that differs, and null means create.
//
// Presentational on purpose. It calls no service: the parent owns the request,
// passes `submitting`, and hands back what the API said as `serverErrors`
// (the { field, message } details[]) and `formError` (anything else).
// VenueBlocksPanel (SCRUM-127) is that parent.
//
// onDatesChanged and onDetailsChanged tell the parent a field moved, so it can
// drop a conflict list computed for the old values: an override must resend
// exactly what the Venue Staff member last looked at (AC3).
//
// Form state is initialised once, from initialBlock, inside useState. There is
// deliberately no prefill effect: the parent already has the block when it
// renders this, so an effect would only add a render with empty fields and a
// set-state-in-effect warning. To show a different block, the parent re-keys
// the form (key={block.id}), which starts it fresh.

import { useId, useState } from "react";
import {
  deviceTimeZoneLabel,
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";
import { VENUE_BLOCK_REASONS, reasonLabel } from "../services/venueBlockReasons";
import {
  NOTES_MAX_LENGTH,
  buildBlockChanges,
  validateBlockInput,
} from "../services/venueBlockValidation";
import { codePointLength } from "../services/venueSafetyFacts";
import { fieldErrorWiring } from "./fieldErrors";
import Button from "./ui/Button";

/** The fields that render their own errors. Anything else goes in the alert. */
const FIELDS = ["startsAt", "endsAt", "reason", "notes"];

const KNOWN_REASON_CODES = new Set(VENUE_BLOCK_REASONS.map((r) => r.code));

function initialForm(block) {
  return {
    startsAt: toDatetimeLocalValue(block?.startsAt),
    endsAt: toDatetimeLocalValue(block?.endsAt),
    reason: block?.reason ?? "",
    notes: block?.notes ?? "",
  };
}

export default function VenueBlockForm({
  initialBlock = null,
  onSubmit,
  onCancel,
  submitting = false,
  serverErrors = [],
  formError,
  onDatesChanged,
  onDetailsChanged,
}) {
  const isEdit = Boolean(initialBlock);
  const idPrefix = useId();

  const [form, setForm] = useState(() => initialForm(initialBlock));
  const [clientErrors, setClientErrors] = useState([]);
  const [notice, setNotice] = useState(null);

  const allErrors = [...clientErrors, ...serverErrors];
  const unmatchedServerErrors = serverErrors.filter((err) => !FIELDS.includes(err.field));

  const { messagesFor, errorId, ariaFor } = fieldErrorWiring(idPrefix, allErrors);

  function updateField(field, value) {
    const next = { ...form, [field]: value };
    setForm(next);
    // Editing a field retires its client errors; the rest stay until the next
    // submit. Server errors are the parent's to clear.
    setClientErrors((prev) => prev.filter((err) => err.field !== field));
    setNotice(null);

    // Only the dates: SCRUM-125 previews conflicts for a period, and a reason
    // or notes change cannot move one.
    if (field === "startsAt" || field === "endsAt") {
      onDatesChanged?.({
        startsAt: toOffsetIsoString(next.startsAt),
        endsAt: toOffsetIsoString(next.endsAt),
      });
    }

    // Separate from onDatesChanged so that callback keeps meaning "the period
    // moved". A reason or notes change cannot alter which bookings conflict,
    // but it does change what an override would save.
    if (field === "reason" || field === "notes") {
      onDetailsChanged?.();
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return; // closes the double-click window before it opens

    setNotice(null);

    if (!isEdit) {
      const errors = validateBlockInput(form, { requireFutureEnd: true });
      setClientErrors(errors);
      if (errors.length > 0) return;

      const notes = form.notes.trim();
      onSubmit?.({
        startsAt: toOffsetIsoString(form.startsAt),
        endsAt: toOffsetIsoString(form.endsAt),
        reason: form.reason,
        ...(notes === "" ? {} : { notes }),
      });
      return;
    }

    // The future-end rule applies only when the end moved. A notes-only edit
    // on a block whose end has since passed is not the user's fault.
    const endChanged = form.endsAt !== toDatetimeLocalValue(initialBlock.endsAt);
    const errors = validateBlockInput(form, { requireFutureEnd: endChanged }).filter(
      // A reason this build does not know, carried over unchanged from the
      // stored block, is the backend's vocabulary and not a user mistake.
      (err) => !(err.field === "reason" && form.reason === initialBlock.reason),
    );
    setClientErrors(errors);
    if (errors.length > 0) return;

    const changes = buildBlockChanges(form, initialBlock);
    if (Object.keys(changes).length === 0) {
      setNotice("Nothing has changed, so there is nothing to save.");
      return;
    }

    onSubmit?.(changes);
  }

  function renderFieldErrors(field) {
    const messages = messagesFor(field);
    if (messages.length === 0) return null;
    return (
      <ul className="venue-block-form__field-error" id={errorId(field)}>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    );
  }

  // A reason on the stored block that this build has never heard of is shown
  // as an option rather than silently replaced by the placeholder.
  const unknownReason =
    initialBlock?.reason && !KNOWN_REASON_CODES.has(initialBlock.reason)
      ? initialBlock.reason
      : null;

  const notesRequired = form.reason === "other";
  const showAlert = Boolean(formError) || unmatchedServerErrors.length > 0;

  return (
    <form className="venue-block-form" onSubmit={handleSubmit} noValidate>
      <h2>{isEdit ? "Change this block" : "Block this venue"}</h2>

      {showAlert && (
        <div className="venue-block-form__error" role="alert">
          {formError && <p>{formError}</p>}
          {unmatchedServerErrors.length > 0 && (
            <ul>
              {unmatchedServerErrors.map((err, i) => (
                <li key={i}>
                  {err.field ? `${err.field}: ` : ""}
                  {err.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="venue-block-form__row">
        <div>
          <label>
            Start
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => updateField("startsAt", e.target.value)}
              disabled={submitting}
              {...ariaFor("startsAt")}
            />
          </label>
          {renderFieldErrors("startsAt")}
        </div>

        <div>
          <label>
            End
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => updateField("endsAt", e.target.value)}
              disabled={submitting}
              {...ariaFor("endsAt")}
            />
          </label>
          {renderFieldErrors("endsAt")}
        </div>
      </div>

      {/* Disclosure, not a picker -- the same wording EventRequestForm uses. */}
      <p className="venue-block-form__hint">
        Times are in your device's time zone ({deviceTimeZoneLabel()}).
      </p>

      <div>
        <label>
          Reason
          <select
            value={form.reason}
            onChange={(e) => updateField("reason", e.target.value)}
            disabled={submitting}
            {...ariaFor("reason")}
          >
            <option value="" disabled>
              Choose a reason
            </option>
            {VENUE_BLOCK_REASONS.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.label}
              </option>
            ))}
            {unknownReason && (
              <option value={unknownReason}>
                {reasonLabel(unknownReason)} (unrecognised reason)
              </option>
            )}
          </select>
        </label>
        {renderFieldErrors("reason")}
      </div>

      <div>
        <label>
          {notesRequired ? "Notes (required for Other)" : "Notes (optional)"}
          {/*
            No maxLength. The browser counts maxLength in UTF-16 units, so an
            emoji would use up two of the thousand while Postgres length()
            counts it once -- the limit would be stricter here than anywhere
            else. The counter and the validator both count code points.
          */}
          <textarea
            value={form.notes}
            onChange={(e) => updateField("notes", e.target.value)}
            rows={3}
            disabled={submitting}
            {...ariaFor("notes")}
          />
        </label>
        <p className="venue-block-form__help">
          {codePointLength(form.notes)}/{NOTES_MAX_LENGTH}
        </p>
        {renderFieldErrors("notes")}
      </div>

      {notice && (
        <p className="venue-block-form__notice" role="status">
          {notice}
        </p>
      )}

      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving..." : isEdit ? "Save changes" : "Block venue"}
      </Button>
      {onCancel && (
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      )}
    </form>
  );
}
