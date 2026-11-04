// venueLookups.js
//
// The venue catalogue's three controlled vocabularies, as checkbox options.
//
// ---------------------------------------------------------------------------
// THIS IS A KNOWN-STALE COPY. Read this before trusting it.
// ---------------------------------------------------------------------------
// Transcribed by hand from the seed data in
// backend/db/migrations/002_venues.sql:92-118 -- 6 room layouts, 5
// accessibility features, 8 facilities. That migration's own comment at :89
// says "Venue Staff add more rows later without a migration", so the database
// is free to hold codes this file has never heard of, and nothing keeps the
// two in step. It will drift. The only question is when.
//
// Why that matters more here than it would elsewhere: PATCH /venues/:id
// REPLACES an attribute array outright (venueService.updateVenue:124, and the
// docblock on the frontend's updateVenue). A form that renders only the codes
// it recognises, and then submits its checkbox state, DELETES every code it
// did not know about. Stale data plus replace semantics is silent data loss,
// not a cosmetic gap.
//
// So this file exports the transcription AND the mitigation that makes the
// transcription safe to be wrong: optionsWithUnknownCodes() below folds any
// code already on the venue back into the option list, so it renders, stays
// ticked, and survives the save.
//
// THE REAL FIX is GET /api/venues/lookups, which does not exist yet. It is
// filed for this sprint. When it lands, replace the three arrays below with
// a fetch and keep optionsWithUnknownCodes -- a fetched list can still race a
// code added a second ago.
//
// Deliberately NOT offered: a free-text "add a new code" box. No endpoint
// creates a lookup row either, so the field could only ever fail with a
// foreign-key 400. NEED_A_CODE_HELP below says that in words instead.

/** Room layouts. 002_venues.sql:92-99. */
export const ROOM_LAYOUTS = Object.freeze([
  { code: "classroom", label: "Classroom" },
  { code: "theatre", label: "Theatre" },
  { code: "boardroom", label: "Boardroom" },
  { code: "banquet", label: "Banquet" },
  { code: "exhibition", label: "Exhibition" },
  { code: "u_shape", label: "U-Shape" },
]);

/** Accessibility features. 002_venues.sql:101-107. */
export const ACCESSIBILITY_FEATURES = Object.freeze([
  { code: "step_free_entrance", label: "Step-free entrance" },
  { code: "accessible_toilet", label: "Wheelchair-accessible toilet" },
  { code: "hearing_loop", label: "Hearing loop" },
  { code: "lift_access", label: "Lift access" },
  { code: "accessible_parking", label: "Accessible parking" },
]);

/** Facilities. 002_venues.sql:109-118. */
export const FACILITIES = Object.freeze([
  { code: "projector", label: "Projector" },
  { code: "screen", label: "Screen" },
  { code: "wifi", label: "Wi-Fi" },
  { code: "air_conditioning", label: "Air conditioning" },
  { code: "whiteboard", label: "Whiteboard" },
  { code: "video_conferencing", label: "Video conferencing" },
  { code: "pa_system", label: "PA system" },
  { code: "catering", label: "Catering" },
]);

/**
 * The title text an unknown code's checkbox carries.
 *
 * Shown rather than hidden because the alternative -- rendering nothing --
 * is the data-loss path: the code would vanish from the form and then vanish
 * from the venue on the next save, with nobody having decided that.
 */
export const UNKNOWN_CODE_TITLE =
  "This code is on the venue but is not in this form's copy of the catalogue, " +
  "so its proper name cannot be shown. Leave it ticked to keep it. " +
  "Unticking it removes it from the venue.";

/** Shown under each checkbox group, because there is no way to add a code. */
export const NEED_A_CODE_HELP =
  "Need a code that isn't listed? Ask an administrator to add it to the " +
  "catalogue first.";

/**
 * KNOWN ∪ (prefilled codes not in KNOWN).
 *
 * @param {ReadonlyArray<{code: string, label: string}>} known  one of the three
 *   arrays above
 * @param {string[]} [prefilledCodes]  the codes the venue already holds, from
 *   getVenueDetails -- NOT the live checkbox state
 * @returns {Array<{code, label, unknown}>} known options first, in catalogue
 *   order, then any extras in the order the venue listed them
 *
 * Driven off the PREFILLED codes, not the current selection, on purpose. If it
 * followed the selection, unticking an unknown code would delete its checkbox
 * mid-edit and leave no way to change your mind. Derived from the baseline it
 * is stable for the life of the form: the extra row stays put, ticked or not,
 * and unticking it is then an ordinary deliberate removal like any other.
 *
 * An unknown option is labelled with its raw code -- there is nowhere to look
 * up a nicer one -- and flagged `unknown` so the caller can attach
 * UNKNOWN_CODE_TITLE and style it apart.
 */
export function optionsWithUnknownCodes(known, prefilledCodes = []) {
  const knownCodes = new Set(known.map((option) => option.code));
  const seen = new Set();
  const extras = [];

  for (const code of prefilledCodes) {
    // A non-string cannot be a code and a duplicate is not a second option.
    if (typeof code !== "string" || code === "") continue;
    if (knownCodes.has(code) || seen.has(code)) continue;
    seen.add(code);
    extras.push({ code, label: code, unknown: true });
  }

  return [...known.map((option) => ({ ...option, unknown: false })), ...extras];
}
