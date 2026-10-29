import { useCallback, useEffect, useRef, useState } from "react";
import { getConfirmedArrangements } from "../services/eventRequestService";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { readStatusDisplay } from "../services/eventRequestStatusDisplay";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";

const READ_ERRORS = {
  403: "Only the event's organiser can view these arrangements.",
  404: "This event request is no longer available.",
};

function ArrangementDetails({ eventRequestId }) {
  const [state, setState] = useState({ loading: true });
  const version = useRef(0);
  const load = useCallback(async () => {
    const current = ++version.current;
    // Hide the previous confirmation while checking its current status.
    setState({ loading: true });
    try {
      const data = await getConfirmedArrangements(eventRequestId);
      if (data?.eventRequestId !== eventRequestId || typeof data.status !== "string"
        || !Array.isArray(data.venues) || !Array.isArray(data.equipment)) {
        throw new Error("Unexpected arrangements response");
      }
      if (current === version.current) setState({ data });
    } catch (error) {
      if (current === version.current) setState({ error: READ_ERRORS[error?.response?.status] ?? "Confirmed arrangements could not be loaded. Please try again." });
    }
  }, [eventRequestId]);

  useEffect(() => {
    load();
    return () => { version.current += 1; };
  }, [load]);
  useRefetchOnReturn(load);

  if (state.loading) return <p role="status">Loading confirmed arrangements...</p>;
  if (state.error) return (
    <div role="alert">
      <p>{state.error}</p>
      <button type="button" onClick={load}>Retry arrangements</button>
    </div>
  );
  const data = state.data;
  const display = readStatusDisplay(data);
  if (data.status !== "confirmed") return <p role="status">The event is now {display.label}. Its arrangements are not currently confirmed.</p>;

  return (
    <section aria-label="Current confirmed arrangements">
      <dl>
        <dt>Date and time</dt>
        <dd>{formatVenuePeriod(data.startsAt, data.endsAt, "Date and time unavailable")}</dd>
      </dl>
      <h3>Venues</h3>
      {data.venues.length === 0 ? <p>No confirmed venue booking is available.</p> : (
        <ul>{data.venues.map((venue) => <li key={venue.bookingId}>{venue.name ?? "Venue name unavailable"} — {venue.location ?? "Location unavailable"}</li>)}</ul>
      )}
      <h3>Arranged equipment</h3>
      {data.equipment.length === 0 ? <p>No equipment is arranged for this event.</p> : (
        <ul>{data.equipment.map((line) => <li key={line.lineId}>{line.name ?? "Equipment type unavailable"}: {line.quantity ?? "Quantity unavailable"}</li>)}</ul>
      )}
    </section>
  );
}

export default function ConfirmedArrangements({ eventRequestId }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="my-event-requests__details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Confirmed arrangements</summary>
      {open && <ArrangementDetails eventRequestId={eventRequestId} />}
    </details>
  );
}
