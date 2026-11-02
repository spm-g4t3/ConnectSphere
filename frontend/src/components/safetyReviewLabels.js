import { formatDateTimeRange } from "../services/displayFormat";

export const OUTCOME_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Safety arrangement rejected",
};

export const OUTCOME_TONES = {
  approved: "success",
  changes_requested: "warning",
  rejected: "danger",
};

// The choices a Safety Officer can record, each with what it does to the event,
// so the officer sees the consequence before choosing.
export const RESPONSE_CHOICES = [
  {
    value: "approved",
    label: "Approve",
    consequence: "The event moves to Safety approved. The organiser and coordinator are notified.",
  },
  {
    value: "changes_requested",
    label: "Request changes",
    consequence:
      "The event goes back to planning to change the items you mark. The organiser and coordinator are notified with your note.",
  },
  {
    value: "rejected",
    label: "Reject the safety arrangement",
    consequence:
      "The arrangement cannot go ahead as planned. The event goes back to planning, and the organiser and coordinator are notified with your reason.",
  },
];

// The safety review API sends only the raw status, so this screen carries the
// same words the rest of the app shows for each status a reviewed event can be in.
export const EVENT_STATUS_BADGES = {
  approved: { label: "Planning", tone: "info" },
  safety_review: { label: "Safety check", tone: "accent" },
  safety_approved: { label: "Safety approved", tone: "success" },
  confirmed: { label: "Confirmed", tone: "success" },
  completed: { label: "Completed", tone: "neutral" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

// The shared range helper prints the fallback once per missing end; an event
// with no dates at all is one missing fact, so it is said once.
export function eventRange(startsAt, endsAt, fallback) {
  if (!startsAt && !endsAt) return fallback;
  return formatDateTimeRange(startsAt, endsAt, fallback);
}
