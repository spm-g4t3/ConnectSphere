// EventVenueBookings.jsx
//
// SCRUM-492: the assigned coordinator's approved and released venue bookings
// for this event, on the event screen, and the Release action on each approved
// one. Only the chosen booking is released; the event's others are untouched.
//
// Reads GET /booking-requests/mine, which the server already limits to this
// coordinator's events and which carries every field shown here. Renders
// nothing while loading or when the event has neither kind of booking, as
// EventFlaggedBookings does; after a release the list is refetched, not patched.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTimestamp } from "../services/displayFormat";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { getMyBookingRequests, releaseVenueBooking } from "../services/bookingRequestService";
import { releaseErrorMessage } from "../services/bookingRequestErrors";
import { SERVER_TEXT_MAX_LENGTH } from "../services/textLimits";

const LIST_ERROR = "Venue bookings could not be loaded.";

const SHOWN_STATUSES = new Set(["approved", "released"]);

function forEvent(data, eventRequestId) {
  return (Array.isArray(data) ? data : []).filter(
    (row) => row?.eventRequestId === eventRequestId && SHOWN_STATUSES.has(row.status),
  );
}

function venueOf(row) {
  return row.venueName || "Unknown venue";
}

/** "1 other event's request is", "2 other events' requests are". */
function unblockedText(count) {
  return count === 1
    ? " 1 other event's request is no longer blocked."
    : ` ${count} other events' requests are no longer blocked.`;
}

function ReleaseForm({ id, busy, onConfirm, onKeep }) {
  const [reason, setReason] = useState("");
  const length = Array.from(reason.trim()).length;

  return (
    <form
      className="pending-bookings__reject"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // A second submit while one is sending is dropped by the parent's ref.
        if (reason.trim()) onConfirm(reason.trim());
      }}
    >
      <label htmlFor={id}>Reason for releasing this venue (required)</label>
      <textarea id={id} value={reason} maxLength={SERVER_TEXT_MAX_LENGTH} required onChange={(e) => setReason(e.target.value)} />
      <p className="event-venue-bookings__counter">
        {length.toLocaleString("en-US")} / {SERVER_TEXT_MAX_LENGTH.toLocaleString("en-US")}
      </p>
      <div className="event-venue-bookings__actions">
        <button type="submit" disabled={busy || reason.trim() === ""}>
          {busy ? "Releasing..." : "Confirm release"}
        </button>
        <button type="button" disabled={busy} onClick={onKeep}>
          Keep this venue
        </button>
      </div>
    </form>
  );
}

function VenueBooking({ row, open, busy, error, onOpen, onKeep, onConfirm }) {
  const headingId = `event-venue-booking-${row.id}`;
  const released = row.status === "released";

  return (
    <li className="pending-bookings__card" aria-labelledby={headingId}>
      <div className="pending-bookings__detail">
        <h4 id={headingId}>{venueOf(row)}</h4>
        <dl>
          <dt>Booking period</dt>
          <dd>{formatVenuePeriod(row.startsAt, row.endsAt)}</dd>
          <dt>Status</dt>
          <dd>{row.statusDisplay?.label ?? row.status}</dd>
          {released && (
            <>
              <dt>Released on</dt>
              <dd>
                {`${formatTimestamp(row.releasedAt, "at an unknown time")}: ${row.releaseReason || "No reason recorded"}`}
              </dd>
            </>
          )}
        </dl>
        {error && (
          <p className="pending-bookings__error" role="alert">
            {error}
          </p>
        )}
        {!released && !open && (
          <button type="button" disabled={busy} onClick={() => onOpen(row)}>
            Release this venue
          </button>
        )}
        {!released && open && (
          <ReleaseForm id={`${headingId}-reason`} busy={busy} onConfirm={(reason) => onConfirm(row, reason)} onKeep={onKeep} />
        )}
      </div>
    </li>
  );
}

export default function EventVenueBookings({ eventRequestId, onReleased, onStale }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [releasingId, setReleasingId] = useState(null);
  const [cardError, setCardError] = useState(null);
  const [listError, setListError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sending = useRef(false);

  const load = useCallback(async () => {
    try {
      setRows(forEvent(await getMyBookingRequests(), eventRequestId));
      setError(null);
    } catch {
      setError(LIST_ERROR);
    }
  }, [eventRequestId]);

  // The first load drops a response arriving after unmounting.
  useEffect(() => {
    let cancelled = false;
    async function first() {
      try {
        const data = await getMyBookingRequests();
        if (!cancelled) setRows(forEvent(data, eventRequestId));
      } catch {
        if (!cancelled) setError(LIST_ERROR);
      }
    }
    first();
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  async function handleConfirm(row, reason) {
    if (sending.current) return;
    sending.current = true;
    setReleasingId(row.id);
    setCardError(null);
    setListError(null);
    setNotice(null);
    try {
      const result = await releaseVenueBooking(row.id, reason);
      const freed = Array.isArray(result?.returnedToPending) ? result.returnedToPending.length : 0;
      setNotice(`${venueOf(row)} was released. Venue Staff have been told.${freed > 0 ? unblockedText(freed) : ""}`);
      setOpenId(null);
      onReleased?.(row);
      await load();
    } catch (err) {
      const message = releaseErrorMessage(err);
      const status = err?.response?.status;
      // The event itself moved on (left Approved, or was handed to someone
      // else), so the page must refresh, not only this list.
      if (status === 403 || (status === 409 && err.response.data?.code === "EVENT_NOT_APPROVED")) onStale?.();
      if (status === 409) {
        setListError(message);
        setOpenId(null);
        await load();
      } else {
        setCardError({ id: row.id, message });
      }
    } finally {
      sending.current = false;
      setReleasingId(null);
    }
  }

  if (!error && !listError && !notice && rows.length === 0) return null;

  return (
    <section className="event-flagged-bookings event-venue-bookings">
      <h3>Venue bookings</h3>
      <p>To use another venue, request it from Find a venue below.</p>
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
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <VenueBooking
              key={row.id}
              row={row}
              open={openId === row.id}
              busy={releasingId !== null}
              error={cardError?.id === row.id ? cardError.message : null}
              onOpen={(r) => {
                setCardError(null);
                setOpenId(r.id);
              }}
              onKeep={() => setOpenId(null)}
              onConfirm={handleConfirm}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
