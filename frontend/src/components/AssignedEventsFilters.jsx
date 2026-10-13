// AssignedEventsFilters.jsx
//
// SCRUM-487 AC3 (SCRUM-544): the events list's filters: by coordinator, by
// status, and whether to include finished events.
//
// Controlled: AssignedEvents owns the filters and refetches the list on each
// change, because the server does the filtering (SCRUM-487 D2). Finished
// events only grow, so filtering here would mean fetching every one of them
// to hide most.
//
// The coordinators are the overview's rows, the same read as the table above,
// so the filter offers exactly the coordinators the table shows.
//
// The statuses offered:
//  - the active ones, in the server's order: the byStatus keys of the
//    overview, built from ACTIVE_EVENT_STATUSES, so SCRUM-488's safety
//    statuses arrive here too;
//  - the finished ones, only while "Include completed, rejected and
//    cancelled" is ticked. With it off, the server hides finished events, so a
//    finished status could only ever answer "nothing". FINISHED_STATUSES is
//    the server's FINISHED_EVENT_STATUSES (SCRUM-542) and what the checkbox's
//    own label names; the server refuses any other value with a 400, so a
//    drift between the two would be seen, not silent.
//  - never draft, which is nobody's event to supervise.
//
// Unticking the box while a finished status is chosen resets the status to
// "All statuses": the option the Lead chose would no longer be on offer, and
// a select showing a value it does not list would mislead.

const FINISHED_STATUSES = ["completed", "rejected", "cancelled"];

/**
 * @param {object} props
 * @param {Array<{id: string, fullName: string|null}>} props.coordinators
 * @param {string[]} props.activeStatuses                 in the server's order
 * @param {(status: string) => string} props.labelOf
 * @param {{coordinatorId: string, status: string, includeFinished: boolean}} props.filters
 * @param {(filters: {coordinatorId: string, status: string, includeFinished: boolean}) => void} props.onChange
 */
export default function AssignedEventsFilters({ coordinators, activeStatuses, labelOf, filters, onChange }) {
  const statuses = filters.includeFinished ? [...activeStatuses, ...FINISHED_STATUSES] : activeStatuses;

  function setIncludeFinished(includeFinished) {
    const keepsStatus = includeFinished || !FINISHED_STATUSES.includes(filters.status);
    onChange({ ...filters, includeFinished, status: keepsStatus ? filters.status : "" });
  }

  return (
    <div className="assigned-events__filters">
      <label htmlFor="assigned-events-coordinator">Coordinator</label>
      <select
        id="assigned-events-coordinator"
        value={filters.coordinatorId}
        onChange={(event) => onChange({ ...filters, coordinatorId: event.target.value })}
      >
        <option value="">All coordinators</option>
        {coordinators.map((coordinator) => (
          <option key={coordinator.id} value={coordinator.id}>
            {coordinator.fullName ?? "No name on record"}
          </option>
        ))}
      </select>

      <label htmlFor="assigned-events-status">Status</label>
      <select
        id="assigned-events-status"
        value={filters.status}
        onChange={(event) => onChange({ ...filters, status: event.target.value })}
      >
        <option value="">All statuses</option>
        {statuses.map((status) => (
          <option key={status} value={status}>{labelOf(status)}</option>
        ))}
      </select>

      <input
        id="assigned-events-include-finished"
        type="checkbox"
        checked={filters.includeFinished}
        onChange={(event) => setIncludeFinished(event.target.checked)}
      />
      <label htmlFor="assigned-events-include-finished">Include completed, rejected and cancelled</label>
    </div>
  );
}
