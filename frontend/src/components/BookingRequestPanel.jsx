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
//     the period and free-text requirements come from the stored event on the
//     server, never from this form;
//   - the venue;
//   - SCRUM-525 (AC2): the expected attendance for this venue. It belongs to
//     the request, not the event, because one event can now use several
//     venues at once, each for part of its audience. It is prefilled from the
//     event's expected attendance, stays editable, must be a whole number of
//     1 or more, and is always sent as expectedAttendance, so the number the
//     server checks and stores is the one on screen. The event's own number
//     stays in the details list beside it, labelled as the event's;
//   - optional setup notes, the only free text sent.
//
// SCRUM-525 (AC3): the suitability verdict must be for the number that will
// be sent, or the coordinator would confirm one Capacity verdict and the
// server would judge another. So committing a new attendance (blur or Enter
// in the field, or a send while the field holds an unchecked number) checks
// this venue again with { attendance } and the answer replaces the verdict on
// screen. Committing resets the confirmation, because a tick given for the
// old number does not cover the new one, and while the check runs the warning
// and the box are hidden and the send is disabled. Each check takes a
// sequence number and only the latest one's answer is applied, so a slow
// answer for an older number can never overwrite a newer one. A failed check
// says so and leaves the send enabled: the server checks again on submit and
// is the gate. All of this runs from event handlers, never an effect.
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
// onVenueAlreadyRequested(code) and leaves refreshing whatever they show to
// the parent. SCRUM-525: the code is BOOKING_REQUEST_EXISTS or
// BOOKING_FLAGGED_FOR_REVIEW, and either means this venue (not the event)
// already has a live request; the parent knows which venue it opened this
// panel for. data.error is never shown; see bookingRequestErrors.js.

import { useId, useRef, useState } from "react";
import { createBookingRequest } from "../services/bookingRequestService";
import {
  bookingRequestErrorMessage,
  fieldErrorsFrom,
  isSuitabilityConfirmationRequired,
  isVenueAlreadyRequested,
  periodConflicts,
  unmetCriteria,
} from "../services/bookingRequestErrors";
import { checkVenueSuitability } from "../services/venueSuitabilityService";
import { suitabilityErrorMessage } from "../services/venueSuitabilityErrors";
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

/** The fields of this form a 400's details[] can be shown beside. */
const FORM_FIELDS = ["setupNotes", "expectedAttendance"];

/**
 * SCRUM-525: the attendance text as the number to send, or null when it is
 * not one. The same rule as the server's: digits only (no sign, decimal point
 * or exponent, which a number input would otherwise let through), at least 1,
 * and small enough to be exact.
 */
function parseAttendance(text) {
  const trimmed = String(text ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

/** Why the attendance text is not a number to send, or null when it is. */
function attendanceProblem(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return "Enter the expected attendance for this venue.";
  // A sign is allowed here only so that 0 and -5 are told the real problem.
  if (!/^-?\d+$/.test(trimmed)) return "Expected attendance must be a whole number.";
  if (Number(trimmed) < 1) return "Expected attendance must be at least 1.";
  // Too many digits to be exact is not a number anyone means.
  if (parseAttendance(trimmed) === null) return "Expected attendance must be a whole number.";
  return null;
}

/** The event's attendance as the field's first text: blank when it has none. */
function attendanceSeed(event) {
  const n = event?.expectedAttendance;
  return Number.isInteger(n) ? String(n) : "";
}

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
  onVenueAlreadyRequested,
  onClose,
}) {
  const idPrefix = useId();
  const [setupNotes, setSetupNotes] = useState("");
  // SCRUM-525. The attendance as typed, seeded once from the event.
  const [attendanceText, setAttendanceText] = useState(() => attendanceSeed(event));
  // The number the verdict on screen was judged for: what the caller's check
  // echoed, else the event's (the number a check without one judges).
  const [judgedAttendance, setJudgedAttendance] = useState(
    () => suitability?.checked?.expectedAttendance ?? parseAttendance(attendanceSeed(event)),
  );
  // This panel's own check, once the attendance has been changed (see the
  // header). 'idle' means the caller's `suitability` still stands.
  const [recheck, setRecheck] = useState({ status: "idle", result: null, error: null });
  const recheckSeq = useRef(0);
  const [confirmed, setConfirmed] = useState(false);
  // The criteria the server said were not met, once it has said so.
  const [serverCriteria, setServerCriteria] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [submitted, setSubmitted] = useState(null);
  const sending = useRef(false);

  const attendance = parseAttendance(attendanceText);
  const checking = recheck.status === "checking";
  // The verdict on screen: this panel's own check once it has answered, the
  // caller's until the attendance changes, and none while checking or after
  // a failed check, so a verdict for another number is never shown.
  let active = null;
  if (recheck.status === "done") active = recheck.result;
  else if (recheck.status === "idle") active = suitability;
  const needsConfirmation = active?.suitable === false || serverCriteria !== null;
  const unmet = serverCriteria ?? failedCriteria(active);
  const unavailable = needsConfirmation && includesAvailability(unmet);
  const notesTooLong = Array.from(setupNotes.trim()).length > SETUP_NOTES_MAX_LENGTH;
  const notesErrorId = `${idPrefix}-notes-error`;
  const notesMessages = [
    ...(notesTooLong ? [`Setup notes must be ${SETUP_NOTES_MAX_LENGTH} characters or fewer.`] : []),
    ...fieldErrors.filter((d) => d.field === "setupNotes").map((d) => d.message),
  ];
  const attendanceProblemText = attendanceProblem(attendanceText);
  const attendanceErrorId = `${idPrefix}-attendance-error`;
  const attendanceHintId = `${idPrefix}-attendance-hint`;
  const attendanceMessages = [
    ...(attendanceProblemText ? [attendanceProblemText] : []),
    ...fieldErrors.filter((d) => d.field === "expectedAttendance").map((d) => d.message),
  ];

  /** Editing a field retires the server's messages for that field only. */
  function clearFieldErrors(field) {
    setFieldErrors((prev) => prev.filter((d) => d.field !== field));
  }

  /**
   * SCRUM-525 (AC3): checks this venue again for the attendance in the field,
   * when it is a valid number other than the one already judged. Returns
   * whether a check started, so a send can stop and let the coordinator see
   * the new verdict first. See the header for why it resets the confirmation
   * and keeps only the latest answer.
   */
  function commitAttendance() {
    const n = parseAttendance(attendanceText);
    if (n === null || n === judgedAttendance) return false;

    recheckSeq.current += 1;
    const seq = recheckSeq.current;
    setJudgedAttendance(n);
    setServerCriteria(null);
    setConfirmed(false);
    setRecheck({ status: "checking", result: null, error: null });
    checkVenueSuitability(event.id, venue.id, requirements ?? {}, { attendance: n })
      .then((result) => {
        if (seq === recheckSeq.current) setRecheck({ status: "done", result, error: null });
      })
      .catch((err) => {
        if (seq === recheckSeq.current) {
          setRecheck({ status: "error", result: null, error: suitabilityErrorMessage(err) });
        }
      });
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (sending.current || submitted) return;
    if (attendance === null) return;
    if (checking) return;
    // An attendance typed but not yet checked is checked first; the
    // coordinator sends once the verdict for it is on screen.
    if (commitAttendance()) return;
    if (notesTooLong) return;
    if (needsConfirmation && !confirmed) return;

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
        // Always sent, so the server never falls back to the event's number
        // when the coordinator kept it (SCRUM-525, AC2).
        expectedAttendance: attendance,
        ...(setupNotes.trim() ? { setupNotes: setupNotes.trim() } : {}),
        // The names come from the verdict on screen, which is the one for
        // the attendance being sent.
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
        setFieldErrors(fieldErrorsFrom(err, FORM_FIELDS));
        if (isVenueAlreadyRequested(err)) onVenueAlreadyRequested?.(err.response.data.code);
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
        {/* SCRUM-525: the event's number, beside the per-venue field below. */}
        <dt>Event&apos;s expected attendance</dt>
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
          <label className="booking-request__attendance">
            Expected attendance for this venue
            <input
              type="number"
              min="1"
              step="1"
              value={attendanceText}
              onChange={(e) => {
                setAttendanceText(e.target.value);
                clearFieldErrors("expectedAttendance");
              }}
              onBlur={commitAttendance}
              onKeyDown={(e) => {
                // Enter means "use this number": it checks it, and never
                // sends a request for a number whose verdict is not shown.
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitAttendance();
                }
              }}
              disabled={submitting}
              aria-invalid={attendanceMessages.length > 0 ? "true" : undefined}
              aria-describedby={
                attendanceMessages.length > 0 ? `${attendanceErrorId} ${attendanceHintId}` : attendanceHintId
              }
            />
          </label>
          <p className="booking-request__hint" id={attendanceHintId}>
            Prefilled with the event&apos;s expected attendance. Changing it checks this venue again.
          </p>
          {attendanceMessages.length > 0 && (
            <ul className="booking-request__field-error" id={attendanceErrorId}>
              {attendanceMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}

          <label className="booking-request__notes">
            Setup notes (optional)
            <textarea
              value={setupNotes}
              onChange={(e) => {
                setSetupNotes(e.target.value);
                clearFieldErrors("setupNotes");
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

          {checking && (
            <p className="booking-request__checking" role="status">
              Checking {venue.name} for {judgedAttendance} people…
            </p>
          )}

          {recheck.status === "error" && (
            <p className="booking-request__error" role="alert">
              {`${recheck.error} It will be checked again when you send the request.`}
            </p>
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
              disabled={
                submitting ||
                checking ||
                attendance === null ||
                notesTooLong ||
                unavailable ||
                (needsConfirmation && !confirmed)
              }
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
