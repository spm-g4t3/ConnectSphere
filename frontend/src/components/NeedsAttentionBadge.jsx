// NeedsAttentionBadge.jsx
//
// Beside an event's status: the server sets needsAttention while a confirmed
// event has a flagged booking. Danger, the tone of an action-required status,
// so it reads like one. A missing field reads as false.

import StatusBadge from "./ui/StatusBadge";

export default function NeedsAttentionBadge({ event }) {
  if (event?.needsAttention !== true) return null;
  // The space keeps it apart from the status badge it follows inline.
  return <>{" "}<StatusBadge tone="danger">Needs attention</StatusBadge></>;
}
