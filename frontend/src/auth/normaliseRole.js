// normaliseRole.js
//
// One definition of "which role is this, really", shared by everything that
// keys off a role.
//
// It was already written twice, verbatim, in Navigation.jsx and Dashboard.jsx,
// and ProtectedRoute needed a third. Two copies of a rule this small stay in
// step by luck; three do not — and the failure mode is silent, because an
// unrecognised role renders as an empty nav or "no dashboard available"
// rather than as an error anyone can see.
//
// What it absorbs, and why each one is real:
//   - case and surrounding whitespace, because the role arrives from a JWT
//     claim that nothing on this side controls;
//   - spaces and hyphens, so "venue staff" and "venue-staff" reach the same
//     key as "venue_staff";
//   - the American spelling, because "ORGANIZER" and "ORGANISER" are the same
//     role and the rest of this codebase spells it with an s.
//
// The output is the SCREAMING_SNAKE_CASE key the lookup tables use, so a
// caller compares normalised against normalised and never against raw input.

/**
 * The canonical key for a role, however it was spelled.
 *
 * @param {*} role  a role from the auth context, or anything at all
 * @returns {string} the canonical key, or "" when there was no role to read
 */
export function normaliseRole(role) {
  return String(role || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace("ORGANIZER", "ORGANISER");
}
