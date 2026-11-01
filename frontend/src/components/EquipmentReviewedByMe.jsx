// EquipmentReviewedByMe.jsx
//
// "Reviewed by me" on the Technical Support dashboard and on /equipment: the
// equipment requests the signed-in person has started or taken over, newest
// work first, with why a review of theirs ended when it did not finish.
// Read only. Opening a request from here assigns it to no one; the review
// screen's own Start and Take over buttons do that.
//
// Renders a <section> and no `dashboard` wrapper, like EquipmentRequestQueue.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getReviewedByMe } from "../services/equipmentQueueService";
import { equipmentStatusTone } from "../services/equipmentRequestStatus";
import { formatEventDateTimeRange } from "../services/eventPeriodFormat";
import { formatDateTime } from "../services/displayFormat";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";
import "./EquipmentRequestQueue.css";

const LOAD_ERRORS = {
  403: "Only technical support staff can see the requests they have reviewed.",
};
const GENERIC_LOAD_ERROR = "Your reviewed requests could not be loaded.";

function ReviewedRow({ row }) {
  return (
    <li className="equipment-queue__row">
      <div className="equipment-queue__main">
        <div className="equipment-queue__title">
          <strong>{row.eventName}</strong>
          <StatusBadge tone={equipmentStatusTone(row.status)}>{row.statusLabel}</StatusBadge>
        </div>
        <p className="equipment-queue__detail">{formatEventDateTimeRange(row.proposedStart, row.proposedEnd)}</p>
        <p className="equipment-queue__detail">{`Last worked on: ${formatDateTime(row.lastWorkedAt, "Not set")}`}</p>
        {row.interruptedReason && (
          <p className="equipment-queue__detail">{`Your review ended: ${row.interruptedReason.replace(/\.$/, "")}.`}</p>
        )}
        {row.returnedToPending && <p className="equipment-queue__flag">Back in Pending review since you last worked on it.</p>}
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

export default function EquipmentReviewedByMe() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getReviewedByMe();
      setList(data);
    } catch (err) {
      setError(LOAD_ERRORS[err?.response?.status] ?? GENERIC_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="equipment-queue" aria-labelledby="equipment-reviewed-by-me" aria-busy={loading}>
      <h2 id="equipment-reviewed-by-me">Reviewed by me</h2>
      {loading && !list && !error && <LoadingText />}
      {/* A 403 gives the same answer again, so only the generic failure offers a retry. */}
      {error && <ErrorNotice message={error} onRetry={error === GENERIC_LOAD_ERROR ? load : undefined} />}
      {list && list.requests.length === 0 && (
        <EmptyState
          message="You have not reviewed any equipment requests yet."
          nextStep="Requests you start or take over appear here."
        />
      )}
      {list && list.requests.length > 0 && (
        <ul>
          {list.requests.map((row) => (
            <ReviewedRow key={row.requestId} row={row} />
          ))}
        </ul>
      )}
      {list?.truncated && (
        <p role="note">{`Showing the ${list.requests.length} most recent of ${list.total}.`}</p>
      )}
    </section>
  );
}
