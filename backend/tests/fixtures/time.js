const DAY = 86_400_000;

/** A Singapore date `days` from now, as YYYY-MM-DD. */
export const sgDate = (days) => new Date(Date.now() + 8 * 3600_000 + days * DAY).toISOString().slice(0, 10);

/** D: the Singapore date 10 days from now, so "not started" checks against now() pass. */
export const D = sgDate(10);

/** An instant on D (or another date), written at +08:00 (Singapore). */
export const at = (hhmm, date = D) => `${date}T${hhmm}:00+08:00`;

/** An instant `minutes` from now, as ISO. */
export const fromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
