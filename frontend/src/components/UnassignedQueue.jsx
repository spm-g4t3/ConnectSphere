// UnassignedQueue.jsx
//
// SCRUM-486 (SCRUM-519), AC2: every submitted request nobody has been
// assigned yet, oldest submission first, for the Event Coordinator Lead to
// assign; and the assignment panel each row opens into (AC3).
//
// Since migration 052 submission no longer picks a coordinator, so this list
// is the only place a new request is waiting. Each row says what the Lead
// needs to choose who should take it: the event, its organiser, when it runs,
// how many are expected, and how long it has waited.
//
// Its own component, rendered both on the Lead's dashboard and at
// /unassigned-queue, for the reason ReviewQueue is: it is the part of that
// screen with a route of its own. Like ReviewQueue it renders a <section>, so
// its card styling comes from the parent.
//
// No router hooks. ReviewQueue reads location.state to reopen a panel after a
// navigation; nothing navigates here, so the queue renders without a router.
// (This used to add that it let the Lead's dashboard render without one too.
// Since SCRUM-486 AC6 the dashboard's overview card holds a router Link to
// Assigned Events, so the dashboard needs a router of its own regardless.)

import { useState } from "react";
import { listUnassignedEventRequests } from "../services/eventRequestService";
import { formatRange } from "../services/displayFormat";
import { describeWaiting } from "../services/waitingTime";
import AssignCoordinatorPanel from "./AssignCoordinatorPanel";
import useListRead from "./useListRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { SESSION_EXPIRED } from "../services/apiErrors";

// 403 has its own words, as in ReviewQueue: it means the account is not a
// Lead, an administration problem, not a breakage.
const QUEUE_ERROR_MESSAGES = {
  401: SESSION_EXPIRED,
  403: "Only the Event Coordinator Lead can see the unassigned queue.",
  500: "The unassigned queue could not be loaded. Please try again.",
};

/**
 * @param {object} props
 * @param {Function} [props.now]  the clock "waiting" is measured against;
 *                                injected by tests, the reader's otherwise
 */
export default function UnassignedQueue({ now = () => new Date() }) {
  // The row being assigned, or null for the list.
  const [assigning, setAssigning] = useState(null);
  // What the last assignment did, said once back on the list.
  const [confirmation, setConfirmation] = useState(null);

  const {
    data: queue,
    loading,
    error,
    load: fetchQueue,
  } = useListRead(listUnassignedEventRequests, {
    messages: QUEUE_ERROR_MESSAGES,
    fallback: "The unassigned queue could not be loaded. Please try again.",
  });

  // Refetch when the Lead comes back to the tab, as ReviewQueue does: new
  // requests arrive, and other Leads assign them, while nobody is looking.
  useRefetchOnReturn(fetchQueue);

  // Back to the list, re-read either way. After an assignment the row has
  // gone; after a cancel the list may still be stale, and after a lost race
  // (AC4) the row the Lead was looking at belongs to someone else now.
  function closePanel(message = null) {
    setAssigning(null);
    setConfirmation(message);
    fetchQueue();
  }

  if (assigning) {
    return (
      <section>
        <button className="unassigned-queue__back" onClick={() => closePanel()}>
          &larr; Back to the unassigned queue
        </button>
        <AssignCoordinatorPanel
          request={assigning}
          onCancel={() => closePanel()}
          onAssigned={(_updated, chosen) =>
            closePanel(
              `${assigning.eventName} was assigned to ${chosen?.fullName ?? "the coordinator you chose"}.`,
            )
          }
        />
      </section>
    );
  }

  return (
    <section className="unassigned-queue">
      <h2>Unassigned queue</h2>

      {confirmation && <p role="status">{confirmation}</p>}
      {loading && <p>Loading...</p>}
      {error && (
        <p className="unassigned-queue__error" role="alert">
          {error}
        </p>
      )}
      {/* AC2-08. Nothing waiting is the good state, and it is said, never
          left as an empty card that could be mistaken for a failed load. */}
      {!loading && !error && queue.length === 0 && (
        <p>No event requests are waiting for a coordinator.</p>
      )}

      {/* Oldest submission first, as the server orders it; not re-sorted. */}
      <ul>
        {queue.map((request) => (
          <li key={request.id} className="unassigned-queue__item">
            <div>
              <strong>{request.eventName}</strong>
              <p>Organiser: {request.organiserName ?? "No name on record"}</p>
              <p>{formatRange(request.proposedStart, request.proposedEnd, "not set")}</p>
              <p>Expected attendance: {request.expectedAttendance ?? "not given"}</p>
              <p className="unassigned-queue__waiting">{describeWaiting(request.submittedAt, now())}</p>
            </div>
            <button
              type="button"
              aria-label={`Assign ${request.eventName}`}
              onClick={() => {
                setConfirmation(null);
                setAssigning(request);
              }}
            >
              Assign
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
