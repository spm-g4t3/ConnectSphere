// FlaggedBookings.jsx
//
// Venue Staff's list of bookings flagged for review, oldest flag first, and
// where they reinstate or cancel one. A <section> rendered straight under
// .dashboard, so it takes the dashboard's card styling; the cards reuse the
// pending queue's classes so both lists look the same.
//
// After every resolution the list is refetched, not patched: the server is
// the one that knows what else changed. One resolution is sent at a time,
// guarded by a ref as well as by disabled buttons.

import { useCallback, useEffect, useRef, useState } from "react";
import FlaggedBookingCard from "./FlaggedBookingCard";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import {
  cancelFlaggedBooking,
  getFlaggedBookings,
  reinstateFlaggedBooking,
} from "../services/flaggedBookingService";
import {
  isStaleResolutionError,
  resolutionConflicts,
  resolutionErrorMessage,
} from "../services/flaggedBookingErrors";
import { SESSION_EXPIRED, statusMessageOf } from "../services/apiErrors";
import { asList } from "../services/displayFormat";

const LIST_ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only Venue Staff can see flagged bookings.",
};
const LIST_DEFAULT_ERROR = "Flagged bookings could not be loaded. Please try again.";

/**
 * A failed list load as { message, retryable }. A 401 or 403 repeats on every
 * attempt (only signing in or another role fixes it), so it gets no Try again.
 */
function listLoadError(err) {
  const status = err?.response?.status;
  return {
    message: statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR),
    retryable: status !== 401 && status !== 403,
  };
}

function resolvedNotice(item, action) {
  const venue = item.venueName || "the venue";
  const event = item.eventName || "the event";
  return action === "reinstate"
    ? `Reinstated the booking of ${venue} for ${event}; it is approved again.`
    : `Cancelled the booking of ${venue} for ${event}.`;
}

export default function FlaggedBookings({ asPage = false }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped by Try again, so the guarded first load below runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  // { id, action } while a resolution is in flight.
  const [resolving, setResolving] = useState(null);
  // A refusal for one card is shown inside it; one meaning the list was out
  // of date is shown above it, since the card may vanish on refetch.
  const [cardError, setCardError] = useState(null);
  const [listError, setListError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sending = useRef(false);

  // A refresh after a resolution keeps the list on screen, so it does not
  // raise `loading` again.
  const refreshBookings = useCallback(async () => {
    try {
      setBookings(asList(await getFlaggedBookings()));
      setError(null);
    } catch (err) {
      setError(listLoadError(err));
    }
  }, []);

  // The first load, declared inside the effect so a response arriving after
  // unmounting is dropped.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getFlaggedBookings();
        if (!cancelled) {
          setBookings(asList(data));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(listLoadError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  function retryLoad() {
    setError(null);
    setLoading(true);
    setLoadAttempt((n) => n + 1);
  }

  async function resolve(item, action, send) {
    if (sending.current) return;
    sending.current = true;
    setResolving({ id: item.id, action });
    setCardError(null);
    setListError(null);
    setNotice(null);
    try {
      await send();
      setNotice(resolvedNotice(item, action));
      setExpandedId(null);
      await refreshBookings();
    } catch (err) {
      const message = resolutionErrorMessage(err);
      if (isStaleResolutionError(err)) {
        setListError(message);
        setExpandedId(null);
        await refreshBookings();
      } else {
        setCardError({ id: item.id, message, conflicts: resolutionConflicts(err) });
      }
    } finally {
      sending.current = false;
      setResolving(null);
    }
  }

  function handleToggle(id) {
    setCardError(null);
    setExpandedId((current) => (current === id ? null : id));
  }

  // Its own route makes it the page title; on the dashboard it is a section.
  const Heading = asPage ? "h1" : "h2";

  return (
    <section className="flagged-bookings">
      <Heading>Flagged bookings</Heading>

      {loading && <LoadingText />}
      {/* Signing in again or a different role is the fix for 401 and 403, not repeating the load. */}
      {error && <ErrorNotice message={error.message} onRetry={error.retryable ? retryLoad : undefined} />}
      {/* The list has already been refetched, so the stale booking may be gone. */}
      {listError && <ErrorNotice message={listError} />}
      {notice && (
        <p className="pending-bookings__notice" role="status">
          {notice}
        </p>
      )}
      {!loading && !error && bookings.length === 0 && (
        <EmptyState
          message="No bookings are flagged for review."
          nextStep="An approved booking appears here when a venue block, a change to the venue, a change to the event or a safety review affects it."
        />
      )}

      {bookings.length > 0 && (
        <ul>
          {bookings.map((item) => {
            const ownError = cardError?.id === item.id ? cardError : null;
            return (
              <FlaggedBookingCard
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={handleToggle}
                busy={resolving !== null}
                resolving={resolving?.id === item.id ? resolving.action : null}
                error={ownError?.message ?? null}
                conflicts={ownError?.conflicts ?? []}
                onReinstate={(target, reason) =>
                  resolve(target, "reinstate", () => reinstateFlaggedBooking(target.id, reason))
                }
                onCancel={(target, reason) =>
                  resolve(target, "cancel", () => cancelFlaggedBooking(target.id, reason))
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
