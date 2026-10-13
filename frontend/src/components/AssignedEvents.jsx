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
// filters, no counts, no actions of its own. It is the first slice of
// SCRUM-487 AC3's list, which will extend it rather than replace it.
//
// Built the way UnassignedQueue is: a <section> that takes its card styling
// and badge colours from the wrapper App.jsx mounts it in, a status-keyed
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
//     from GET /coordinator-overview;
//  3. the events, filtered on the server (AC3, AssignedEventsFilters, then
//     the list SCRUM-486 built), with the coordinator filter filled from the
//     same overview read.
//
// Each of the three reads has its own loading, failure and empty state, so
// one failing never takes the others down. Only the list's failure is an
// alert: the list is what the page is for, and SCRUM-486's tests find its
// failure as the page's one alert.
//
// The words for each status, in the table's headings and the status filter.
// Neither the API nor the frontend has a label for a bare status key: labels
// arrive only as each event row's statusDisplay. So a status is named by the
// label of an event row seen with it, kept across reloads so a heading does
// not change as the filters change, and otherwise by the raw key. Rejected:
// a label table written here, a second copy of the status vocabulary
// eventRequestStatus.js owns, which is what statusDisplay exists to avoid.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import UnassignedCount from "./UnassignedCount";
import CoordinatorWorkloadTable from "./CoordinatorWorkloadTable";
import AssignedEventsFilters from "./AssignedEventsFilters";
import { listAssignedEventsForLead, listCoordinatorOverview } from "../services/eventRequestService";
import { formatTimestamp } from "../services/displayFormat";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";

// 403 has its own words, as in UnassignedQueue: it means the account is not a
// Lead, an administration problem, not a breakage.
//
// SCRUM-487 (SCRUM-544): 400 is a filter the server refused. Said in words of
// this page's own, never the server's text.
const LIST_ERROR_MESSAGES = {
  400: "Those filters could not be applied.",
  401: "Your session has expired. Please sign in again.",
  403: "Only the Event Coordinator Lead can see the assigned events.",
  500: "The assigned events could not be loaded. Please try again.",
};

const NO_FILTERS = Object.freeze({ coordinatorId: "", status: "", includeFinished: false });

export default function AssignedEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(NO_FILTERS);
  // status -> label, from every event row seen so far (see the header).
  const [labels, setLabels] = useState({});

  const [coordinators, setCoordinators] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewFailed, setOverviewFailed] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setCoordinators(await listCoordinatorOverview());
      } catch {
        setOverviewFailed(true);
      } finally {
        setOverviewLoading(false);
      }
    }

    load();
  }, []);

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
        setLabels((known) => {
          const next = { ...known };
          for (const row of rows) {
            if (row.statusDisplay?.label && !next[row.status]) next[row.status] = row.statusDisplay.label;
          }
          return next;
        });
      } catch (err) {
        if (ignore) return;
        setEvents([]);
        setError(
          LIST_ERROR_MESSAGES[err.response?.status] ||
            "The assigned events could not be loaded. Please try again.",
        );
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [filters]);

  const labelOf = (status) => labels[status] ?? status;
  // The byStatus keys, in the server's order: every coordinator has all of them.
  const activeStatuses = coordinators.length > 0 ? Object.keys(coordinators[0].byStatus) : [];
  const filtered = filters.coordinatorId !== "" || filters.status !== "" || filters.includeFinished;

  return (
    <section className="assigned-events">
      <h2>Assigned events</h2>
      <p>Every coordinator&apos;s events and workload.</p>

      {/* SCRUM-487 AC4 (SCRUM-543): the requests nobody holds yet, counted,
          with the way to the queue. Counted, not listed (SCRUM-487 D5): this
          list is of held events, and the queue is where the rest are acted on. */}
      <UnassignedCount />

      {/* SCRUM-487 AC2 (SCRUM-544). */}
      <h3>Coordinators</h3>
      <CoordinatorWorkloadTable
        coordinators={coordinators}
        statuses={activeStatuses}
        labelOf={labelOf}
        loading={overviewLoading}
        failed={overviewFailed}
      />

      {/* SCRUM-487 AC3 (SCRUM-544). */}
      <h3>Events</h3>
      <AssignedEventsFilters
        coordinators={coordinators}
        activeStatuses={activeStatuses}
        labelOf={labelOf}
        filters={filters}
        onChange={setFilters}
      />

      {loading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      {/* Nothing held is said, never left as an empty card that could be
          mistaken for a failed load. With filters set, the words say the
          filters found nothing, not that nobody holds anything. */}
      {!loading && !error && events.length === 0 && (
        <p>{filtered ? "No events match these filters." : "No coordinator is holding an active event."}</p>
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
                  <span className={`status-badge ${statusClassName(display.group)}`}>
                    {display.label}
                  </span>
                </span>
                <span className="my-assigned-events__meta">
                  <span>{formatTimestamp(event.proposedStart, "Date not set")}</span>
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
