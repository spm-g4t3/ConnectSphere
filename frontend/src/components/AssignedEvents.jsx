// AssignedEvents.jsx
//
// SCRUM-486 AC6: every event someone holds in an active status, earliest
// event first, for the Event Coordinator Lead, each opening the event's own
// page (/event-requests/:id), where the Lead hands it to another coordinator.
//
// Why it exists. The Lead could already reassign from that page (SCRUM-521),
// but nothing linked a Lead to it: an assigned request leaves the unassigned
// queue, and the coordinators' queue and My events are theirs. The Lead could
// reach an event only by typing its address, which is not "reassign events
// where necessary" (change 5). This is the smallest list that closes that: no
// filters, no counts, no actions of its own. It was the first slice of
// SCRUM-487 AC3's list, and SCRUM-487 extended it rather than replacing it
// (below).
//
// Built the way UnassignedQueue is: a <section> that takes its card styling
// from the wrapper App.jsx mounts it in, a status-keyed
// error table, and loading, error and empty states said in words. The rows
// borrow My events' row classes, so the two lists of events look alike
// without a stylesheet of their own. No refetch on focus: the Lead leaves this
// page to act, and coming back mounts it again, which reads the list again.
//
// SCRUM-487 (SCRUM-543, SCRUM-544) extends this page into the Lead's
// coordinator overview rather than building a second one (SCRUM-487 D1):
// two lists of the same events would be built twice and could disagree. The
// route, /assigned-events, and the nav label, "Assigned Events", stay as
// SCRUM-486 named them; renaming would rename SCRUM-485's and SCRUM-486's
// pinned nav tests while SCRUM-486's PR is still in review. Top to bottom:
//
//  1. the unassigned count (AC4, UnassignedCount);
//  2. every coordinator with their counts (AC2, CoordinatorWorkloadTable),
//     from GET /coordinator-overview, which also names each status;
//  3. the events, filtered on the server (AC3, AssignedEventsFilters, then
//     the list SCRUM-486 built), with the coordinator filter filled from the
//     same overview read.
//
// Each of the three reads has its own loading, failure and empty state, so
// one failing never takes the others down. Only the list's failure is an
// alert (ErrorNotice): the list is what the page is for, and SCRUM-486's tests
// find its failure as the page's one alert. The other two say theirs politely,
// each with its own Try again.
//
// The words for each status, in the table's headings and the status filter,
// come from the overview response's statuses: { status, label, finished },
// each label getStatusDisplay's, the same words as every status badge
// (SCRUM-546, SCRUM-487 D9). Until SCRUM-546 this page collected each word
// from an event row it had loaded with that status, and showed the raw key
// (pending_clarification) for a status no row had shown, so a heading
// depended on what the filters had fetched. Rejected then and now: a label
// table written here, a second copy of the vocabulary eventRequestStatus.js
// owns.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import UnassignedCount from "./UnassignedCount";
import CoordinatorWorkloadTable from "./CoordinatorWorkloadTable";
import AssignedEventsFilters from "./AssignedEventsFilters";
import { listAssignedEventsForLead, listCoordinatorOverview } from "../services/eventRequestService";
import { canRetryRead } from "../services/apiErrors";
import { formatDateTime } from "../services/displayFormat";
import { readStatusDisplay, statusTone } from "../services/eventRequestStatusDisplay";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import StatusBadge from "./ui/StatusBadge";
import useFocusAfterRetry from "./useFocusAfterRetry";

// 403 has its own words, as in UnassignedQueue: it means the account is not a
// Lead, an administration problem, not a breakage.
//
// SCRUM-487 (SCRUM-544): 400 is a filter the server refused. Said in words of
// this page's own, never the server's text.
const LIST_ERROR_MESSAGES = {
  400: "Those filters could not be applied.",
  403: "Only the Event Coordinator Lead can see the assigned events.",
  500: "The assigned events could not be loaded.",
};

const NO_FILTERS = Object.freeze({ coordinatorId: "", status: "", includeFinished: false });

export default function AssignedEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { message, retryable }
  const [filters, setFilters] = useState(NO_FILTERS);
  // Bumped by Try again, so the list effect reads the same filters again.
  const [listAttempt, setListAttempt] = useState(0);

  // The overview: { statuses, coordinators }, read once for the table and
  // the filters.
  const [statuses, setStatuses] = useState([]);
  const [coordinators, setCoordinators] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState(null); // { retryable }

  // State is set only in the callbacks, so the first read sets none before it answers.
  const loadOverview = useCallback(
    () =>
      listCoordinatorOverview()
        .then((overview) => {
          setStatuses(overview.statuses);
          setCoordinators(overview.coordinators);
        })
        .catch((err) => setOverviewError({ retryable: canRetryRead(err) }))
        .finally(() => setOverviewLoading(false)),
    [],
  );

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // Loading starts true, so only a retry needs to raise it.
  function reloadOverview() {
    setOverviewLoading(true);
    setOverviewError(null);
    return loadOverview();
  }
  // Each Try again goes away as its read starts, so focus moves to the heading
  // of its section instead of falling to the page body.
  const { headingRef: coordinatorsHeadingRef, retry: retryOverview } = useFocusAfterRetry(reloadOverview);
  const { headingRef: eventsHeadingRef, retry: retryList } = useFocusAfterRetry(
    useCallback(() => setListAttempt((attempt) => attempt + 1), []),
  );

  // Read again on every change of filters. A change made while a read is in
  // flight starts another, and the two can answer in either order, so each
  // read checks it is still the latest before writing anything: `ignore` is
  // set when the next read starts (or the page goes). Without it, a slow
  // answer to the old filters could overwrite the new filters' rows, and the
  // list would show events the filters say it should not.
  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const rows = await listAssignedEventsForLead(filters);
        if (ignore) return;
        setEvents(rows);
      } catch (err) {
        if (ignore) return;
        setEvents([]);
        setError({
          message: LIST_ERROR_MESSAGES[err.response?.status] || "The assigned events could not be loaded.",
          retryable: canRetryRead(err),
        });
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [filters, listAttempt]);

  // The table counts active events only, so its columns are the active statuses.
  const activeStatuses = statuses.filter((entry) => !entry.finished);
  const filtered = filters.coordinatorId !== "" || filters.status !== "" || filters.includeFinished;

  // The button goes as the list reloads, so focus moves to the list's heading
  // instead of falling to the page body.
  function clearFilters() {
    eventsHeadingRef.current?.focus();
    setFilters(NO_FILTERS);
  }

  return (
    <section className="assigned-events">
      <h1>Assigned events</h1>
      <p>Every coordinator&apos;s events and workload.</p>

      {/* SCRUM-487 AC4 (SCRUM-543): the requests nobody holds yet, counted,
          with the way to the queue. Counted, not listed (SCRUM-487 D5): this
          list is of held events, and the queue is where the rest are acted on. */}
      <UnassignedCount />

      {/* SCRUM-487 AC2 (SCRUM-544). */}
      <h2 ref={coordinatorsHeadingRef} tabIndex={-1}>Coordinators</h2>
      <CoordinatorWorkloadTable
        coordinators={coordinators}
        statuses={activeStatuses}
        loading={overviewLoading}
        failed={overviewError !== null}
        onRetry={overviewError?.retryable ? retryOverview : undefined}
      />

      {/* SCRUM-487 AC3 (SCRUM-544). */}
      <h2 ref={eventsHeadingRef} tabIndex={-1}>Events</h2>
      <AssignedEventsFilters
        coordinators={coordinators}
        statuses={statuses}
        filters={filters}
        onChange={setFilters}
      />

      {loading && <LoadingText />}
      {error && (
        <ErrorNotice
          message={error.message}
          onRetry={error.retryable ? retryList : undefined}
        />
      )}
      {/* Nothing held is said, never left as an empty card that could be
          mistaken for a failed load. With filters set, the words say the
          filters found nothing, not that nobody holds anything. */}
      {!loading && !error && events.length === 0 && (
        filtered ? (
          <EmptyState
            message="No events match these filters."
            nextStep="Change or clear the filters to see more."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            message="No coordinator is holding an active event."
            nextStep="Assign a request from the unassigned queue."
            action={
              <Link className="ui-button ui-button--primary" to="/unassigned-queue">
                Open the unassigned queue
              </Link>
            }
          />
        )
      )}

      {/* Earliest event first, as the server orders it; not re-sorted. */}
      <ul>
        {events.map((event) => {
          // Labels come from the API, so this component never interprets a status.
          const display = readStatusDisplay(event);

          return (
            <li key={event.id} className="my-assigned-events__row">
              <div className="my-assigned-events__summary">
                <span className="my-assigned-events__title">
                  <strong>{event.eventName}</strong>
                  <StatusBadge tone={statusTone(display.group)}>{display.label}</StatusBadge>
                </span>
                <span className="my-assigned-events__meta">
                  <span>{formatDateTime(event.proposedStart, "Date not set")}</span>
                  <span>Organiser: {event.organiserName ?? "No name on record"}</span>
                  <span>Coordinator: {event.assignedCoordinatorName ?? "No name on record"}</span>
                </span>
              </div>
              <Link to={`/event-requests/${event.id}`} aria-label={`Open ${event.eventName}`}>
                Open
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
