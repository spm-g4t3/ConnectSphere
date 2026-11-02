// UnassignedCount.jsx
//
// SCRUM-487 AC4 (SCRUM-543): at the top of the Lead's overview, how many
// requests are waiting for a coordinator, with a link to the queue where they
// are assigned.
//
// Counted from listUnassignedEventRequests, the queue's own read, not a count
// route of its own (SCRUM-487 D5). The queue is already Lead-only, and a
// second route would be a second definition of "unassigned" to keep in step
// with the queue it links to. The cost is reading rows to count them; the
// queue is short by nature, since requests leave it as they are assigned.
//
// A failure here never takes the page down: the count says it could not be
// loaded, and the coordinators and events below load as usual. Said as a
// polite status, not an alert: the number is a pointer to another page, and
// the alert on this page is kept for the events list it is about.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { canRetryRead } from "../services/apiErrors";
import { listUnassignedEventRequests } from "../services/eventRequestService";
import Button from "./ui/Button";
import LoadingText from "./ui/LoadingText";

function describeCount(count) {
  if (count === 0) return "No requests are waiting for a coordinator.";
  if (count === 1) return "1 request is waiting for a coordinator.";
  return `${count} requests are waiting for a coordinator.`;
}

export default function UnassignedCount() {
  const [count, setCount] = useState(null);
  const [error, setError] = useState(null); // { retryable }

  // State is set only in the callbacks, so the first read sets none before it answers.
  const load = useCallback(
    () =>
      listUnassignedEventRequests().then(
        (requests) => setCount(requests.length),
        (err) => setError({ retryable: canRetryRead(err) }),
      ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  function retry() {
    setError(null);
    load();
  }

  return (
    <div className="assigned-events__unassigned">
      {error && (
        <>
          <p role="status">The number of waiting requests could not be loaded.</p>
          {error.retryable && (
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          )}
        </>
      )}
      {!error && count === null && <LoadingText />}
      {!error && count !== null && <p role="status">{describeCount(count)}</p>}
      <Link to="/unassigned-queue">Open the Unassigned Queue</Link>
    </div>
  );
}
