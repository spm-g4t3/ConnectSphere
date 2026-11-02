// EquipmentHistory.jsx
//
// SCRUM-280, AC8. Who changed what on one equipment type, newest first, as the
// backend returns it. The note column is where a damage or maintenance change
// explains itself.

import { useCallback, useEffect, useRef, useState } from "react";
import { getEquipmentHistory } from "../services/equipmentService";
import { canRetryEquipmentRead, equipmentErrorMessages } from "../services/equipmentErrors";
import { describeChange } from "../services/equipmentHistoryDisplay";
import { formatDateTime, shortId } from "../services/displayFormat";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";

export default function EquipmentHistory({ type, titleRef }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null); // { message, retryable }
  // A response that arrives after the panel closes is dropped.
  const mounted = useRef(true);

  useEffect(() => {
    // Set here as well as initially, so StrictMode's remount turns it back on.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    () =>
      getEquipmentHistory(type.id).then(
        (data) => mounted.current && setEntries(data),
        (err) =>
          mounted.current &&
          setError({ message: equipmentErrorMessages(err, "history")[0], retryable: canRetryEquipmentRead(err) }),
      ),
    [type.id],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Try again goes away while the read reloads. This panel has no heading of its
  // own, so focus goes to the panel's title rather than the page body.
  async function retry() {
    setError(null);
    await load();
    titleRef?.current?.focus();
  }

  return (
    <div>
      {error && <ErrorNotice message={error.message} onRetry={error.retryable ? retry : undefined} />}
      {!error && entries === null && <LoadingText />}
      {entries?.length === 0 && (
        <EmptyState message="No changes recorded." nextStep="Changes to this equipment type will appear here." />
      )}
      {entries?.length > 0 && (
        <table className="equipment-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Note</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDateTime(entry.changedAt)}</td>
                <td>{describeChange(entry)}</td>
                <td>{entry.note ?? ""}</td>
                <td title={entry.changedBy ?? ""}>{entry.changedBy ? shortId(entry.changedBy) : "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
