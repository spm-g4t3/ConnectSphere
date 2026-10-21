// EventFlaggedBookings.jsx
//
// The assigned coordinator's view of this event's flagged bookings, on the
// event screen: why each was flagged, any replacement already requested, and
// the two ways to resolve it (cancel it, or request another venue to replace
// it). Only flagged bookings are listed; the event's other bookings are not
// touched, as an event may hold several venues.
//
// Renders nothing while loading or when none are flagged, so an event without
// a problem shows no empty section. After a cancellation the list is
// refetched, not patched, as Venue Staff's list does. The replacement itself
// is requested from Find a venue; the parent owns which booking is replaced.

import { useCallback, useEffect, useRef, useState } from "react";
import FlaggedBookingFlagDetail from "./FlaggedBookingFlagDetail";
import FlaggedBookingReasonForm from "./FlaggedBookingReasonForm";
import { asList, formatTimestamp } from "../services/displayFormat";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { venueText } from "../services/flaggedBookingDisplay";
import { cancelFlaggedBooking, getEventFlaggedBookings } from "../services/flaggedBookingService";
import { coordinatorCancelErrorMessage, isStaleResolutionError } from "../services/flaggedBookingErrors";
import { SESSION_EXPIRED, statusMessageOf } from "../services/apiErrors";

const LIST_ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only the coordinator assigned to this event can see its flagged bookings.",
  404: "This event no longer exists.",
};
const LIST_DEFAULT_ERROR = "Flagged bookings could not be loaded.";

function FlaggedBooking({ item, busy, cancelling, error, replacing, onCancel, onReplace }) {
  const regionId = `event-flagged-booking-${item.id}`;

  return (
    <li className="pending-bookings__card" aria-labelledby={`${regionId}-venue`}>
      <div className="pending-bookings__detail">
        <h4 id={`${regionId}-venue`}>{venueText(item)}</h4>
        <dl>
          <dt>Booking period</dt>
          <dd>{formatVenuePeriod(item.startsAt, item.endsAt)}</dd>
          <dt>Flagged</dt>
          <dd>{formatTimestamp(item.flaggedAt, "at an unknown time")}</dd>
        </dl>

        <FlaggedBookingFlagDetail
          item={item}
          headingLevel={5}
          reasonsNote={<p className="pending-bookings__event-status">Alternative arrangements are required.</p>}
          replacementsNote={
            <p className="pending-bookings__event-status">
              This booking stays flagged until Venue Staff approve a replacement.
            </p>
          }
        />

        {error && (
          <p className="pending-bookings__error" role="alert">
            {error}
          </p>
        )}

        {/* Not a toggle: it picks this booking for Find a venue below, so the
            choice is said in text rather than as a pressed state. */}
        <button type="button" disabled={busy} onClick={() => onReplace(item)}>
          Find a replacement venue
        </button>
        {replacing && <p className="pending-bookings__event-status">Finding a replacement below.</p>}
        <FlaggedBookingReasonForm
          id={`${regionId}-cancel`}
          label="Reason for cancelling (required)"
          verb="cancelling"
          busy={busy}
          buttonLabel="Cancel this booking"
          sendingLabel={cancelling ? "Cancelling..." : null}
          onSubmit={(reason) => onCancel(item, reason)}
        />
      </div>
    </li>
  );
}

export default function EventFlaggedBookings({ eventRequestId, replacingId, onReplace, onCancelled, onLoaded }) {
  const [bookings, setBookings] = useState([]);
  const [error, setError] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  // A refusal for one booking is shown with it; one meaning the list was out
  // of date is shown above, since that booking may vanish on refetch.
  const [cardError, setCardError] = useState(null);
  const [listError, setListError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sending = useRef(false);
  // Kept in a ref so a new callback from the parent does not reload the list.
  const loadedRef = useRef(onLoaded);
  useEffect(() => {
    loadedRef.current = onLoaded;
  });

  const load = useCallback(async () => {
    try {
      const items = asList(await getEventFlaggedBookings(eventRequestId));
      setBookings(items);
      setError(null);
      loadedRef.current?.(items);
    } catch (err) {
      setError(statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR));
    }
  }, [eventRequestId]);

  // The first load drops a response arriving after unmounting.
  useEffect(() => {
    let cancelled = false;
    getEventFlaggedBookings(eventRequestId)
      .then((data) => {
        if (cancelled) return;
        const items = asList(data);
        setBookings(items);
        setError(null);
        loadedRef.current?.(items);
      })
      .catch((err) => {
        if (!cancelled) setError(statusMessageOf(err, LIST_ERROR_MESSAGES, LIST_DEFAULT_ERROR));
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  async function handleCancel(item, reason) {
    if (sending.current) return;
    sending.current = true;
    setCancellingId(item.id);
    setCardError(null);
    setListError(null);
    setNotice(null);
    try {
      await cancelFlaggedBooking(item.id, reason);
      setNotice(`Cancelled the booking of ${item.venueName || "the venue"}.`);
      onCancelled?.(item);
      await load();
    } catch (err) {
      const message = coordinatorCancelErrorMessage(err);
      if (isStaleResolutionError(err)) {
        setListError(message);
        await load();
      } else {
        setCardError({ id: item.id, message });
      }
    } finally {
      sending.current = false;
      setCancellingId(null);
    }
  }

  if (!error && !listError && !notice && bookings.length === 0) return null;

  return (
    <section className="event-flagged-bookings">
      <h3>Flagged bookings</h3>
      {error && (
        <div className="pending-bookings__error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={load}>
            Try again
          </button>
        </div>
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
      {bookings.length > 0 && (
        <ul>
          {bookings.map((item) => (
            <FlaggedBooking
              key={item.id}
              item={item}
              busy={cancellingId !== null}
              cancelling={cancellingId === item.id}
              error={cardError?.id === item.id ? cardError.message : null}
              replacing={replacingId === item.id}
              onCancel={handleCancel}
              onReplace={onReplace}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
