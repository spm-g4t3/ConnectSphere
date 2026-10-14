// The expected status-transition matrix for the eleven statuses, written out
// from SCRUM-488 AC2 and SCRUM-318, and read by no implementation. Strings, not
// STATUS constants, so a renamed or added status fails the tests that use it
// instead of quietly following the code. Used by the JavaScript guard test and
// by the database test, so both guards are held to the same table.
//
// Rejecting from either safety status is absent on purpose: SCRUM-347 has not
// decided it (docs/SCRUM-488-decisions.md, D4).

export const ELEVEN_STATUSES = Object.freeze([
  'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
  'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled',
]);

export const EXPECTED_TRANSITIONS = Object.freeze({
  draft: ['submitted'],
  submitted: ['under_review', 'cancelled'],
  under_review: ['pending_clarification', 'approved', 'rejected', 'cancelled'],
  pending_clarification: ['under_review', 'cancelled'],
  approved: ['safety_review', 'rejected', 'cancelled'],
  safety_review: ['safety_approved', 'approved', 'cancelled'],
  safety_approved: ['confirmed', 'approved', 'cancelled'],
  confirmed: ['approved', 'completed', 'cancelled'],
  completed: [],
  rejected: ['draft'],
  cancelled: [],
});

/** Every ordered pair of the eleven statuses, with whether the matrix allows it. */
export const EVERY_PAIR = ELEVEN_STATUSES.flatMap((from) =>
  ELEVEN_STATUSES.map((to) => [from, to, EXPECTED_TRANSITIONS[from].includes(to)]),
);
