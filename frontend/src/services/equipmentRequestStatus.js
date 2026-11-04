// equipmentRequestStatus.js
//
// The StatusBadge tone for an equipment request's status, shared by the review
// screen and the dashboard lists. Labels come from the server (statusLabel), so a
// new status only needs a tone here.

const STATUS_TONE = {
  pending_review: "warning",
  under_review: "info",
  arranged: "success",
  cannot_be_fully_arranged: "danger",
  cancelled: "neutral",
};

/** The tone for a status; an unknown one reads as pending (warning). */
export function equipmentStatusTone(status) {
  return STATUS_TONE[status] ?? "warning";
}
