// BookingRequestPanel.jsx
//
// SCRUM-254 (part of SCRUM-243). The one "Request this venue" flow, for the
// event and venue it is given. Venue search mounts it today, and so does
// EventVenueFinder, the search inside the coordinator's event view; from
// there the suitability panel (SCRUM-191, VenueSuitabilityPanel) opens the
// same component, passing the result it already holds as `suitability`, so
// every entry point behaves identically.
//
// SCRUM-191: the optional `requirements` ({ layout, accessibility,
// facilities }) are the coordinator's requirement codes from EventVenueFinder,
// the same ones the suitability check was given. They are sent as
// roomLayoutCode, accessibility and facilities so the server's check on submit
// judges the coordinator's codes rather than "None requested". A blank layout
// and empty lists are left out of the body.
//
// What the coordinator sees and chooses:
//   - the event's own details, because they are what the request will carry:
//     the period, expected attendance and free-text requirements come from
//     the stored event on the server, never from this form;
//   - the venue;
//   - optional setup notes, the only free text sent.
//
// Suitability (N10) is computed by the server. When the venue fails it, a
// warning lists the criteria not met and the coordinator must tick an explicit
// confirmation before the request can be sent. That happens in two ways: up
// front, when the caller passes a `suitability` that says it failed, or after
// the first send, when the server answers SUITABILITY_CONFIRMATION_REQUIRED.
// Either way confirmUnsuitable is sent only once the box is ticked.
//
// SCRUM-188 review fixes:
//   - AC7: with confirmUnsuitable the request also sends acknowledgedCriteria,
//     the names of the unmet criteria this warning listed when the box was
//     ticked. The server accepts the override only when they cover every
//     criterion it finds unmet; if they no longer do, it answers
//     SUITABILITY_CONFIRMATION_REQUIRED again with its list, which replaces
//     this one and un-ticks the box, so the coordinator confirms what is true
//     now.
//   - AC4/AC7: Availability is never offered as something to override. A
//     venue whose period is taken cannot be requested, so the warning says so
//     in place of the box and the send stays disabled.
//   - AC2: "When" and the periods in "What is in the way" are Singapore wall
//     clock, marked "(Singapore time)", the same as the suitability result:
//     the server judged them on the venue's clock, whatever the device says.
//
// A request is sent once at a time: the button is disabled while saving, and a
// ref guards the handler, because state updates are not visible to a second
// click that lands before the next render.
//
// Presentational about the outcome: it calls onSubmitted(request) and
// onEventAlreadyRequested() and leaves refreshing whatever they show to the
// parent. data.error is never shown; see bookingRequestErrors.js.

import { useId, useRef, useState } from "react";
import { createBookingRequest } from "../services/bookingRequestService";
import {
  bookingRequestErrorMessage,
  fieldErrorsFrom,
  isEventAlreadyRequested,
  isSuitabilityConfirmationRequired,
  periodConflicts,
  unmetCriteria,
} from "../services/bookingRequestErrors";
import { shortId } from "../services/displayFormat";
import {
  formatVenuePeriod,
  formatVenueRange,
  VENUE_TIME_NOTE,
} from "../services/datetimeFormat";
import {
  bookingPaddingNote,
  formatOccupiedPeriod,
  requestPaddingNote,
} from "../services/occupiedPeriodDisplay";
import { criterionDetailText } from "../services/venueSuitabilityDisplay";

/** Mirrors bookings_setup_notes_length in migration 030. */
const SETUP_NOTES_MAX_LENGTH = 1000;

const NOTES_FIELDS = ["setupNotes"];

function orNotSpecified(value) {
  const text = typeof value === "string" ? value.trim() : value;
  return text ? text : "Not specified";
}

function failedCriteria(suitability) {
  const criteria = Array.isArray(suitability?.criteria) ? suitability.criteria : [];
  return criteria.filter((criterion) => criterion?.met === false);
}

function criterionText(criterion) {
  const name = criterion?.criterion || "A requirement";
  const detail = criterionDetailText(criterion);
  return detail ? `${name}: ${detail}` : name;
}

/** The criterion names a confirmation acknowledges, as the server reads them. */
function criterionNames(criteria) {
  return criteria
    .map((criterion) => criterion?.criterion)
    .filter((name) => typeof name === "string" && name !== "");
}

/** Availability is never overridable (see the header). */
function includesAvailability(criteria) {
  return criteria.some((criterion) => criterion?.criterion === "Availability");
}

/** A conflict's occupied period on the venue's clock, noted once. */
function venueOccupiedPeriod(conflict) {
  return `${formatOccupiedPeriod(conflict, formatVenueRange)} ${VENUE_TIME_NOTE}`;
}

/** SCRUM-191: the coordinator's codes as body fields, each only when set. */
function requirementsBody(requirements) {
  const { layout, accessibility, facilities } = requirements ?? {};
  return {
    ...(layout ? { roomLayoutCode: layout } : {}),
    ...(Array.isArray(accessibility) && accessibility.length > 0 ? { accessibility } : {}),
    ...(Array.isArray(facilities) && facilities.length > 0 ? { facilities } : {}),
  };
}

export default function BookingRequestPanel({
  event,
  venue,
  suitability,
  requirements,
  onSubmitted,
  onEventAlreadyRequested,
  onClose,
}) {
  const idPrefix = useId();
  const [setupNotes, setSetupNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // The criteria the server said were not met, once it has said so.
  const [serverCriteria, setServerCriteria] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [submitted, setSubmitted] = useState(null);
  const sending = useRef(false);

  const suitabilityFailed = suitability?.suitable === false;
  const needsConfirmation = suitabilityFailed || serverCriteria !== null;
  const unmet = serverCriteria ?? failedCriteria(suitability);
  const unavailable = needsConfirmation && includesAvailability(unmet);
  const notesTooLong = Array.from(setupNotes.trim()).length > SETUP_NOTES_MAX_LENGTH;
  const notesErrorId = `${idPrefix}-notes-error`;
  const notesMessages = [
    ...(notesTooLong ? [`Setup notes must be ${SETUP_NOTES_MAX_LENGTH} characters or fewer.`] : []),
    ...fieldErrors.map((d) => d.message),
  ];

  async function handleSubmit(e) {
    e.preventDefault();
    if (sending.current || submitted) return;
    if (notesTooLong) return;
    if (needsConfirmation && !confirmed) return;
    if (unavailable) return;

    sending.current = true;
    setSubmitting(true);
    setError(null);
    setConflicts([]);
    setFieldErrors([]);
    try {
      const request = await createBookingRequest({
        eventRequestId: event.id,
        venueId: venue.id,
        ...requirementsBody(requirements),
        ...(setupNotes.trim() ? { setupNotes: setupNotes.trim() } : {}),
        ...(needsConfirmation && confirmed
          ? { confirmUnsuitable: true, acknowledgedCriteria: criterionNames(unmet) }
          : {}),
      });
      setSubmitted(request);
      onSubmitted?.(request);
    } catch (err) {
      if (isSuitabilityConfirmationRequired(err)) {
        // Warn, and wait for the coordinator to tick the box and send again.
        setServerCriteria(unmetCriteria(err));
        setConfirmed(false);
      } else {
        setError(bookingRequestErrorMessage(err));
        setConflicts(periodConflicts(err));
        setFieldErrors(fieldErrorsFrom(err, NOTES_FIELDS));
        if (isEventAlreadyRequested(err)) onEventAlreadyRequested?.();
      }
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="booking-request" aria-label={`Request ${venue.name}`}>
      <h3>Request {venue.name}</h3>

      <dl className="booking-request__details">
        <dt>Event</dt>
        <dd>{event.eventName || "Unnamed event"}</dd>
        <dt>When</dt>
        <dd>{formatVenuePeriod(event.proposedStart, event.proposedEnd)}</dd>
        <dt>Expected attendance</dt>
        <dd>{event.expectedAttendance ?? "Not specified"}</dd>
        <dt>Venue requirements</dt>
        <dd>{orNotSpecified(event.venueRequirements)}</dd>
        <dt>Accessibility requirements</dt>
        <dd>{orNotSpecified(event.accessibilityRequirements)}</dd>
        <dt>Venue</dt>
        <dd>
          {venue.name}
          {venue.location ? `, ${venue.location}` : ""}
          {venue.maxCapacity != null ? `, seats up to ${venue.maxCapacity}` : ""}
        </dd>
      </dl>

      {submitted ? (
        <div className="booking-request__success" role="status">
          <p>
            Request sent to Venue Staff for {venue.name}. Its status is <strong>Pending</strong>.
          </p>
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <label className="booking-request__notes">
            Setup notes (optional)
            <textarea
              value={setupNotes}
              onChange={(e) => {
                setSetupNotes(e.target.value);
                setFieldErrors([]);
              }}
              rows={3}
              disabled={submitting}
              aria-invalid={notesMessages.length > 0 ? "true" : undefined}
              aria-describedby={notesMessages.length > 0 ? notesErrorId : undefined}
            />
          </label>
          {notesMessages.length > 0 && (
            <ul className="booking-request__field-error" id={notesErrorId}>
              {notesMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}

          {needsConfirmation && (
            <div className="booking-request__warning" role="alert">
              <h4>This venue does not meet this event&apos;s requirements</h4>
              {unmet.length > 0 && (
                <ul>
                  {unmet.map((criterion, i) => (
                    <li key={`${criterion?.criterion ?? "criterion"}-${i}`}>{criterionText(criterion)}</li>
                  ))}
                </ul>
              )}
              {unavailable ? (
                <p className="booking-request__unavailable">
                  This venue is not available for this event&apos;s period, so it can&apos;t be
                  requested. Choose another venue.
                </p>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    disabled={submitting}
                  />
                  I understand this venue does not meet the requirements and want to request it anyway
                </label>
              )}
            </div>
          )}

          {error && (
            <p className="booking-request__error" role="alert">
              {error}
            </p>
          )}

          {conflicts.length > 0 && (
            <ul className="booking-request__conflicts" aria-label="What is in the way">
              {conflicts.map((conflict, i) => {
                if (conflict.kind === "block") {
                  // The venue's setup and turnaround around this event count
                  // against a block too, so say when they were part of it.
                  const note = requestPaddingNote(conflict);
                  return (
                    <li key={conflict.blockId ?? i}>
                      <strong>Blocked</strong>
                      <span>{formatVenuePeriod(conflict.startsAt, conflict.endsAt)}</span>
                      {note && <span className="booking-request__conflict-note">{note}</span>}
                    </li>
                  );
                }
                // The same minutes pad this event against a booking too: a
                // request can clash with a turnaround that ended before it
                // starts, because its own setup reaches back into it.
                // SCRUM-491 (AC5): another event's tentative hold occupies
                // the venue the same way, so it reads the same, labelled.
                const bookingNote = bookingPaddingNote(conflict);
                const held = conflict.kind === "hold";
                return (
                  <li key={(held ? conflict.holdId : conflict.bookingId) ?? i}>
                    {held && <strong>Tentatively held</strong>}
                    <strong>{conflict.eventName || "Unnamed event"}</strong>
                    <span>{venueOccupiedPeriod(conflict)}</span>
                    {bookingNote && (
                      <span className="booking-request__conflict-note">{bookingNote}</span>
                    )}
                    {conflict.eventRequestId && (
                      <code title={conflict.eventRequestId}>{shortId(conflict.eventRequestId)}</code>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="booking-request__actions">
            <button
              type="submit"
              disabled={submitting || notesTooLong || unavailable || (needsConfirmation && !confirmed)}
            >
              {submitting ? "Requesting..." : "Request this venue"}
            </button>
            {onClose && (
              <button type="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
