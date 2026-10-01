// venueBlockDisplay.js
//
// SCRUM-127 (part of SCRUM-17). Where a block sits in time, for the badge on
// each row of VenueBlocksPanel and for hiding Edit and Remove on ended blocks.
//
// The rule is the backend's half-open [start, end): a block has ended the
// moment now reaches endsAt, which is also when PATCH and DELETE start
// answering 409 BLOCK_ENDED.

export const BLOCK_PHASE_LABELS = Object.freeze({
  upcoming: "Upcoming",
  in_effect: "In effect",
  ended: "Ended",
});

/**
 * "upcoming", "in_effect" or "ended".
 *
 * An endsAt that will not parse reads as "upcoming" rather than "ended", so
 * the row keeps its actions and the server stays the authority: the worst
 * case is a 409 BLOCK_ENDED, not a block nobody can touch.
 *
 * @param {{startsAt: string, endsAt: string}} block
 * @param {Date} [now]
 * @returns {"upcoming"|"in_effect"|"ended"}
 */
export function blockPhase(block, now = new Date()) {
  const end = new Date(block?.endsAt).getTime();
  if (Number.isNaN(end)) return "upcoming";

  const at = now.getTime();
  if (end <= at) return "ended";

  const start = new Date(block?.startsAt).getTime();
  return !Number.isNaN(start) && start <= at ? "in_effect" : "upcoming";
}
