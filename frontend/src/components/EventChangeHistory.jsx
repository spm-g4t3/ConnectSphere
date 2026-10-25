// EventChangeHistory.jsx
//
// SCRUM-387 (SCRUM-392, AC7): every field change recorded for an event, newest
// first as the server sends it, whether the coordinator edited it directly or
// it came through a significant change (SCRUM-395). The server decides who may
// read it: the Organiser, the assigned coordinator and the Lead.

import { useEffect, useState } from "react";
import { getEventChangeHistory } from "../services/eventRequestService";
import { formatMediumTimestamp, formatTimestamp } from "../services/displayFormat";
import { TIMESTAMP_FIELDS, detailFieldLabel } from "../services/eventDetailFields";

const SOURCE_LABEL = {
  direct_edit: "Edited",
  significant_change: "Significant change",
};

/** A source this build does not know, such as SCRUM-402's change_request. */
function sourceLabel(source) {
  if (Object.hasOwn(SOURCE_LABEL, source)) return SOURCE_LABEL[source];
  if (!source) return "Recorded";
  const words = String(source).replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/** One side of a change as words: a date, a number, text, or 395's equipment flag. */
function valueText(field, value) {
  if (value === null || value === undefined || value === "") return "Not specified";
  if (TIMESTAMP_FIELDS.includes(field)) return formatTimestamp(value, "Not specified");
  if (typeof value === "object") {
    if (typeof value.changeRequested === "boolean") {
      return value.changeRequested ? "Equipment change requested" : "No equipment change";
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * @param {object} props
 * @param {string} props.eventRequestId
 */
export default function EventChangeHistory({ eventRequestId }) {
  // Tagged with the request it was read for, as DecisionHistory's is.
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getEventChangeHistory(eventRequestId)
      .then((entries) => {
        if (!cancelled) setResult({ id: eventRequestId, entries });
      })
      .catch(() => {
        if (!cancelled) setResult({ id: eventRequestId, error: "The change history could not be loaded." });
      });
    return () => {
      cancelled = true;
    };
  }, [eventRequestId]);

  if (result?.id !== eventRequestId) return <p className="event-change-history__state">Loading change history...</p>;
  if (result.error) return <p className="event-change-history__state" role="alert">{result.error}</p>;
  if (result.entries.length === 0) {
    return <p className="event-change-history__state">No changes have been recorded.</p>;
  }

  return (
    <ol className="event-change-history__list">
      {result.entries.map((entry) => (
        <li key={entry.id} className="event-change-history__entry">
          <div className="event-change-history__heading">
            <strong>{detailFieldLabel(entry.field)}</strong>
            <span className="event-change-history__source">{sourceLabel(entry.source)}</span>
          </div>
          <p className="event-change-history__values">
            {valueText(entry.field, entry.oldValue)}
            {" → "}
            {valueText(entry.field, entry.newValue)}
          </p>
          <p className="event-change-history__meta">
            {entry.changedByName ?? "A coordinator with no name on record"}
            {", "}
            {formatMediumTimestamp(entry.changedAt, "at an unrecorded time")}
          </p>
          <p className="event-change-history__reason">Reason: {entry.reason || "No reason was recorded."}</p>
        </li>
      ))}
    </ol>
  );
}
