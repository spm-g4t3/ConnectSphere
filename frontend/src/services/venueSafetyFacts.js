// venueSafetyFacts.js
//
// SCRUM-493. The two venue safety facts -- emergency access and known
// restrictions -- as the screens show them: one set of labels and help text,
// the length limit, and what an empty value reads as.
//
// VenueForm (create and edit) and VenueDetail use these now, and the Safety
// Officer's read-only view will too, so the three screens cannot drift into
// three wordings of the same field. Lives here rather than in a component
// file because react-refresh only allows a component module to export
// components.

/**
 * Mirrors SAFETY_TEXT_MAX_LENGTH in backend/src/validation/venueValidation.js
 * and the venues_emergency_access_length / venues_known_restrictions_length
 * CHECKs in 036_venue_safety_facts.sql. Shown in the form's counter only; the
 * server is the one that refuses.
 */
export const SAFETY_TEXT_MAX_LENGTH = 2000;

/**
 * Code points, not UTF-16 units, to match Postgres char_length() and the
 * backend's checkSafetyText. With String.length an emoji counts twice, so the
 * counter would say "over" for text the server accepts.
 *
 * The same one-liner venueBlockValidation.js keeps privately for block notes.
 */
export function codePointLength(text) {
  return Array.from(text ?? "").length;
}

export const NOT_RECORDED = "Not recorded";

/**
 * Text with nothing a reader can see: whitespace plus format characters
 * (\p{Cf}: zero-width space and joiners, BOM, bidi marks) and the blank
 * "letters" that render as empty space (Braille blank U+2800, Hangul fillers
 * U+3164, U+115F, U+1160, U+FFA0). The same regex as the backend's in
 * backend/src/validation/venueValidation.js, so the screens and the server
 * agree on what counts as "nothing recorded". Keep the two in step.
 */
const INVISIBLE_ONLY = /^[\s\p{Cf}\u2800\u3164\u115F\u1160\uFFA0]*$/u;

/**
 * True only for a string that, after trim(), contains a visible character.
 * null, undefined, non-strings, "" and whitespace-or-invisible-only text are
 * all "not recorded".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecordedText(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && !INVISIBLE_ONLY.test(trimmed);
}

/**
 * A safety fact as it should read on screen: the text, or NOT_RECORDED.
 *
 * The API sends null when nothing is recorded (036 never stores blank), but a
 * backend before 036 omits the key and a hand edit could leave whitespace or
 * invisible characters (isRecordedText), so all of these read as "Not
 * recorded" rather than as an empty line that looks like the screen failed to
 * load.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function safetyFactText(value) {
  if (!isRecordedText(value)) return NOT_RECORDED;
  return value;
}

/** In display order. `key` is the camelCase field getVenueDetails returns. */
export const SAFETY_FACTS = [
  {
    key: "emergencyAccess",
    label: "Emergency access",
    help: "Exits, routes and assembly points.",
  },
  {
    key: "knownRestrictions",
    label: "Known restrictions",
    help: "Anything that limits how the venue can be used, such as limits on equipment, noise or structures.",
  },
];
