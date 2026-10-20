// PendingBookingRequests.jsx
//
// SCRUM-258: Venue Staff's queue of open booking requests, oldest first, and
// where they approve or reject one. A <section> rendered straight under
// .dashboard, so it takes the dashboard's card styling.
//
// Pending and conflicting requests both appear: conflicting is a flag, not a
// decision, so it stays open (AC3). The order is the server's and is not
// re-sorted. One card is expanded at a time, and one decision is sent at a
// time, guarded by a ref as well as by disabled buttons.
//
// After every decision the queue is refetched, not patched: an approval turns
// other cards Conflicting, and the server is the one that knows which.
// onDecided, when given, tells a parent that a decision went through, as an
// approval can close a flagged booking it replaces.

import { useCallback, useEffect, useRef, useState } from "react";
import PendingBookingRequestCard from "./PendingBookingRequestCard";
import {
  approveBookingRequest,
  getPendingBookingRequests,
  rejectBookingRequest,
} from "../services/bookingRequestService";
import { decisionErrorMessage, isStaleDecisionError } from "../services/bookingRequestErrors";
import { SESSION_EXPIRED, statusMessageOf } from "../services/apiErrors";
import { asList } from "../services/displayFormat";

const LIST_ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Venue Staff can see pending booking requests.",
};
const LIST_DEFAULT_ERROR = "Pending booking requests could not be loaded. Please try again.";

/** The notice after an approval: what else it changed (AC3, and the event's own hold). */
function approvedNotice(item, result) {
  const marked = Array.isArray(result?.markedConflicting) ? result.markedConflicting.length : 0;
  const parts = [`Approved ${item.venueName || "the venue"} for ${item.eventName || "the event"}.`];
  if (marked > 0) {
    parts.push(
      marked === 1
        ? "1 overlapping request was marked Conflicting."
        : `${marked} overlapping requests were marked Conflicting.`,
    );
  }
  if (result?.convertedHoldId) parts.push("The event's tentative hold on this venue is now this booking.");
  parts.push("The coordinator has been notified.");
  return parts.join(" ");
}

/**
 * How many of item's overlaps an approval would newly mark Conflicting. Every
 * open request is in the queue, so an overlap is counted only when the queue
 * has it as pending; one already conflicting, or not found, is not.
 */
function marksOnApproval(item, pendingIds) {
  const overlapping = Array.isArray(item.overlapping) ? item.overlapping : [];
  return overlapping.filter((other) => pendingIds.has(other.id)).length;
}

export default function PendingBookingRequests({ onDecided }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  // { id, action } while a decision is in flight.
  const [deciding, setDeciding] = useState(null);
  // A refusal for one card is shown inside it; one meaning the queue was out
  // of date is shown above it, since the card may vanish on refetch.
  const [cardError, setCardError] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sending = useRef(false);

  // A refresh after a decision keeps the queue on screen, so it does not raise
  // `loading` again (EquipmentCatalogue's pattern, which also keeps setState
  // out of the effect's synchronous part).
  const refreshRequests = useCallback(async () => {
    try {
      setRequests(asList(await getPendingBookingRequests()));
      setError(null);
    } catch (err) {
      setError(statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR));
    }
  }, []);

  // The first load, declared inside the effect so a response arriving after
  // unmounting is dropped.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getPendingBookingRequests();
        if (!cancelled) {
          setRequests(asList(data));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(item, action, send) {
    if (sending.current) return;
    sending.current = true;
    setDeciding({ id: item.id, action });
    setCardError(null);
    setQueueError(null);
    setNotice(null);
    try {
      const result = await send();
      setNotice(
        action === "approve"
          ? approvedNotice(item, result)
          : "Rejected; the coordinator has been notified.",
      );
      setExpandedId(null);
      onDecided?.();
      await refreshRequests();
    } catch (err) {
      const message = decisionErrorMessage(err);
      if (isStaleDecisionError(err)) {
        setQueueError(message);
        setExpandedId(null);
        await refreshRequests();
      } else {
        setCardError({ id: item.id, message });
      }
    } finally {
      sending.current = false;
      setDeciding(null);
    }
  }

  function handleToggle(id) {
    setCardError(null);
    setExpandedId((current) => (current === id ? null : id));
  }

  const pendingIds = new Set(requests.filter((r) => r.status === "pending").map((r) => r.id));

  return (
    <section className="pending-bookings">
      <h2>Pending booking requests</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="pending-bookings__error" role="alert">
          {error}
        </p>
      )}
      {queueError && (
        <p className="pending-bookings__error" role="alert">
          {queueError}
        </p>
      )}
      {notice && (
        <p className="pending-bookings__notice" role="status">
          {notice}
        </p>
      )}
      {!loading && !error && requests.length === 0 && <p>No pending booking requests.</p>}

      {requests.length > 0 && (
        <ul>
          {requests.map((item) => (
            <PendingBookingRequestCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={handleToggle}
              busy={deciding !== null}
              marksOnApproval={marksOnApproval(item, pendingIds)}
              deciding={deciding?.id === item.id ? deciding.action : null}
              error={cardError?.id === item.id ? cardError.message : null}
              onApprove={(target) => decide(target, "approve", () => approveBookingRequest(target.id))}
              onReject={(target, input) =>
                decide(target, "reject", () => rejectBookingRequest(target.id, input))
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
