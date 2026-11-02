// EquipmentRequestQueue.jsx
//
// The equipment request lists on the Technical Support dashboard and on
// /equipment: "Needs action" on top, then every request, filterable by status.
// The server decides what each list holds and in what order; this file never
// sorts or filters rows, it asks (status, include past events) and draws.
//
// Renders <section>s and no `dashboard` wrapper, so the parent supplies the card
// styling, as ReviewQueue does.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getEquipmentQueue } from "../services/equipmentQueueService";
import { equipmentStatusClass } from "../services/equipmentRequestStatus";
import { formatEventPeriod } from "../services/eventPeriodFormat";
import "./EquipmentRequestQueue.css";

const LOAD_ERRORS = {
  400: "That filter was not accepted. Choose another status and try again.",
  403: "Only technical support staff can see equipment requests.",
};
const GENERIC_LOAD_ERROR = "The equipment requests could not be loaded. Try again.";

const itemsLabel = (count) => `${count} ${count === 1 ? "item" : "items"}`;

function venuesLabel(venues) {
  if (venues.length === 0) return "No venue booked";
  const names = venues.map((venue) => venue.name ?? "Unnamed venue").join(", ");
  return `${venues.length === 1 ? "Venue" : "Venues"}: ${names}`;
}

function loadErrorMessage(err) {
  return LOAD_ERRORS[err?.response?.status] ?? GENERIC_LOAD_ERROR;
}

// How the person can shorten a list, from the filters that actually apply to it.
function narrowing({ status, includePast }) {
  const ways = [];
  if (!status) ways.push("choose a status");
  if (includePast) ways.push("leave out past events");
  return ways.length > 0 ? ` You can ${ways.join(" or ")} to narrow it.` : "";
}

function TruncatedNote({ shown, total, advice }) {
  return <p role="note">{`Showing the first ${shown} of ${total}.${advice}`}</p>;
}

function RequestRow({ row, showFlagReasons }) {
  return (
    <li className="equipment-queue__row">
      <div className="equipment-queue__main">
        <div className="equipment-queue__title">
          <strong>{row.eventName}</strong>
          <span className={`equipment-queue__status equipment-queue__status--${equipmentStatusClass(row.status)}`}>
            {row.statusLabel}
          </span>
        </div>
        <p className="equipment-queue__detail">{formatEventPeriod(row.proposedStart, row.proposedEnd)}</p>
        <p className="equipment-queue__detail">
          {venuesLabel(row.venues)}
          {" · "}
          {row.coordinator ? `Coordinator: ${row.coordinator.name ?? "Name not set"}` : "No coordinator assigned"}
          {" · "}
          {itemsLabel(row.itemCount)}
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
  // Requests depend on both filters, so they are cleared as each read starts and
  // rows from another filter never show.
  const [requestList, setRequestList] = useState(null);
  // Needs action ignores both filters, so a failed reload keeps it.
  const [needsList, setNeedsList] = useState(null);
  // The filter's choices, kept from the last good read so the filter survives a failure.
  const [statuses, setStatuses] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // A slow answer to an earlier filter must not overwrite the answer to a later one.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    setRequestList(null);
    try {
      const data = await getEquipmentQueue({ status, includePast });
      if (ticket !== latest.current) return;
      setRequestList({ rows: data.requests, total: data.requestsTotal, truncated: data.requestsTruncated });
      setNeedsList({
        rows: data.needsAction,
        total: data.needsActionTotal,
        truncated: data.needsActionTruncated,
      });
      setStatuses(data.statuses);
    } catch (err) {
      if (ticket !== latest.current) return;
      setRequestList(null);
      setError(loadErrorMessage(err));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [status, includePast]);

  useEffect(() => {
    load();
  }, [load]);

  const needsAction = needsList?.rows ?? [];
  const requests = requestList?.rows ?? [];
  const firstLoad = loading && statuses === null;

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

      {needsList && (
        <section className="equipment-queue" aria-labelledby="equipment-queue-needs-action" aria-busy={loading}>
          <h2 id="equipment-queue-needs-action">{`Needs action (${needsList.total})`}</h2>
          {needsAction.length === 0 ? (
            <p>Nothing needs your action.</p>
          ) : (
            <ul>
              {needsAction.map((row) => (
                <RequestRow key={row.eventRequestId} row={row} showFlagReasons />
              ))}
            </ul>
          )}
          {needsList.truncated && (
            <TruncatedNote
              shown={needsAction.length}
              total={needsList.total}
              advice=" The rest appear here as these are dealt with."
            />
          )}
        </section>
      )}

      {statuses && (
        <section className="equipment-queue" aria-labelledby="equipment-queue-all" aria-busy={loading}>
          <h2 id="equipment-queue-all">Equipment requests</h2>
          <div className="equipment-queue__filters">
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All statuses</option>
                {statuses.map(({ value, label }) => (
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
          {loading && !requestList && <p role="status">Loading equipment requests...</p>}
          {requestList && requests.length === 0 && (
            <p>
              {status || includePast
                ? "No equipment requests match these filters."
                : "No equipment requests for upcoming events."}
            </p>
          )}
          {requests.length > 0 && (
            <ul>
              {requests.map((row) => (
                <RequestRow key={row.eventRequestId} row={row} showFlagReasons={false} />
              ))}
            </ul>
          )}
          {requestList?.truncated && (
            <TruncatedNote
              shown={requests.length}
              total={requestList.total}
              advice={narrowing({ status, includePast })}
            />
          )}
        </section>
      )}
    </>
  );
}
