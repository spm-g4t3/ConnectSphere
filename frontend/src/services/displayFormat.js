// displayFormat.js
//
// Small display helpers shared by more than one component. Moved out of
// VenueDetail.jsx unchanged by SCRUM-125, when BlockConflictList needed the
// same identifier and timestamp rendering.
//
// CoordinatorRequestDetail.jsx still carries its own copy of formatTimestamp;
// moving it here is a separate refactor, not part of a feature subtask.

/** First segment of a uuid, for display. The full value goes in a title. */
export function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id);
}

/**
 * A timestamp in the reader's locale, or the raw string if it will not parse.
 *
 * `fallback` is what a missing value reads as. It defaults to "unknown", which
 * is exactly what VenueDetail has always shown.
 */
export function formatTimestamp(value, fallback = "unknown") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** "<start> – <end>", each end formatted as formatTimestamp does. */
export function formatRange(startsAt, endsAt, fallback) {
  return `${formatTimestamp(startsAt, fallback)} – ${formatTimestamp(endsAt, fallback)}`;
}
