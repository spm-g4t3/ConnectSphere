/**
 * The over-commitment check, as a hook.
 *
 * SCRUM-277 calls this before saving anything that would leave fewer usable
 * units than a type has today: recording damage or maintenance. SCRUM-276's
 * total change calls it too when the total is reduced, and retiring a type
 * (SCRUM-278) calls it with usableAfter 0, since a retired type has no units
 * left to offer. AC7 of SCRUM-275 says that when the
 * usable figure would fall below the units reserved for any future period, the
 * check in SCRUM-310 runs before anything is saved.
 *
 * HOOK: SCRUM-310 is not built, so this does nothing yet and every change is
 * allowed. SCRUM-310 replaces the body and owns what the check does. Callers
 * need no change: they already await this and let its error propagate, so a
 * refusal stops the write.
 *
 * Only called when usableAfter is lower than the usable figure today, because
 * raising it can never over-commit a type.
 *
 * @param {object} change
 * @param {string} change.equipmentTypeId
 * @param {number} change.usableAfter  the usable quantity the change would leave
 * @returns {Promise<void>}
 */
export async function assertNoOverCommitment({ equipmentTypeId, usableAfter }) {
  // SCRUM-310 fills this in.
}