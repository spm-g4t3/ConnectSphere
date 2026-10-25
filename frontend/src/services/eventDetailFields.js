// eventDetailFields.js
//
// SCRUM-387: the fields an event's assigned coordinator may edit directly, and
// in which statuses. Mirrors backend/src/domain/eventDetailField.js, which a
// test reads as text and compares with this copy; the labels are the
// frontend's own, the ones EventRequestForm shows the Organiser.
//
// Ordinary fields describe the event. Significant ones change what is or will
// be arranged, so once an event is in planning they go through Revise event
// details (SCRUM-395) instead.

export const ORDINARY_DETAIL_FIELDS = Object.freeze(["eventName", "purpose", "description"]);

export const SIGNIFICANT_DETAIL_FIELDS = Object.freeze([
  "proposedStart",
  "proposedEnd",
  "expectedAttendance",
  "venueRequirements",
  "accessibilityRequirements",
  "equipmentRequirements",
]);

export const DETAIL_FIELDS = Object.freeze([...ORDINARY_DETAIL_FIELDS, ...SIGNIFICANT_DETAIL_FIELDS]);

export const DETAIL_FIELD_LABELS = Object.freeze({
  eventName: "Event name",
  purpose: "Purpose",
  description: "Description",
  proposedStart: "Proposed start",
  proposedEnd: "Proposed end",
  expectedAttendance: "Expected attendance",
  venueRequirements: "Venue requirements",
  accessibilityRequirements: "Accessibility requirements",
  equipmentRequirements: "Equipment requirements",
});

/** Nothing is arranged yet, so any field may change (AC2). */
export const STATUSES_ALLOWING_ANY_EDIT = Object.freeze(["under_review", "pending_clarification"]);

/** Any edit in review; ordinary fields only in planning and the safety check (AC3). */
export const STATUSES_ALLOWING_ORDINARY_EDITS = Object.freeze([
  ...STATUSES_ALLOWING_ANY_EDIT,
  "approved",
  "safety_review",
  "safety_approved",
]);

/** The fields the edit form shows for an event in `status`; none outside the five. */
export function editableDetailFields(status) {
  if (STATUSES_ALLOWING_ANY_EDIT.includes(status)) return DETAIL_FIELDS;
  if (STATUSES_ALLOWING_ORDINARY_EDITS.includes(status)) return ORDINARY_DETAIL_FIELDS;
  return [];
}

/**
 * A field's label. A name this build does not know, such as SCRUM-395's
 * `equipment` history rows, is spelled out from its camelCase ("Equipment").
 */
export function detailFieldLabel(field) {
  if (Object.hasOwn(DETAIL_FIELD_LABELS, field)) return DETAIL_FIELD_LABELS[field];
  const words = String(field ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "A field";
}

/** Fields as one phrase of labels: "Event name, Purpose and Description". */
export function detailFieldList(fields) {
  const labels = fields.map(detailFieldLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "");
}
