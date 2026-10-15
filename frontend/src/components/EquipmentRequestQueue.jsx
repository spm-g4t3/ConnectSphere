// EquipmentRequestQueue.jsx
//
// SCRUM-287, for SCRUM-284 (Technical Support Dashboard and Request Queue).
// The equipment request lists on the Technical Support dashboard and on
// /equipment: a "Needs action" section on top, then every request, filterable
// by status. Selecting a request opens its review screen (SCRUM-290).
//
// What the screen decides and what the server decides. The server decides what
// is in each list, in what order, and which events have ended: this file never
// sorts or filters the rows it is given. It only asks (the status filter and the
// "include past events" box) and draws what comes back. Both lists arrive in one
// response, so a request cannot be in one and missing from the other.
//
// Each row shows what AC3 lists and nothing more: the event, its date and times,
// the booked venue, the assigned coordinator, how many equipment items, the status and, for
// a request under review, who is reviewing it. A row in Needs action also says
// why a reservation was flagged.
//
// Renders <section>s and NOT a `dashboard` wrapper, so the card styling comes
// from whichever parent mounted it, as ReviewQueue does. App.jsx's /equipment
// route supplies the wrapper.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { QUEUE_STATUSES, getEquipmentQueue } from "../services/equipmentQueueService";
import { formatEventPeriod } from "../services/eventPeriodFormat";
import "./EquipmentRequestQueue.css";

const STATUS_CLASS = {
  pending_review: "pending",
  under_review: "under",
  arranged: "arranged",
  cannot_be_fully_arranged: "cannot",
  cancelled: "cancelled",
};

const LOAD_ERRORS = {
  400: "That filter was not accepted. Choose another status and try again.",
  403: "Only technical support staff can see equipment requests.",
};
const GENERIC_LOAD_ERROR = "The equipment requests could not be loaded. Try again.";

const linesLabel = (count) => `${count} ${count === 1 ? "item" : "items"}`;

function loadErrorMessage(err) {
  return LOAD_ERRORS[err?.response?.status] ?? GENERIC_LOAD_ERROR;
}

function RequestRow({ row, showFlagReasons }) {
  return (
    <li className="equipment-queue__row">
      <div className="equipment-queue__main">
        <div className="equipment-queue__title">
          <strong>{row.eventName}</strong>
          <span className={`equipment-queue__status equipment-queue__status--${STATUS_CLASS[row.status]}`}>
            {row.statusLabel}
          </span>
        </div>
        <p className="equipment-queue__detail">{formatEventPeriod(row.proposedStart, row.proposedEnd)}</p>
        <p className="equipment-queue__detail">
          {row.venue ? `Venue: ${row.venue.name ?? "Unnamed venue"}` : "No venue booked"}
          {" · "}
          {row.coordinator ? `Coordinator: ${row.coordinator.name ?? "Name not set"}` : "No coordinator assigned"}
          {" · "}
          {linesLabel(row.lineCount)}
        </p>
        {row.status === "under_review" && row.reviewer && (
          <p className="equipment-queue__detail">{`Reviewing: ${row.reviewer.name ?? "Name not set"}`}</p>
        )}
        {row.flaggedCount > 0 && (
          <p className="equipment-queue__flag">
            {`${row.flaggedCount} ${row.flaggedCount === 1 ? "reservation" : "reservations"} flagged`}
            {showFlagReasons && row.flagReasons.length > 0 && `: ${row.flagReasons.join("; ")}`}
          </p>
        )}
      </div>
      <Link
        className="equipment-queue__open"
        to={`/equipment-review/${row.eventRequestId}`}
        aria-label={`Open ${row.eventName}`}
      >
        Open
      </Link>
    </li>
  );
}

export default function EquipmentRequestQueue() {
  const [status, setStatus] = useState("");
  const [includePast, setIncludePast] = useState(false);
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // A slow answer to an earlier filter must not overwrite the answer to a later one.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getEquipmentQueue({ status, includePast });
      if (ticket !== latest.current) return;
      setQueue(data);
    } catch (err) {
      if (ticket !== latest.current) return;
      setError(loadErrorMessage(err));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [status, includePast]);

  useEffect(() => {
    load();
  }, [load]);

  const needsAction = queue?.needsAction ?? [];
  const requests = queue?.requests ?? [];
  const firstLoad = loading && queue === null;

  return (
    <>
      {error && (
        <section className="equipment-queue">
          <p role="alert" className="equipment-queue__error">
            {error}
          </p>
          <button type="button" onClick={load}>
            Try again
          </button>
        </section>
      )}

      {firstLoad && !error && (
        <section className="equipment-queue">
          <p role="status">Loading equipment requests...</p>
        </section>
      )}

      {queue && (
        <>
          <section className="equipment-queue" aria-labelledby="equipment-queue-needs-action" aria-busy={loading}>
            <h2 id="equipment-queue-needs-action">{`Needs action (${needsAction.length})`}</h2>
            {needsAction.length === 0 ? (
              <p>Nothing needs your action.</p>
            ) : (
              <ul>
                {needsAction.map((row) => (
                  <RequestRow key={row.eventRequestId} row={row} showFlagReasons />
                ))}
              </ul>
            )}
          </section>

          <section className="equipment-queue" aria-labelledby="equipment-queue-all" aria-busy={loading}>
            <h2 id="equipment-queue-all">Equipment requests</h2>
            <div className="equipment-queue__filters">
              <label>
                Status
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">All statuses</option>
                  {QUEUE_STATUSES.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="equipment-queue__check">
                <input
                  type="checkbox"
                  checked={includePast}
                  onChange={(event) => setIncludePast(event.target.checked)}
                />
                Include past events
              </label>
            </div>
            {requests.length === 0 ? (
              <p>
                {status || includePast
                  ? "No equipment requests match these filters."
                  : "No equipment requests for upcoming events."}
              </p>
            ) : (
              <ul>
                {requests.map((row) => (
                  <RequestRow key={row.eventRequestId} row={row} showFlagReasons={false} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
