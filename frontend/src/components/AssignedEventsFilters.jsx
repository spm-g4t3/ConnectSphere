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
// The statuses offered are the overview response's, each with its label
// (SCRUM-546, SCRUM-487 D9), in the server's order:
//  - the active ones, always: built from ACTIVE_EVENT_STATUSES, so SCRUM-488's
//    safety statuses arrive here too;
//  - the finished ones (finished: true), only while "Include completed,
//    rejected and cancelled" is ticked. With it off, the server hides
//    finished events, so a finished status could only ever answer "nothing".
//    Which statuses are finished is the server's word too (its
//    FINISHED_EVENT_STATUSES, SCRUM-542); until SCRUM-546 this file kept its
//    own copy of the list;
//  - never draft, which the response does not name.
//
// Unticking the box while a finished status is chosen resets the status to
// "All statuses": the option the Lead chose would no longer be on offer, and
// a select showing a value it does not list would mislead.

/**
 * @param {object} props
 * @param {Array<{id: string, fullName: string|null}>} props.coordinators
 * @param {Array<{status: string, label: string, finished: boolean}>} props.statuses  in the server's order
 * @param {{coordinatorId: string, status: string, includeFinished: boolean}} props.filters
 * @param {(filters: {coordinatorId: string, status: string, includeFinished: boolean}) => void} props.onChange
 */
export default function AssignedEventsFilters({ coordinators, statuses, filters, onChange }) {
  const offered = statuses.filter((entry) => filters.includeFinished || !entry.finished);
  const finished = new Set(statuses.filter((entry) => entry.finished).map((entry) => entry.status));

  function setIncludeFinished(includeFinished) {
    const keepsStatus = includeFinished || !finished.has(filters.status);
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
        {offered.map(({ status, label }) => (
          <option key={status} value={status}>{label}</option>
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
