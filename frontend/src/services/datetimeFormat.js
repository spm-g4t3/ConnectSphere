// datetimeFormat.js
//
// The frontend's half of the backend's timestamp contract, in the same spirit
// as eventRequestStatusDisplay.js beside it: a pure module whose only job is
// to speak the wire format the API already defined, so no component has to
// carry a second opinion about what a date means.
//
// The contract is TIMESTAMP_PATTERN in
// backend/src/validation/eventRequestValidation.js. It requires a date, a time
// of day AND an explicit UTC offset, and its own comment explains why the
// offset is not optional: ECMAScript reads an offset-less date-time as local
// time but an offset-less date as UTC, so the same stored string would name a
// different instant on a laptop, on Supabase and in CI.
//
// An <input type="datetime-local"> emits exactly the value that pattern
// refuses — "2026-06-01T09:00", wall-clock with no offset — so something has
// to add one. That something is here and not in the validator: the validator
// is pinned by a test that refuses an offset-less value, and loosening it
// would throw away the guarantee above for every caller in order to
// accommodate one input element.
//
// The reverse direction matters just as much. The code this replaces did
// `isoString.slice(0, 16)`, which takes the first sixteen characters of a
// UTC-normalised string and calls them local time. A request stored as
// 2026-06-01T01:00:00+00:00 prefilled as 01:00 for a +08 organiser instead of
// 09:00, and saving the form then moved the event eight hours. Reading the
// value through the local getters is the fix.
//
// Invariant worth keeping true: toOffsetIsoString(toDatetimeLocalValue(x))
// names the same instant as x, to the minute.

/** Two-digit zero padding, because every field of an ISO string is fixed width. */
function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

/**
 * The value an <input type="datetime-local"> wants, in the device's own zone.
 *
 * Uses getFullYear/getMonth/getHours and not their getUTC* counterparts. That
 * single choice is the whole difference between this and the slice() it
 * replaces: the input element renders whatever string it is given as local
 * wall-clock, so handing it UTC digits silently relabels the instant.
 *
 * An unreadable value becomes "" rather than propagating NaN into the DOM.
 * There is no useful message to show here — the string came from our own API,
 * so a bad one is our bug, not the Organiser's, and an empty field they can
 * fill in beats a control React refuses to render.
 *
 * @param {string} [isoString]  an instant from the API, with or without offset
 * @returns {string} "YYYY-MM-DDTHH:mm" in the device's zone, or ""
 */
export function toDatetimeLocalValue(isoString) {
  if (!isoString) return "";

  const instant = new Date(isoString);
  if (Number.isNaN(instant.getTime())) return "";

  return (
    `${pad(instant.getFullYear(), 4)}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}` +
    `T${pad(instant.getHours())}:${pad(instant.getMinutes())}`
  );
}

/**
 * Stamp the device's UTC offset onto a wall-clock value, for the wire.
 *
 * Three decisions in here, each of which has a wrong-looking alternative:
 *
 * 1. The offset is computed from the *target* instant, not from `new Date()`.
 *    A zone's offset is a property of a moment, not of a place: an organiser
 *    who books a January event from a July DST zone would otherwise stamp the
 *    summer offset onto a winter date and move their own event by an hour.
 *
 * 2. Nothing is hard-coded, and UTC is not assumed. "Southeast Asia" is not
 *    one offset — Jakarta and Bangkok are +07 while Singapore, KL and Manila
 *    are +08 — so a constant would be quietly wrong for a third of the region
 *    rather than loudly wrong for everyone.
 *
 * 3. The suffix is appended to the raw input string rather than rebuilt by
 *    re-serialising through Date. "2026-06-01T09:00" + ":00" + "+08:00" is
 *    already exactly the shape TIMESTAMP_PATTERN accepts, and it cannot drift
 *    from what the Organiser actually typed — no rounding, no renormalising,
 *    no chance of a round trip through UTC putting a different date on it.
 *
 * On anything it cannot read, the value is returned unchanged. The backend
 * then names the fault as a { field, message } the form already knows how to
 * render, which beats inventing a competing client-side message that would
 * have to be kept in step with the validator's wording by hand.
 *
 * Returns undefined for an empty value, so a caller can drop the key from the
 * payload entirely — the validator distinguishes "not answered" from
 * "cleared", and an absent key is the former.
 *
 * @param {string} [localValue]  "YYYY-MM-DDTHH:mm" from a datetime-local input
 * @returns {string|undefined} the same wall-clock with an explicit offset
 */
export function toOffsetIsoString(localValue) {
  if (!localValue) return undefined;

  // Already carries an offset (or a Z): it is not a datetime-local value at
  // all, and appending a second offset would corrupt a string that is already
  // correct. Same "do not mangle, let the backend judge" rule as below.
  if (/(Z|[+-]\d{2}:\d{2})$/.test(localValue)) return localValue;

  // Parsed with no offset, which ECMAScript reads as device-local time -- the
  // same reading the input element itself intends.
  const instant = new Date(localValue);
  if (Number.isNaN(instant.getTime())) return localValue;

  // getTimezoneOffset counts minutes to ADD to local time to reach UTC, so it
  // is the sign-flipped version of what an ISO suffix states: +08:00 comes
  // back as -480.
  const minutes = -instant.getTimezoneOffset();
  const magnitude = Math.abs(minutes);
  const offset =
    `${minutes < 0 ? "-" : "+"}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;

  // Seconds are optional in TIMESTAMP_PATTERN but not in most inputs' output,
  // so they are added only when absent rather than assumed either way.
  const seconds = /T\d{2}:\d{2}:\d{2}/.test(localValue) ? "" : ":00";

  return `${localValue}${seconds}${offset}`;
}

/**
 * The IANA name of the zone the browser is set to, e.g. "Asia/Singapore".
 *
 * Shown to the Organiser next to the date fields. Disclosure, not a picker:
 * a picker needs something to anchor the choice to and no venue is attached
 * to a request at draft time, so offering one would be asking a question the
 * app cannot yet act on.
 *
 * @returns {string}
 */
export function deviceTimeZoneLabel() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ---------------------------------------------------------------------------
// Venue time (SCRUM-20)
//
// The helpers above speak the DEVICE's wall clock, which suits a form about
// the Organiser's own day. A venue search does not: the backend reads a
// period against each venue's opening hours on the Singapore wall clock, and
// needs start and end on one Singapore date (venueMatching.coversPeriod). A
// coordinator in New York reading 20:00-00:00 for a 09:00-13:00 event could
// neither recognise the period nor type it back. So a form about venue time
// reads and writes it here, whatever the device is set to.
//
// One fixed offset, both ways. Singapore has kept +08:00 all year since 1982,
// with no daylight saving, so adding eight hours on the way in and stamping
// "+08:00" on the way out are exact inverses, with no Intl zone data to
// disagree between browsers.

/** The zone every venue's hours are kept in, as an IANA name. */
export const VENUE_TIME_ZONE = "Asia/Singapore";

/** Its UTC offset, which never changes (no DST; see above). */
export const VENUE_UTC_OFFSET = "+08:00";

const VENUE_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * An instant as Singapore wall-clock, in the shape toDatetimeLocalValue gives.
 *
 * Shifted by the fixed offset and read through the UTC getters (toISOString),
 * so the device's own zone never enters into it.
 *
 * @param {string} [isoString]  an instant from the API, with an offset
 * @returns {string} "YYYY-MM-DDTHH:mm" in Singapore, or "" when unreadable
 */
export function toVenueWallClock(isoString) {
  if (!isoString) return "";

  const instant = new Date(isoString);
  if (Number.isNaN(instant.getTime())) return "";

  return new Date(instant.getTime() + VENUE_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Today's date in Singapore, "YYYY-MM-DD", whatever the device's zone.
 *
 * Same fixed-offset shift as toVenueWallClock, so it needs no Intl zone data.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function venueToday(now = new Date()) {
  return new Date(now.getTime() + VENUE_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Tomorrow's date in Singapore, "YYYY-MM-DD". Adding 24 hours is exact
 * because Singapore has no daylight saving.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function venueTomorrow(now = new Date()) {
  return venueToday(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Stamp Singapore's offset onto a Singapore wall-clock value, for the wire.
 *
 * The venue-time counterpart of toOffsetIsoString, with the same rules: the
 * typed string is kept as typed, seconds are added only when absent, a value
 * that already carries an offset is left alone, anything else unreadable is
 * returned unchanged for the backend to name, and an empty value is
 * undefined.
 *
 * @param {string} [localValue]  "YYYY-MM-DDTHH:mm", Singapore wall-clock
 * @returns {string|undefined} e.g. "2026-11-11T09:00:00+08:00"
 */
export function toVenueOffsetIsoString(localValue) {
  if (!localValue) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(localValue)) return localValue;

  const seconds = /T\d{2}:\d{2}:\d{2}$/.test(localValue) ? "" : ":00";
  return `${localValue}${seconds}${VENUE_UTC_OFFSET}`;
}

/**
 * SCRUM-188: a venue period as Singapore wall clock, without the zone note:
 * "2026-11-11 10:00 – 12:00", or both dates in full when the period crosses
 * a Singapore midnight ("2026-11-11 22:00 – 2026-11-12 01:00").
 *
 * Read the same on every device, because the server judged it against venue
 * hours kept in Singapore time. formatVenuePeriod adds the note once; a line
 * made of several ranges (setup · event · turnaround) adds it once at the end.
 *
 * @param {string} [startsAt]  an instant from the API, with an offset
 * @param {string} [endsAt]
 * @param {string} [fallback="Not set"]  when either end is unreadable
 * @returns {string}
 */
export function formatVenueRange(startsAt, endsAt, fallback = "Not set") {
  const start = toVenueWallClock(startsAt);
  const end = toVenueWallClock(endsAt);
  if (!start || !end) return fallback;
  const [startDate, startTime] = start.split("T");
  const [endDate, endTime] = end.split("T");
  const endText = startDate === endDate ? endTime : `${endDate} ${endTime}`;
  return `${startDate} ${startTime} – ${endText}`;
}

/** The note every venue-time period carries. */
export const VENUE_TIME_NOTE = "(Singapore time)";

/**
 * formatVenueRange plus " (Singapore time)", or the fallback alone when either
 * end is unreadable: "2026-11-11 10:00 – 12:00 (Singapore time)".
 *
 * @param {string} [startsAt]
 * @param {string} [endsAt]
 * @param {string} [fallback="Not set"]
 * @returns {string}
 */
export function formatVenuePeriod(startsAt, endsAt, fallback = "Not set") {
  if (!toVenueWallClock(startsAt) || !toVenueWallClock(endsAt)) return fallback;
  return `${formatVenueRange(startsAt, endsAt)} ${VENUE_TIME_NOTE}`;
}

/**
 * One instant as Singapore wall clock plus the note, or the fallback alone
 * when unreadable: "2026-11-01 10:00 (Singapore time)".
 *
 * @param {string} [isoString]  an instant from the API, with an offset
 * @param {string} [fallback="Not set"]
 * @returns {string}
 */
export function formatVenueTimestamp(isoString, fallback = "Not set") {
  const wallClock = toVenueWallClock(isoString);
  if (!wallClock) return fallback;
  return `${wallClock.replace("T", " ")} ${VENUE_TIME_NOTE}`;
}

/**
 * Whether a clarification's "YYYY-MM-DD" reply-by date has passed.
 *
 * Compares against today's Singapore date, the calendar the venues and the
 * reply-by deadline are kept in, so every device agrees when it lapses.
 *
 * @param {string} replyByDate  "YYYY-MM-DD"
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isReplyOverdue(replyByDate, now = new Date()) {
  return replyByDate < venueToday(now);
}

// ---------------------------------------------------------------------------
// Opening hours
//
// A venue's hours are one row per day it opens: { day_of_week, opens_at,
// closes_at }, day 0 = Sunday, times "HH:MM" or "HH:MM:SS" on the Singapore
// wall clock. A closing time at or before the opening time means the next
// day, as the server reads it, so 18:00-02:00 on Friday runs into Saturday
// and a 00:00 close is midnight.

const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** "HH:MM" or "HH:MM:SS" as "HH:MM:SS", or null when it is not a time. */
function timeWithSeconds(time) {
  const match = /^(\d{2}):(\d{2})(:\d{2})?$/.exec(String(time ?? ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1]}:${match[2]}${match[3] ?? ":00"}`;
}

/** The day after `day`, 0-6, wrapping Saturday to Sunday. */
function nextDay(day) {
  return (Number(day) + 1) % 7;
}

/**
 * Whether a day's hours close on the next day: both times readable and the
 * closing time at or before the opening time. Compared as "HH:MM:SS", so
 * "02:00" and "18:00:00" are read alike.
 *
 * @param {string} opens   "HH:MM" or "HH:MM:SS"
 * @param {string} closes
 * @returns {boolean}
 */
export function closesNextDay(opens, closes) {
  const open = timeWithSeconds(opens);
  const close = timeWithSeconds(closes);
  return Boolean(open && close) && close <= open;
}

/**
 * The note under a day's times in the venue form, or null when the day
 * closes the same day. Equal times are null too: the server refuses them
 * and its message says why.
 *
 * @param {number} dayOfWeek  0 = Sunday
 * @param {string} opens
 * @param {string} closes
 * @returns {string|null}  "Closes at midnight" or "Closes Saturday 02:00 (next day)"
 */
export function describeClosing(dayOfWeek, opens, closes) {
  if (!closesNextDay(opens, closes)) return null;
  const close = timeWithSeconds(closes);
  if (close === timeWithSeconds(opens)) return null;
  if (close === "00:00:00") return "Closes at midnight";
  const day = LONG_DAY_NAMES[nextDay(dayOfWeek)];
  if (!day) return null;
  return `Closes ${day} ${close.slice(0, 5)} (next day)`;
}

/**
 * One day's hours as a short line: "Mon 09:00–18:00" the same day,
 * "Fri 18:00 – Sat 02:00" overnight, "Thu 18:00 – midnight" for a 00:00
 * close. An unknown day reads "Day 9"; unreadable times keep the same-day
 * shape, so this never throws on an odd history row.
 *
 * @param {{day_of_week: number, opens_at: string, closes_at: string}} entry
 * @returns {string}
 */
export function formatHoursEntry({ day_of_week: day, opens_at: opens, closes_at: closes }) {
  const name = SHORT_DAY_NAMES[day] ?? `Day ${day}`;
  const open = String(opens).slice(0, 5);
  const close = String(closes).slice(0, 5);
  if (!closesNextDay(opens, closes)) return `${name} ${open}–${close}`;
  if (timeWithSeconds(closes) === "00:00:00") return `${name} ${open} – midnight`;
  const next = SHORT_DAY_NAMES[day] ? SHORT_DAY_NAMES[nextDay(day)] : "next day";
  return `${name} ${open} – ${next} ${close}`;
}
