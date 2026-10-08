// MyBookingRequests.jsx
//
// SCRUM-255 (part of SCRUM-243): the coordinator's list of venue booking
// requests and where each stands, with a way to withdraw one that is still
// pending.
//
// Built the way MyAssignedEvents is, so the coordinator's screens behave alike:
// a useCallback fetch, a refetch when the tab regains focus, a status-keyed
// error table, a "Loading..." line, an empty-state sentence, and a <section>
// root that takes its card styling and badge colours from the
// .dashboard--coordinator wrapper App.jsx's route supplies.
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
// Withdrawing is a two-step inline confirm, the pattern BlockConflictList and
// the venue retire button use: this frontend has no modal. One request is sent
// at a time, guarded by a ref as well as by disabled buttons. There are no
// staff approve or reject controls here.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getMyBookingRequests, withdrawBookingRequest } from "../services/bookingRequestService";
import { isStaleWithdrawError, withdrawErrorMessage } from "../services/bookingRequestErrors";
import {
  bookingStatusClassName,
  readBookingStatusDisplay,
} from "../services/bookingRequestStatusDisplay";
import { formatRange, formatTimestamp } from "../services/displayFormat";
import { reviewReasonLabel } from "../services/flaggedBookingDisplay";

// Keyed by status, the same shape as MyAssignedEvents' table. GET /mine is gated
// on the coordinator role, so a 403 means the account's role is wrong.
const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Event Coordinators have a list of venue requests.",
  500: "Your venue requests could not be loaded. Please try again.",
};

const PENDING = "pending";
const FLAGGED_FOR_REVIEW = "flagged_for_review";

function RequestRow({ item, confirming, withdrawing, busy, onAsk, onCancel, onConfirm }) {
  const display = readBookingStatusDisplay(item);
  const isPending = item.status === PENDING;
  // Only a setup or turnaround change stores a reason code (SCRUM-484); a
  // booking flagged by a venue block has none, and reads as before.
  const reason = reviewReasonLabel(item.reviewReason);

  return (
    <li className="my-booking-requests__row">
      <div className="my-booking-requests__summary">
        <span className="my-booking-requests__title">
          <strong>{item.eventName || "Unnamed event"}</strong>
          <span className={`status-badge ${bookingStatusClassName(display.group)}`}>
            {display.label}
          </span>
        </span>
        <span className="my-booking-requests__meta">
          <span>
            {item.venueName || "Unknown venue"}
            {item.venueLocation ? `, ${item.venueLocation}` : ""}
          </span>
          <span>{formatRange(item.startsAt, item.endsAt)}</span>
          <span>Requested {formatTimestamp(item.createdAt, "at an unknown time")}</span>
        </span>
        {item.status === FLAGGED_FOR_REVIEW && (
          <span className="my-booking-requests__flag">
            Flagged for review{item.flaggedAt ? ` on ${formatTimestamp(item.flaggedAt)}` : ""}
            {reason ? ` (${reason})` : ""}. It needs to be resolved.
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

      {isPending && !confirming && (
        <button
          type="button"
          className="my-booking-requests__withdraw"
          onClick={() => onAsk(item.id)}
          disabled={busy}
          aria-label={`Withdraw the request for ${item.eventName || "this event"} at ${item.venueName || "this venue"}`}
        >
          Withdraw
        </button>
      )}

      {isPending && confirming && (
        <div className="my-booking-requests__confirm">
          <span>Withdraw this request? Venue Staff will be told.</span>
          <button type="button" onClick={() => onConfirm(item)} disabled={busy}>
            {withdrawing ? "Withdrawing..." : "Yes, withdraw"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Keep it
          </button>
        </div>
      )}
    </li>
  );
}

export default function MyBookingRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Refetch when the coordinator comes back to the tab, for MyAssignedEvents'
  // reason: Venue Staff decide these while the coordinator is not looking.
  useEffect(() => {
    function refetchIfVisible() {
      if (document.visibilityState === "visible") fetchRequests();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [fetchRequests]);

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
      <h2>Venue requests</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="review-queue__error" role="alert">
          {error}
        </p>
      )}
      {withdrawError && (
        <p className="review-queue__error" role="alert">
          {withdrawError}
        </p>
      )}
      {notice && (
        <p className="my-booking-requests__notice" role="status">
          {notice}
        </p>
      )}
      {/* Nothing requested is the good state, not a missing resource. */}
      {!loading && !error && requests.length === 0 && (
        <p>
          You have not requested a venue yet. <Link to="/my-events">Open one of your events</Link> to
          find a venue for it.
        </p>
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
