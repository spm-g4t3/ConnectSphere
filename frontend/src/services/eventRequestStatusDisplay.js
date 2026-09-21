// eventRequestStatusDisplay.js
//
// Mirrors backend/src/domain/eventRequestStatus.js's STATUS_DISPLAY table.
// That module is deliberately pure and framework-free specifically so it can
// be reasoned about independently — this frontend copy follows the same
// spirit. If the backend's status vocabulary changes, this file must be
// updated to match, or labels will silently go stale. Consider asking your
// backend teammate to expose this as a small shared package later so the
// two can never drift, rather than hand-syncing indefinitely.

const STATUS_DISPLAY = {
  draft: {
    label: "Draft",
    group: "DRAFT",
    className: "status--draft",
    description: "Not yet submitted. You can keep editing it.",
  },
  submitted: {
    label: "Submitted",
    group: "AWAITING_REVIEW",
    className: "status--awaiting-review",
    description: "Received and waiting to be picked up by a Coordinator.",
  },
  under_review: {
    label: "Under Review",
    group: "UNDER_REVIEW",
    className: "status--under-review",
    description: "A Coordinator is assessing your request.",
  },
  pending_clarification: {
    label: "Action Needed",
    group: "ACTION_REQUIRED",
    className: "status--action-required",
    description: "A Coordinator needs more information from you.",
  },
  approved: {
    label: "Approved",
    group: "APPROVED",
    className: "status--approved",
    description: "Accepted. Arrangements will now begin.",
  },
  planning: {
    label: "In Planning",
    group: "APPROVED",
    className: "status--approved",
    description: "Venue and equipment arrangements are being made.",
  },
  confirmed: {
    label: "Confirmed",
    group: "CONFIRMED",
    className: "status--confirmed",
    description: "All arrangements complete. Your event is going ahead.",
  },
  completed: {
    label: "Completed",
    group: "COMPLETED",
    className: "status--completed",
    description: "This event has taken place.",
  },
  rejected: {
    label: "Rejected",
    group: "REJECTED",
    className: "status--rejected",
    description: "Not accepted. See the Coordinator notes for the reason.",
  },
  cancelled: {
    label: "Cancelled",
    group: "CANCELLED",
    className: "status--cancelled",
    description: "This event was called off.",
  },
};

/**
 * @param {string} status
 * @returns {{status, label, group, className, description}}
 */
export function getStatusDisplay(status) {
  const entry = STATUS_DISPLAY[status];
  if (entry) return { status, ...entry };

  return {
    status,
    label: status || "Unknown",
    group: "UNKNOWN",
    className: "status--unknown",
    description: "This status isn't recognised by this version of the app.",
  };
}
