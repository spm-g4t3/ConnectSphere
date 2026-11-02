// UnassignedQueue.jsx
//
// SCRUM-486 (SCRUM-519), AC2: every submitted request nobody has been
// assigned yet, oldest submission first, for the Event Coordinator Lead to
// assign; and the assignment panel each row opens into (AC3).
//
// SCRUM-539 adds the Lead's cancel: each row also opens a cancel panel, since
// nobody else may cancel a request nobody holds.
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
import { formatDateTimeRange } from "../services/displayFormat";
import { describeWaiting } from "../services/waitingTime";
import AssignCoordinatorPanel from "./AssignCoordinatorPanel";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import UnassignedRequestCancelPanel from "./UnassignedRequestCancelPanel";
import useListRead from "./useListRead";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";

// 403 has its own words, as in ReviewQueue: it means the account is not a
// Lead, an administration problem, not a breakage.
const QUEUE_ERROR_MESSAGES = {
  403: "Only the Event Coordinator Lead can see the unassigned queue.",
  500: "The unassigned queue could not be loaded.",
};

/**
 * @param {object} props
 * @param {Function} [props.now]  the clock "waiting" is measured against;
 *                                injected by tests, the reader's otherwise
 * @param {boolean} [props.asPage]  true at /unassigned-queue, where the title
 *                                  is the page's h1; on the dashboard it is h2
 */
export default function UnassignedQueue({ now = () => new Date(), asPage = false }) {
  // The open panel, { kind: "assign" | "cancel", request }, or null for the
  // list: one state, so only one panel can be open.
  const [panel, setPanel] = useState(null);
  // What the last assignment did, said once back on the list.
  const [confirmation, setConfirmation] = useState(null);

  const {
    data: queue,
    loading,
    error,
    retryable,
    load: fetchQueue,
  } = useListRead(listUnassignedEventRequests, {
    messages: QUEUE_ERROR_MESSAGES,
    fallback: "The unassigned queue could not be loaded.",
  });

  // Refetch when the Lead comes back to the tab, as ReviewQueue does: new
  // requests arrive, and other Leads assign them, while nobody is looking.
  useRefetchOnReturn(fetchQueue);

  // Back to the list, re-read either way. After an assignment the row has
  // gone; after a cancel the list may still be stale, and after a lost race
  // (AC4) the row the Lead was looking at belongs to someone else now.
  function closePanel(message = null) {
    setPanel(null);
    setConfirmation(message);
    fetchQueue();
  }

  const Title = asPage ? "h1" : "h2";

  // Both panels share one back link, drawn here. On its own page the h1 stays
  // above the panel, so the page keeps its one h1 and the panel's h2 sits under it.
  if (panel) {
    return (
      <section>
        {asPage && <h1>Unassigned queue</h1>}
        <Button variant="link" onClick={() => closePanel()}>
          &larr; Back to the unassigned queue
        </Button>
        {panel.kind === "assign" ? (
          <AssignCoordinatorPanel
            request={panel.request}
            onCancel={() => closePanel()}
            onAssigned={(_updated, chosen) =>
              closePanel(
                `${panel.request.eventName} was assigned to ${chosen?.fullName ?? "the coordinator you chose"}.`,
              )
            }
          />
        ) : (
          <UnassignedRequestCancelPanel
            request={panel.request}
            onCancelled={() => closePanel(`${panel.request.eventName} was cancelled. The organiser has been told.`)}
          />
        )}
      </section>
    );
  }

  return (
    <section className="unassigned-queue">
      {/* Counted only after a read succeeds, so a loading or failed list is never counted. */}
      <Title>
        Unassigned queue
        {!loading && !error && (
          <>
            {" "}
            <span className="unassigned-queue__count">({queue.length})</span>
          </>
        )}
      </Title>

      {confirmation && (
        <p role="status" className="unassigned-queue__confirmation">
          {confirmation}
        </p>
      )}
      {loading && <LoadingText />}
      {/* Hidden while a read is in flight, so Try again cannot start a second one. */}
      {error && !loading && <ErrorNotice message={error} onRetry={retryable ? fetchQueue : undefined} />}
      {/* AC2-08. Nothing waiting is the good state, and it is said, never
          left as an empty card that could be mistaken for a failed load. */}
      {!loading && !error && queue.length === 0 && (
        <EmptyState
          message="No event requests are waiting for a coordinator."
          nextStep="New requests appear here when organisers submit them."
        />
      )}

      {/* Oldest submission first, as the server orders it; not re-sorted. */}
      <ul>
        {queue.map((request) => (
          <li key={request.id} className="unassigned-queue__item">
            <div>
              <strong>{request.eventName}</strong>
              <p>Organiser: {request.organiserName ?? "No name on record"}</p>
              <p>{formatDateTimeRange(request.proposedStart, request.proposedEnd, "not set")}</p>
              <p>Expected attendance: {request.expectedAttendance ?? "not given"}</p>
              <p className="unassigned-queue__waiting">{describeWaiting(request.submittedAt, now())}</p>
            </div>
            <div className="unassigned-queue__actions">
              <Button
                aria-label={`Assign ${request.eventName}`}
                onClick={() => {
                  setConfirmation(null);
                  setPanel({ kind: "assign", request });
                }}
              >
                Assign
              </Button>
              <Button
                variant="danger"
                aria-label={`Cancel ${request.eventName}`}
                onClick={() => {
                  setConfirmation(null);
                  setPanel({ kind: "cancel", request });
                }}
              >
                Cancel request
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
