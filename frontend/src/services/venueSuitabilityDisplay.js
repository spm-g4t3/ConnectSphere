// venueSuitabilityDisplay.js
//
// SCRUM-188 (AC2). How one suitability criterion's detail reads, shared by
// VenueSuitabilityResult and BookingRequestPanel's unsuitable warning so the
// check and the request word a criterion the same way.
//
// The server's `detail` names codes ("Layout banquet not offered"). Newer
// answers also carry the codes themselves, so the screen can show labels:
//
//   - Layout: { layout: code|null, offers: string[] }
//       "Layout Banquet offered" / "Layout Banquet not offered (offers:
//       Theatre, Classroom)". With no layout requested, the detail stays.
//   - Accessibility, Facilities: { missing: string[], requested: string[] }
//       "Missing: Hearing loop, Projector" when something is missing,
//       otherwise the detail ("All requested ... are provided").
//
// A code venueLookups does not know shows as itself, the same fallback the
// rest of the venue screens use, because that copy is stale by design. An
// entry without these fields -- an older stored result -- shows its detail.
//
// A services module, not part of a component, because the react-refresh lint
// rule lets component files export components only.

import { ACCESSIBILITY_FEATURES, FACILITIES, ROOM_LAYOUTS } from "./venueLookups";

/** A code's label, or the code itself when the lookup copy does not know it. */
export function labelFor(code, options) {
  return options.find((option) => option.code === code)?.label ?? code;
}

/** Codes as labels, comma-joined. */
function labelsText(codes, options) {
  return codes.map((code) => labelFor(code, options)).join(", ");
}

const CODE_LIST_OPTIONS = {
  Accessibility: ACCESSIBILITY_FEATURES,
  Facilities: FACILITIES,
};

function layoutText(criterion) {
  if (typeof criterion.layout !== "string" || !criterion.layout) return null;
  const label = labelFor(criterion.layout, ROOM_LAYOUTS);
  if (criterion.met) return `Layout ${label} offered`;
  const offers = Array.isArray(criterion.offers) ? criterion.offers : [];
  const offersText = offers.length > 0 ? labelsText(offers, ROOM_LAYOUTS) : "none";
  return `Layout ${label} not offered (offers: ${offersText})`;
}

function missingText(criterion, options) {
  const missing = Array.isArray(criterion.missing) ? criterion.missing.filter(Boolean) : [];
  return missing.length > 0 ? `Missing: ${labelsText(missing, options)}` : null;
}

/**
 * The text shown beside a criterion: labels from its structured fields when
 * it has them, otherwise the server's detail (or "" when it has neither).
 *
 * @param {{criterion?: string, met?: boolean, detail?: string, layout?: string|null,
 *   offers?: string[], missing?: string[], requested?: string[]}} criterion
 * @returns {string}
 */
export function criterionDetailText(criterion) {
  if (!criterion || typeof criterion !== "object") return "";
  let text = null;
  if (criterion.criterion === "Layout") text = layoutText(criterion);
  else if (Object.hasOwn(CODE_LIST_OPTIONS, criterion.criterion ?? "")) {
    text = missingText(criterion, CODE_LIST_OPTIONS[criterion.criterion]);
  }
  return text ?? criterion.detail ?? "";
}
