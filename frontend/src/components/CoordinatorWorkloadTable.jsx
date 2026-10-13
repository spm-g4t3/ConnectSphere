// CoordinatorWorkloadTable.jsx
//
// SCRUM-487 AC2 (SCRUM-544): every Event Coordinator, with their number of
// active events and the count in each status, for the Lead's overview.
//
// Presentational: AssignedEvents reads GET /coordinator-overview once and
// hands the rows here, because the same rows also fill the events list's
// coordinator filter. One read for both, not a second call to
// /coordinator-workload, which is the assignment picker's.
//
// Two orders are the server's and are kept as they arrive:
//  - the rows, by name. Never re-sorted by workload: SCRUM-486 AC3 says the
//    system suggests nobody, and a table sorted by count would put a
//    suggestion at the top in all but name;
//  - the status columns, the keys of byStatus. The server builds them from
//    ACTIVE_EVENT_STATUSES, so when SCRUM-488 adds the safety statuses they
//    appear here as columns with no change (SCRUM-487 D4).
//
// labelOf names each column (see AssignedEvents for where the words come from).
// A zero is shown as 0, never blank: blank would read as "not known".

/**
 * @param {object} props
 * @param {Array<{id: string, fullName: string|null, activeEvents: number, byStatus: Object<string, number>}>} props.coordinators
 * @param {string[]} props.statuses           the byStatus keys, in the server's order
 * @param {(status: string) => string} props.labelOf
 * @param {boolean} props.loading
 * @param {boolean} props.failed
 */
export default function CoordinatorWorkloadTable({ coordinators, statuses, labelOf, loading, failed }) {
  // Said as a polite status, not an alert: the events below still load, and
  // the page keeps its one alert for the list it is about (SCRUM-543).
  if (loading) return <p role="status">Loading coordinators...</p>;
  if (failed) return <p role="status">The coordinators&apos; workload could not be loaded.</p>;
  if (coordinators.length === 0) return <p>There are no Event Coordinators.</p>;

  return (
    <table className="coordinator-workload">
      <thead>
        <tr>
          <th scope="col">Coordinator</th>
          <th scope="col">Active events</th>
          {statuses.map((status) => (
            <th key={status} scope="col">{labelOf(status)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {coordinators.map((coordinator) => (
          <tr key={coordinator.id}>
            <th scope="row">{coordinator.fullName ?? "No name on record"}</th>
            <td>{coordinator.activeEvents}</td>
            {statuses.map((status) => (
              <td key={status}>{coordinator.byStatus[status] ?? 0}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
