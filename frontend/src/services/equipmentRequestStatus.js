// equipmentRequestStatus.js
//
// The CSS modifier for an equipment request's status badge, shared by the review
// screen and the dashboard queue. Labels come from the server (statusLabel), so a
// new status only needs a class here.

const STATUS_CLASS = {
  pending_review: "pending",
  under_review: "under",
  arranged: "arranged",
  cannot_be_fully_arranged: "cannot",
  cancelled: "cancelled",
};

/** The modifier for a status; an unknown one reads as pending. */
export function equipmentStatusClass(status) {
  return STATUS_CLASS[status] ?? "pending";
}
