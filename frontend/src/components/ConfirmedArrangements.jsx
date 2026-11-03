import { useCallback, useEffect, useRef, useState } from "react";
import { getConfirmedArrangements } from "../services/eventRequestService";
import { formatVenuePeriod } from "../services/datetimeFormat";
import { readStatusDisplay } from "../services/eventRequestStatusDisplay";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { canRetryRead } from "../services/apiErrors";
import LoadingText from "./ui/LoadingText";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";

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
      if (current === version.current) {
        setState({
          error: READ_ERRORS[error?.response?.status] ?? "Confirmed arrangements could not be loaded.",
          retryable: canRetryRead(error),
        });
      }
    }
  }, [eventRequestId]);

  useEffect(() => {
    load();
    return () => { version.current += 1; };
  }, [load]);
  useRefetchOnReturn(load);
  const { headingRef, retry } = useFocusAfterRetry(load);

  // Every state renders in this box, so focus has somewhere to land after Try again.
  const box = (content) => <div ref={headingRef} tabIndex={-1}>{content}</div>;

  if (state.loading) return box(<LoadingText />);
  if (state.error) {
    return box(<ErrorNotice message={state.error} onRetry={state.retryable ? retry : undefined} />);
  }
  const data = state.data;
  const display = readStatusDisplay(data);
  const completed = data.status === "completed";
  if (data.status !== "confirmed" && !completed) {
    return box(<p role="status">The event is now {display.label}. Its arrangements are not currently confirmed.</p>);
  }

  return box(
    <section aria-label={completed ? "Arrangements of the completed event" : "Current confirmed arrangements"}>
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
    </section>,
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
