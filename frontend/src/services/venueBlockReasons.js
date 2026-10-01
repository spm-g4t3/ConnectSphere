// venueBlockReasons.js
//
// SCRUM-17 (AC1). The reasons a Venue Staff member can give for blocking a
// venue, in the order the form should offer them.
//
// The codes mirror the Postgres enum `venue_block_reason` in
// backend/db/migrations/011_venue_blocks.sql and BLOCK_REASON in
// backend/src/domain/venueBlockReason.js, in the same order. Only the labels
// are the frontend's own.

export const VENUE_BLOCK_REASONS = Object.freeze([
  Object.freeze({ code: "maintenance", label: "Maintenance" }),
  Object.freeze({ code: "renovation", label: "Renovation" }),
  Object.freeze({ code: "safety", label: "Safety" }),
  Object.freeze({ code: "internal_activity", label: "Internal activity" }),
  Object.freeze({ code: "other", label: "Other" }),
]);

const LABEL_BY_CODE = new Map(VENUE_BLOCK_REASONS.map((r) => [r.code, r.label]));

/**
 * The label for a block reason code.
 *
 * Falls back to the raw code rather than hiding it: a reason this build does
 * not know about (the backend added one) is still better shown than blank.
 *
 * @param {string} code
 * @returns {string}
 */
export function reasonLabel(code) {
  return LABEL_BY_CODE.get(code) ?? code;
}
