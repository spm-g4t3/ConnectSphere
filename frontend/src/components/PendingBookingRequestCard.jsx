// PendingBookingRequestCard.jsx
//
// SCRUM-258: one request in Venue Staff's pending queue. Collapsed, a single
// row (event, venue, period, status); expanded, everything AC1 asks Venue
// Staff to weigh, and the approve and reject controls.
//
// Holds only the reject form's drafts. Whether it is expanded, whether a
// decision is in flight and what went wrong belong to PendingBookingRequests,
// which owns the queue and refetches it after every decision.

import { useState } from "react";
import BookingSuitabilitySummary from "./BookingSuitabilitySummary";
import Button from "./ui/Button";
import ErrorNotice from "./ui/ErrorNotice";
import StatusBadge from "./ui/StatusBadge";
import { BOOKABLE_EVENT_STATUSES, statusLabel } from "../services/bookingRequestEligibility";
import { readBookingStatusDisplay } from "../services/bookingRequestStatusDisplay";
import { BOOKING_GROUP_TONES, toneFor } from "../services/venueStatusTones";
import { formatDateTime } from "../services/displayFormat";
import { capitalise, replacesFlaggedBookingText } from "../services/flaggedBookingDisplay";
import { VENUE_TIME_NOTE, formatVenuePeriod, formatVenueRange } from "../services/datetimeFormat";
import { formatOccupiedPeriod, occupiedPeriodParts } from "../services/occupiedPeriodDisplay";
import { labelFor } from "../services/venueSuitabilityDisplay";
import { ROOM_LAYOUTS } from "../services/venueLookups";
import { SERVER_TEXT_MAX_LENGTH } from "../services/textLimits";

const CONFLICTING = "conflicting";

// Untrimmed, unlike displayFormat's orNotSpecified: these rows have always
// shown the text exactly as stored.
function orNotSpecified(value) {
  return value || "Not specified";
}

/**
 * The period the booking would hold the venue for. Overlaps and conflicts are
 * judged on this, not the event's own times, so it is said outright.
 */
function occupiedText(item) {
  const padding = occupiedPeriodParts(item)
    .map((part) => part.label)
    .filter((label) => label !== "Event");
  if (padding.length === 0) return "The event's own times; this venue needs no setup or turnaround.";
  const parts = padding.map((label) => label.toLowerCase()).join(" and ");
  return `${formatVenueRange(item.occupiedStartsAt, item.occupiedEndsAt)} ${VENUE_TIME_NOTE}, including ${parts}`;
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

/**
 * Why a conflicting request is flagged. conflictingWith lists the bookings in
 * the way now; it empties when they go, but the status never reverts, so the
 * empty case has to say the clash is gone rather than name nothing.
 */
function conflictingNote(conflictingWith) {
  if (conflictingWith.length === 0) {
    return "The booking this request clashed with is no longer in the way, so it can now be approved.";
  }
  const named = conflictingWith.map((other) => ({
    name: other.eventName || "Unnamed event",
    period: formatVenuePeriod(other.startsAt, other.endsAt),
  }));
  if (named.length === 1) {
    return (
      `${named[0].name} was approved at this venue for ${named[0].period}. ` +
      "This request can't be approved while that booking stands; it can be rejected, or left for the coordinator to withdraw."
    );
  }
  const list = named.map(({ name, period }) => `${name}, ${period}`).join("; ");
  return (
    `These events were approved at this venue for overlapping times: ${list}. ` +
    "This request can't be approved while those bookings stand; it can be rejected, or left for the coordinator to withdraw."
  );
}

export default function PendingBookingRequestCard({
  item,
  expanded,
  onToggle,
  busy,
  marksOnApproval,
  deciding,
  error,
  onRetry,
  onApprove,
  onReject,
}) {
  const [reason, setReason] = useState("");
  const [alternative, setAlternative] = useState("");
  const [reasonError, setReasonError] = useState(null);

  const display = readBookingStatusDisplay(item);
  const overlapping = Array.isArray(item.overlapping) ? item.overlapping : [];
  const conflictingWith = Array.isArray(item.conflictingWith) ? item.conflictingWith : [];
  const eventName = item.eventName || "Unnamed event";
  const venueName = item.venueName || "Unknown venue";
  const regionId = `pending-booking-${item.id}`;
  const conflictingNoteId = `${regionId}-conflicting`;
  const eventNoteId = `${regionId}-event-status`;

  // Hints only, so Venue Staff are not offered a refusal the server is certain
  // to give (EVENT_NOT_BOOKABLE, BOOKING_PERIOD_CONFLICT); it re-checks both
  // under lock. A missing eventStatus does not block: the server still guards.
  const eventNotBookable =
    typeof item.eventStatus === "string" &&
    item.eventStatus !== "" &&
    !BOOKABLE_EVENT_STATUSES.includes(item.eventStatus);
  const blockedByBooking = item.status === CONFLICTING && conflictingWith.length > 0;
  const approveBlockedBy = eventNotBookable ? eventNoteId : blockedByBooking ? conflictingNoteId : undefined;
  const reasonId = `${regionId}-reason`;
  const reasonErrorId = `${regionId}-reason-error`;

  function handleReject(e) {
    e.preventDefault();
    const trimmed = reason.trim();
    // A blank reason tells the coordinator nothing (AC4); the server refuses it too.
    if (!trimmed) {
      setReasonError("Enter a reason for rejecting this request.");
      return;
    }
    setReasonError(null);
    onReject(item, { reason: trimmed, suggestedAlternative: alternative.trim() });
  }

  return (
    <li className="pending-bookings__card">
      {/* Locked while any decision is in flight, so the deciding card stays
          open and a refusal shown inside it is not lost to another card.
          A native button: it is a disclosure row, not an action, so Button would restyle it. */}
      <button
        type="button"
        className="pending-bookings__toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        disabled={busy}
        onClick={() => onToggle(item.id)}
      >
        <strong>{eventName}</strong>
        <span>{venueName}</span>
        <span>{formatVenuePeriod(item.startsAt, item.endsAt)}</span>
        <StatusBadge tone={toneFor(BOOKING_GROUP_TONES, display.group)}>{display.label}</StatusBadge>
      </button>

      {expanded && (
        <div id={regionId} role="region" aria-label={`${eventName} at ${venueName}`} className="pending-bookings__detail">
          {eventNotBookable && (
            <p id={eventNoteId} className="pending-bookings__event-status">
              This request can't be approved because the event is {statusLabel(item.eventStatus)}. It can
              be rejected.
            </p>
          )}
          {/* Said before Approve, as approving also cancels the flagged booking. */}
          {item.replaces && (
            <p className="pending-bookings__event-status">{replacesFlaggedBookingText(item.replaces)}</p>
          )}
          {item.status === CONFLICTING && (
            <p id={conflictingNoteId} className="pending-bookings__conflicting">
              {conflictingNote(conflictingWith)}
            </p>
          )}

          <dl>
            <dt>Event status</dt>
            <dd>{capitalise(statusLabel(item.eventStatus))}</dd>
            <dt>Venue</dt>
            <dd>
              {venueName}
              {item.venueLocation ? `, ${item.venueLocation}` : ""}
            </dd>
            <dt>Occupies</dt>
            <dd>
              {occupiedText(item)}
              {occupiedPeriodParts(item).length > 1 && (
                <span className="pending-bookings__breakdown">
                  {formatOccupiedPeriod(item, formatVenueRange)}
                </span>
              )}
            </dd>
            <dt>Expected attendance</dt>
            <dd>{item.expectedAttendance ?? "Not specified"}</dd>
            <dt>Room layout</dt>
            <dd>{item.roomLayoutCode ? labelFor(item.roomLayoutCode, ROOM_LAYOUTS) : "None requested"}</dd>
            <dt>Venue requirements</dt>
            <dd>{orNotSpecified(item.venueRequirements)}</dd>
            <dt>Accessibility requirements</dt>
            <dd>{orNotSpecified(item.accessibilityRequirements)}</dd>
            <dt>Setup notes</dt>
            <dd>{orNotSpecified(item.setupNotes)}</dd>
            <dt>Requested</dt>
            <dd>{formatDateTime(item.createdAt, "at an unknown time")}</dd>
          </dl>

          <BookingSuitabilitySummary
            suitability={item.suitability}
            suitabilityOverridden={item.suitabilityOverridden}
            overriddenCriteria={item.overriddenCriteria}
          />

          <h3>Overlapping requests</h3>
          {overlapping.length === 0 ? (
            <p>No other requests overlap.</p>
          ) : (
            <ol className="pending-bookings__overlapping">
              {overlapping.map((other) => (
                <li key={other.id}>
                  <strong>{other.eventName || "Unnamed event"}</strong>
                  <span>
                    Occupies {formatOccupiedPeriod(other, formatVenueRange)} {VENUE_TIME_NOTE}
                  </span>
                  <span>Requested {formatDateTime(other.createdAt, "at an unknown time")}</span>
                </li>
              ))}
            </ol>
          )}

          {error && <ErrorNotice message={error} onRetry={onRetry} />}

          <div className="pending-bookings__approve">
            {marksOnApproval > 0 && !approveBlockedBy && (
              <p>
                Approving marks {marksOnApproval}{" "}
                {plural(marksOnApproval, "overlapping request", "overlapping requests")} as
                Conflicting.
              </p>
            )}
            <Button
              onClick={() => onApprove(item)}
              disabled={busy || Boolean(approveBlockedBy)}
              aria-describedby={approveBlockedBy}
            >
              {deciding === "approve" ? "Approving..." : "Approve"}
            </Button>
          </div>

          <form className="pending-bookings__reject" onSubmit={handleReject} noValidate>
            <label htmlFor={reasonId}>Reason for rejecting (required)</label>
            <textarea
              id={reasonId}
              value={reason}
              maxLength={SERVER_TEXT_MAX_LENGTH}
              required
              aria-invalid={reasonError ? "true" : undefined}
              aria-describedby={reasonError ? reasonErrorId : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {reasonError && (
              <p id={reasonErrorId} className="pending-bookings__field-error">
                {reasonError}
              </p>
            )}
            <label htmlFor={`${regionId}-alternative`}>
              Suggest an alternative venue or arrangement (optional)
            </label>
            <textarea
              id={`${regionId}-alternative`}
              value={alternative}
              maxLength={SERVER_TEXT_MAX_LENGTH}
              onChange={(e) => setAlternative(e.target.value)}
            />
            <Button type="submit" variant="danger" disabled={busy}>
              {deciding === "reject" ? "Rejecting..." : "Reject"}
            </Button>
          </form>
        </div>
      )}
    </li>
  );
}
