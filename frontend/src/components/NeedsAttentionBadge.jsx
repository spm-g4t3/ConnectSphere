// NeedsAttentionBadge.jsx
//
// Beside an event's status: the server sets needsAttention while a confirmed
// event has a flagged booking. Styled as an action-required status so every
// screen that colours statuses colours it too. A missing field reads as false.

import { statusClassName } from "../services/eventRequestStatusDisplay";

export default function NeedsAttentionBadge({ event }) {
  if (event?.needsAttention !== true) return null;
  return <span className={`status-badge ${statusClassName("ACTION_REQUIRED")}`}>Needs attention</span>;
}
