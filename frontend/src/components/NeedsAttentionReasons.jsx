// NeedsAttentionReasons.jsx
//
// SCRUM-315 (SCRUM-310 AC6): why a Confirmed event is on the coordinator's Needs
// attention list, written under the event so the reason is read with the event.
// The server works the reasons out from the flags as they stand, so the list
// goes when the last flag is cleared. A missing or empty list shows nothing.

import { attentionReasonsOf } from "../services/equipmentFlagDisplay";

export default function NeedsAttentionReasons({ event }) {
  const reasons = attentionReasonsOf(event);
  if (reasons.length === 0) return null;
  return (
    <ul className="needs-attention-reasons" aria-label="Why this event needs attention">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}
