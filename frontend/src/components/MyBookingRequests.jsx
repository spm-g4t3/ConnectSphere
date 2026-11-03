// MyBookingRequests.jsx
//
// SCRUM-255 (part of SCRUM-243): the coordinator's list of venue booking
// requests and where each stands, with a way to withdraw one that is still
// pending.
//
// Built the way MyAssignedEvents is, so the coordinator's screens behave alike:
// a useCallback fetch, a refetch when the tab regains focus, a status-keyed
// error table, the shared loading, error and empty states, and a <section>
// root that takes its card styling from the .dashboard--coordinator wrapper
// App.jsx's route supplies.
//
// What is listed is decided by the backend, not here: every booking on an event
// assigned to the signed-in coordinator, newest first. Nothing in this file
// filters by person. The list is not re-sorted, for the reason ReviewQueue
// gives: the server already answered the ordering.
//
// Labels and groups come from each row's statusDisplay, so this component
// interprets no status itself, except one: only a pending request offers
// Withdraw, because that is the only state the server will withdraw from. The
// server checks again under a lock, and a refusal is shown and the list
// refetched, so a stale button is harmless.
//
// Withdrawing is a two-step inline confirm. One request is sent
// at a time, guarded by a ref as well as by disabled buttons. There are no
// staff approve or reject controls here (PendingBookingRequests has them); a
// rejected request shows the reason and any suggested alternative.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getMyBookingRequests, withdrawBookingRequest } from "../services/bookingRequestService";
import { canRetryRead } from "../services/apiErrors";
import { isStaleWithdrawError, withdrawErrorMessage } from "../services/bookingRequestErrors";
import { readBookingStatusDisplay } from "../services/bookingRequestStatusDisplay";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { formatDateTime } from "../services/displayFormat";
import { reviewReasonLabel } from "../services/flaggedBookingDisplay";
import { BOOKING_GROUP_TONES, toneFor } from "../services/venueStatusTones";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";
import useFocusAfterRetry from "./useFocusAfterRetry";

// Keyed by status, the same shape as MyAssignedEvents' table. GET /mine is gated
// on the coordinator role, so a 403 means the account's role is wrong.
const LIST_ERROR_MESSAGES = {
  403: "Only Event Coordinators have a list of venue requests.",
  500: "Your venue requests could not be loaded. Please try again.",
};

// A conflicting request is still open, so its coordinator can withdraw it too.
const WITHDRAWABLE = new Set(["pending", "conflicting"]);
const FLAGGED_FOR_REVIEW = "flagged_for_review";
const REJECTED = "rejected";

function RequestRow({ item, confirming, withdrawing, busy, onAsk, onCancel, onConfirm }) {
  const display = readBookingStatusDisplay(item);
  const canWithdraw = WITHDRAWABLE.has(item.status);
  // Only a setup or turnaround change stores a reason code (SCRUM-484); a
  // booking flagged by a venue block has none, and reads as before.
  const reason = reviewReasonLabel(item.reviewReason);

  return (
    <li className="my-booking-requests__row">
      <div className="my-booking-requests__summary">
        <span className="my-booking-requests__title">
          <strong>{item.eventName || "Unnamed event"}</strong>
          <StatusBadge tone={toneFor(BOOKING_GROUP_TONES, display.group)}>{display.label}</StatusBadge>
        </span>
        <span className="my-booking-requests__meta">
          <span>
            {item.venueName || "Unknown venue"}
            {item.venueLocation ? `, ${item.venueLocation}` : ""}
          </span>
          <span>{formatVenuePeriod(item.startsAt, item.endsAt)}</span>
          <span>Requested {formatDateTime(item.createdAt, "at an unknown time")}</span>
        </span>
        {item.status === FLAGGED_FOR_REVIEW && (
          <span className="my-booking-requests__flag">
            Flagged for review{item.flaggedAt ? ` on ${formatDateTime(item.flaggedAt)}` : ""}
            {reason ? ` (${reason})` : ""}. It needs to be resolved.
          </span>
        )}
        {/* SCRUM-258 (AC4, AC6): why Venue Staff said no, and what they
            suggested instead, so the coordinator can act on it. */}
        {item.status === REJECTED && item.decisionReason && (
          <span className="my-booking-requests__note">Reason: {item.decisionReason}</span>
        )}
        {item.status === REJECTED && item.suggestedAlternative && (
          <span className="my-booking-requests__note">
            Suggested alternative: {item.suggestedAlternative}
          </span>
        )}
        {item.suitabilityOverridden && (
          <span className="my-booking-requests__note">
            Requested although the venue did not meet every requirement.
          </span>
        )}
        {item.setupNotes && (
          <span className="my-booking-requests__note">Setup notes: {item.setupNotes}</span>
        )}
      </div>

      {/* Only asks; the danger colour is kept for the step that withdraws. */}
      {canWithdraw && !confirming && (
        <Button
          variant="secondary"
          onClick={() => onAsk(item.id)}
          disabled={busy}
          aria-label={`Withdraw the request for ${item.eventName || "this event"} at ${item.venueName || "this venue"}`}
        >
          Withdraw
        </Button>
      )}

      {canWithdraw && confirming && (
        <div className="my-booking-requests__confirm">
          <span>Withdraw this request? Venue Staff will be told.</span>
          <Button variant="danger" onClick={() => onConfirm(item)} disabled={busy}>
            {withdrawing ? "Withdrawing..." : "Yes, withdraw"}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Keep it
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * @param {object} props
 * @param {boolean} [props.asPage]  true at /my-venue-requests, where the title
 *                                  is the page's h1
 */
export default function MyBookingRequests({ asPage = false } = {}) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryable, setRetryable] = useState(false);
  // The request whose withdraw is awaiting confirmation, and the one being sent.
  const [confirmingId, setConfirmingId] = useState(null);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [withdrawError, setWithdrawError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sending = useRef(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyBookingRequests();
      setRequests(data);
      setError(null);
    } catch (err) {
      setError(
        LIST_ERROR_MESSAGES[err.response?.status] ||
          "Your venue requests could not be loaded. Please try again.",
      );
      setRetryable(canRetryRead(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Refetch when the coordinator comes back to the tab, for MyAssignedEvents'
  // reason: Venue Staff decide these while the coordinator is not looking.
  useRefetchOnReturn(fetchRequests);

  // Try again goes away as its read starts, so focus moves to the title.
  const { headingRef, retry } = useFocusAfterRetry(fetchRequests);
  const Title = asPage ? "h1" : "h2";

  async function handleWithdraw(item) {
    if (sending.current) return;
    sending.current = true;
    setWithdrawingId(item.id);
    setWithdrawError(null);
    setNotice(null);
    try {
      await withdrawBookingRequest(item.id);
      setConfirmingId(null);
      setNotice(
        `The request for ${item.eventName || "this event"} at ${item.venueName || "this venue"} was withdrawn.`,
      );
      await fetchRequests();
    } catch (err) {
      setConfirmingId(null);
      setWithdrawError(withdrawErrorMessage(err));
      // The answer means our copy was out of date; show the truth.
      if (isStaleWithdrawError(err)) await fetchRequests();
    } finally {
      sending.current = false;
      setWithdrawingId(null);
    }
  }

  return (
    <section className="my-booking-requests">
      <Title ref={headingRef} tabIndex={-1}>
        Venue requests
      </Title>

      {loading && <LoadingText />}
      {/* Hidden while a read is in flight, so Try again cannot start a second one. */}
      {error && !loading && <ErrorNotice message={error} onRetry={retryable ? retry : undefined} />}
      {/* No Try again: this is not a failed read, and asking again is the row's own Withdraw. */}
      {withdrawError && <ErrorNotice message={withdrawError} />}
      {notice && (
        <p className="my-booking-requests__notice" role="status">
          {notice}
        </p>
      )}
      {/* Nothing requested is the good state, not a missing resource. */}
      {!loading && !error && requests.length === 0 && (
        <EmptyState
          message="You have not requested a venue yet."
          nextStep="Find a venue from one of your events."
          action={
            <Link className="ui-button ui-button--primary" to="/my-events">
              Open one of your events
            </Link>
          }
        />
      )}

      {requests.length > 0 && (
        <ul>
          {requests.map((item) => (
            <RequestRow
              key={item.id}
              item={item}
              confirming={confirmingId === item.id}
              withdrawing={withdrawingId === item.id}
              busy={withdrawingId !== null}
              onAsk={(id) => {
                setWithdrawError(null);
                setNotice(null);
                setConfirmingId(id);
              }}
              onCancel={() => setConfirmingId(null)}
              onConfirm={handleWithdraw}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
