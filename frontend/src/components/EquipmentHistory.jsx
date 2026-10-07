// EquipmentHistory.jsx
//
// SCRUM-280, AC8. Who changed what on one equipment type, newest first, as the
// backend returns it. The note column is where a damage or maintenance change
// explains itself.

import { useEffect, useState } from "react";
import { getEquipmentHistory } from "../services/equipmentService";
import { equipmentErrorMessages } from "../services/equipmentErrors";
import { describeChange } from "../services/equipmentHistoryDisplay";
import { formatTimestamp, shortId } from "../services/displayFormat";

export default function EquipmentHistory({ type }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getEquipmentHistory(type.id)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) setError(equipmentErrorMessages(err, "history")[0]);
      });
    return () => {
      cancelled = true;
    };
  }, [type.id]);

  return (
    <div>
      <h2>History: {type.name}</h2>
      {error && <p role="alert">{error}</p>}
      {!error && entries === null && <p>Loading history...</p>}
      {entries?.length === 0 && <p>No changes recorded.</p>}
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
                <td>{formatTimestamp(entry.changedAt)}</td>
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
