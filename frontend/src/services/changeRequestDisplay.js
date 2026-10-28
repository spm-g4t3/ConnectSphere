// changeRequestDisplay.js
//
// SCRUM-402: how a change request reads, on the coordinator's review panel, the
// Organiser's status list and the notices. The field labels are keyed by the
// enum member each row carries (change_field), not by the form's option, since
// accessibility and "Something else" both travel as `other`.

import { formatTimestamp } from "./displayFormat";

export const CHANGE_FIELD_LABELS = Object.freeze({
  event_name: "Event name",
  description: "Description",
  purpose: "Purpose",
  proposed_start: "Proposed start date/time",
  proposed_end: "Proposed end date/time",
  expected_attendance: "Expected attendance",
  venue: "Venue requirements",
  equipment: "Equipment requirements",
  other: "Something else",
  cancellation: "Cancel the event",
});

/** A change field's label; a member this build does not know reads as "A change". */
export function changeFieldLabel(field) {
  return Object.hasOwn(CHANGE_FIELD_LABELS, field) ? CHANGE_FIELD_LABELS[field] : "A change";
}

/** Labels as one phrase: "Purpose, Expected attendance and Venue requirements". */
export function changeFieldList(fields) {
  const labels = fields.map(changeFieldLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "");
}

// Every decision a row can carry. event_rejected is SCRUM-347's (Rae's #85),
// which closes open requests when an approved event is rejected.
const OUTCOME_LABELS = Object.freeze({
  approved: "Accepted",
  rejected: "Declined",
  event_cancelled: "Closed: the event was cancelled",
  event_rejected: "Closed: the event was rejected",
});

/** The outcome's words, or null while the request is open; an unknown value is "Closed". */
export function outcomeLabel(decision) {
  if (!decision) return null;
  return Object.hasOwn(OUTCOME_LABELS, decision) ? OUTCOME_LABELS[decision] : "Closed";
}

// What accepting does with each class preview_change_request (036) gives a row.
const CLASS_LABELS = Object.freeze({
  ordinary: "Applied directly",
  significant: "Re-checks bookings",
  equipment: "Equipment change",
  cancellation: "Cancels the event",
  other: "Recorded only",
});

export function changeClassLabel(changeClass) {
  return Object.hasOwn(CLASS_LABELS, changeClass) ? CLASS_LABELS[changeClass] : "Recorded only";
}

const DATE_FIELDS = new Set(["proposed_start", "proposed_end"]);

/**
 * A current or requested value as words. Both sides go through this one
 * formatter, so an unchanged date never looks changed.
 */
export function formatChangeValue(changeField, value) {
  if (value === null || value === undefined || value === "") return "Not set";
  if (DATE_FIELDS.has(changeField)) return formatTimestamp(value, "Not set");
  return String(value);
}

/**
 * Flat rows, oldest first as the API sends them, as one entry per submission:
 * the open groups first, then the processed ones, each kept in the order the
 * API sent it. A row from before SCRUM-402 is its own group.
 */
export function groupChangeRequests(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row.requestGroupId ?? row.id;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        rows: [],
        createdAt: row.createdAt,
        organiserNote: row.organiserNote ?? null,
        decision: row.decision ?? null,
        decisionNotes: row.decisionNotes ?? null,
        processedAt: row.processedAt ?? null,
      });
    }
    groups.get(id).rows.push(row);
  }
  const all = [...groups.values()].map((group) => ({ ...group, open: !group.decision }));
  return [...all.filter((group) => group.open), ...all.filter((group) => !group.open)];
}
