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
import { statusMessageOf } from "../services/apiErrors";
import { asList } from "../services/displayFormat";

const LIST_ERROR_MESSAGES = {
  403: "Only Venue Staff can see flagged bookings.",
};
const LIST_DEFAULT_ERROR = "Flagged bookings could not be loaded. Please try again.";

function resolvedNotice(item, action) {
  const venue = item.venueName || "the venue";
  const event = item.eventName || "the event";
  return action === "reinstate"
    ? `Reinstated the booking of ${venue} for ${event}; it is approved again.`
    : `Cancelled the booking of ${venue} for ${event}.`;
}

export default function FlaggedBookings() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
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
      setError(statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR));
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

  return (
    <section className="flagged-bookings">
      <h2>Flagged bookings</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="pending-bookings__error" role="alert">
          {error}
        </p>
      )}
      {listError && (
        <p className="pending-bookings__error" role="alert">
          {listError}
        </p>
      )}
      {notice && (
        <p className="pending-bookings__notice" role="status">
          {notice}
        </p>
      )}
      {!loading && !error && bookings.length === 0 && <p>No bookings are flagged for review.</p>}

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
