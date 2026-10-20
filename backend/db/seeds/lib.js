/**
 * Values and helpers shared by the seed scripts. Not a seed itself: each seed
 * runs on import, so a cleanup cannot import its seed, and shares from here.
 */

/** ilike treats % and _ as wildcards; escape them so a name is matched literally. */
export const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** What marks a request bookingSuitability.js seeds; its cleanup finds them by it. */
export const SEED_NOTE_PREFIX = 'Seeded demo (SCRUM-188 AC7)';
// The API's list, so a conflicting request also counts as live and the two cannot drift.
export { LIVE_BOOKING_STATUSES as LIVE_STATUSES } from '../../src/domain/bookingStatus.js';

/** What marks a row notifications.js seeds, in payload.seeded; its cleanup finds them by it. */
export const SEED_MARKER = 'SCRUM-172 demo';
