// EventDetailsEditPanel.jsx
//
// SCRUM-387 (SCRUM-391): the assigned coordinator edits an event's information
// directly, opened as a page in place of CoordinatorRequestDetail as Revise
// event details is. In review every field shows; in planning and the safety
// check only the ordinary ones, the rest being SCRUM-395's.
//
// The values are snapshotted when the panel opens and never re-read from the
// prop: they are what the coordinator saw, and the server refuses a save whose
// `expected` no longer matches what it holds (AC9). Only altered fields are
// sent, so a name edit is never a significant one.

import { useId, useState } from "react";
import { updateEventRequestDetails } from "../services/eventRequestService";
import { SESSION_EXPIRED, fieldErrorsFrom, makeErrorMapper } from "../services/apiErrors";
import {
  deviceTimeZoneLabel,
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";
import {
  DETAIL_FIELD_LABELS,
  STATUSES_ALLOWING_ANY_EDIT,
  editableDetailFields,
} from "../services/eventDetailFields";
import { fieldErrorWiring } from "./fieldErrors";

// The server's limit, counted as it counts: in characters, not UTF-16 units.
const REASON_MAX_LENGTH = 4000;
const TIMESTAMP_FIELDS = ["proposedStart", "proposedEnd"];

// The controls EventRequestForm gives the Organiser for the same fields.
const CONTROLS = {
  eventName: { type: "text" },
  purpose: { rows: 2 },
  description: { rows: 3 },
  proposedStart: { type: "datetime-local" },
  proposedEnd: { type: "datetime-local" },
  expectedAttendance: { type: "number", min: "1" },
  venueRequirements: { rows: 3 },
  accessibilityRequirements: { rows: 2 },
  equipmentRequirements: { rows: 2 },
};

const errorMessage = makeErrorMapper({
  codeMessages: {
    EVENT_CHANGED_SINCE_OPENED:
      "Someone changed this event after you opened the form. Go back to see the current details, then make your change again.",
    SIGNIFICANT_CHANGE_REQUIRED:
      "This event has been approved since you opened the form, so its date, time, attendance, requirements and equipment can no longer be edited here. Go back and use Revise event details.",
    EVENT_CONFIRMED:
      "This event has been confirmed since you opened the form, so it can no longer be edited here. Go back and use Revise event details.",
    EVENT_STATUS_NOT_ALLOWED:
      "This event's status has changed since you opened the form, and it can no longer be edited. Go back to see where it stands.",
    EVENT_HOLDS_ARRANGEMENTS:
      "This request still holds venue bookings, holds or equipment from before it was reopened. Release them, or approve the request and use Revise event details, before changing the date, time, attendance, requirements or equipment. The name, purpose and description can still be saved on their own.",
  },
  statusMessages: {
    400: "These changes could not be saved as written. Check each field and the reason, then try again.",
    401: SESSION_EXPIRED,
    403: "You're no longer the coordinator for this event.",
  },
  notFoundMessages: { save: "This event can't be found. It may have been removed." },
  defaultMessages: { save: "Your changes could not be saved. Please try again." },
  unknownConflictMessage:
    "This event has changed since you opened the form. Go back to see the current details, then try again.",
});

/** A stored value as its control holds it. */
function toFormValue(field, stored) {
  if (TIMESTAMP_FIELDS.includes(field)) return toDatetimeLocalValue(stored);
  if (stored === null || stored === undefined) return "";
  return String(stored);
}

/** A control's value as compared for "altered": trimmed, and blank is null. */
function normalised(value) {
  const text = value.trim();
  return text === "" ? null : text;
}

/** A control's value as sent. A cleared box is null, as the server stores it. */
function toWireValue(field, value) {
  const text = normalised(value);
  if (text === null) return null;
  if (TIMESTAMP_FIELDS.includes(field)) return toOffsetIsoString(text);
  if (field === "expectedAttendance") return Number(text);
  return text;
}

/**
 * @param {object} props
 * @param {object} props.eventRequest  the event as the detail holds it when the panel opens
 * @param {() => void} props.onBack
 * @param {(saved: object) => void} props.onSaved  the event, with changedFields
 */
export default function EventDetailsEditPanel({ eventRequest, onBack, onSaved }) {
  const idPrefix = useId();
  const [opened] = useState(() => {
    const fields = editableDetailFields(eventRequest.status);
    return {
      fields,
      allFields: STATUSES_ALLOWING_ANY_EDIT.includes(eventRequest.status),
      stored: Object.fromEntries(fields.map((field) => [field, eventRequest[field] ?? null])),
      shown: Object.fromEntries(fields.map((field) => [field, toFormValue(field, eventRequest[field])])),
    };
  });
  const [form, setForm] = useState(opened.shown);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [clientErrors, setClientErrors] = useState([]);
  const [serverErrors, setServerErrors] = useState([]);

  const reasonLength = Array.from(reason).length;
  const { messagesFor, errorId, ariaFor } = fieldErrorWiring(idPrefix, [...clientErrors, ...serverErrors]);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave(event) {
    event.preventDefault();
    if (saving) return;

    const altered = opened.fields.filter(
      (field) => normalised(form[field]) !== normalised(opened.shown[field]),
    );
    if (altered.length === 0) {
      setMessage("There is nothing to save: no field has changed.");
      return;
    }
    const trimmedReason = reason.trim();
    const errors = [];
    if (!trimmedReason) errors.push({ field: "reason", message: "A reason is required." });
    if (reasonLength > REASON_MAX_LENGTH) {
      errors.push({ field: "reason", message: "The reason must be 4,000 characters or fewer." });
    }
    setClientErrors(errors);
    setServerErrors([]);
    if (errors.length > 0) {
      setMessage(null);
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const saved = await updateEventRequestDetails(eventRequest.id, {
        changes: Object.fromEntries(altered.map((field) => [field, toWireValue(field, form[field])])),
        expected: Object.fromEntries(altered.map((field) => [field, opened.stored[field]])),
        reason: trimmedReason,
      });
      onSaved?.(saved);
    } catch (err) {
      const faults = fieldErrorsFrom(err, [...opened.fields, "reason"]);
      setServerErrors(faults);
      setMessage(faults.length > 0
        ? "Some details need correcting. Nothing has been saved."
        : errorMessage(err, "save"));
    } finally {
      setSaving(false);
    }
  }

  function renderFieldErrors(field) {
    const messages = messagesFor(field);
    if (messages.length === 0) return null;
    return (
      <ul className="event-details-edit__field-error" id={errorId(field)}>
        {messages.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    );
  }

  function renderControl(field) {
    const { rows, ...inputProps } = CONTROLS[field];
    const props = {
      value: form[field],
      onChange: (e) => update(field, e.target.value),
      ...ariaFor(field),
    };
    return (
      <div key={field} className="event-details-edit__field">
        <label>
          {DETAIL_FIELD_LABELS[field]}
          {rows ? <textarea rows={rows} {...props} /> : <input {...inputProps} {...props} />}
        </label>
        {renderFieldErrors(field)}
      </div>
    );
  }

  return (
    <main className="event-details-edit-page">
      <button className="event-cancellation-page__back" type="button" onClick={onBack}>
        Back to event
      </button>
      <p className="eyebrow">Coordinator action</p>
      <h1>Edit event information: {eventRequest.eventName}</h1>
      <section className="event-details-edit">
        {!opened.allFields && (
          <p className="event-details-edit__notice">
            The date, time, attendance, requirements and equipment are changed through Revise event details.
          </p>
        )}
        <form onSubmit={handleSave} noValidate>
          {opened.fields.map(renderControl)}
          {opened.fields.includes("proposedStart") && (
            <p className="event-details-edit__hint">
              Times are in your device&apos;s time zone ({deviceTimeZoneLabel()}).
            </p>
          )}
          <div className="event-details-edit__field">
            <label>
              Reason for this change
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setClientErrors((prev) => prev.filter((err) => err.field !== "reason"));
                }}
                {...ariaFor("reason")}
              />
            </label>
            <p className="event-details-edit__counter" aria-live="polite">
              {reasonLength.toLocaleString("en-US")} / 4,000 characters
            </p>
            {renderFieldErrors("reason")}
          </div>
          {message && <p className="event-details-edit__message" role="alert">{message}</p>}
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </form>
      </section>
    </main>
  );
}
