/**
 * Does a venue meet an event's requirements?
 *
 * SCRUM-138, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * AC3: a venue is returned only if it meets every supplied criterion --
 * capacity at least the expected attendance, operating hours covering the
 * whole requested period, the requested layout supported, and every requested
 * accessibility feature and facility provided.
 *
 * AC4: a venue that meets only some of them is not returned. That is why
 * matchesAllCriteria joins its checks with && and nothing else: there is no
 * score, no "close enough" and no partial credit to get wrong.
 *
 * The rule lives here, in one pure module, rather than in the PostgREST query
 * or the service. One home means the search can never hold two copies of it
 * that disagree, and pure functions mean every boundary -- capacity equal to
 * attendance, an event ending on the closing minute -- can be unit-tested with
 * no database, which matters because CI has none.
 *
 * Deliberately NOT here: bookings, blocks, setup and turnaround. Whether a
 * venue is free is SCRUM-139's rule (AC5/AC6). Operating hours are checked
 * against the event's own, unpadded period, because AC3 speaks of "the
 * requested period" -- setup and turnaround are the venue's business.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/turnaroundOptions.js.
 *
 * SCRUM-141 adds location, an optional criterion the Week 4 instructions list:
 * the venue's location must contain the requested text (matchesLocation).
 *
 * Shapes:
 *  - venue: what venueService's toVenueWithAttributes returns -- location,
 *    maxCapacity,
 *    and layouts, accessibility and facilities as arrays of codes, and hours as
 *    [{ day_of_week, opens_at, closes_at }] straight from venue_operating_hours.
 *  - criteria: what validateEventSearchCriteria returns -- startsAt, endsAt,
 *    expectedAttendance, and optionally layout, accessibility, facilities and
 *    location.
 *    An optional criterion that is absent is not filtered on.
 *
 * SCRUM-189, a subtask of SCRUM-188 (Check Venue Suitability for an Event),
 * adds evaluateCriteria: the same rules, one verdict per criterion, each with
 * the values compared (SCRUM-188 AC2). It is built from the predicates above
 * -- meetsCapacity, hoursVerdict, supportsLayout, providesAll -- so the
 * suitability check and the search can never disagree about a venue. It is
 * for the suitability check only: search keeps matchesAllCriteria's bare
 * yes/no, because SCRUM-145 forbids search from saying why a venue was left
 * out.
 */

/**
 * The zone a venue's opening hours are written in.
 *
 * venue_operating_hours holds bare `time` values with no zone (002): "09:00"
 * means nine in the morning on a Singapore clock. The request arrives as an
 * instant with any offset, and the server may well run in UTC, so the server's
 * own zone cannot be trusted to turn one into the other. Every venue is in
 * Singapore today; a venue in another zone would need a time_zone column, and
 * this constant is the one place that would change.
 */
export const VENUE_TIME_ZONE = 'Asia/Singapore';

/**
 * One formatter, built once: constructing an Intl.DateTimeFormat is far more
 * expensive than calling it, and a search calls it twice per venue.
 *
 * hourCycle 'h23', not hour12: false. With hour12: false some engines report
 * midnight as hour "24" rather than "00", which would put a 00:30 start at
 * 1470 minutes and past every closing time. 'h23' always counts 0 to 23.
 *
 * Singapore has no daylight saving, but the zone is still resolved by Intl
 * rather than by adding eight hours, so the history of the zone (it was +07:30
 * before 1982) and any future change are the platform's problem, not ours.
 */
const VENUE_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: VENUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * An instant as a venue's wall clock reads it.
 *
 * '2026-11-11T02:00:00Z' and '2026-11-11T10:00:00+08:00' are the same instant
 * and both come back as Wednesday 2026-11-11, 600 minutes -- the weekday and
 * time are taken from the Singapore date, never the UTC one (B-AC3-08/10).
 *
 * formatToParts rather than parsing format()'s output: the parts are labelled,
 * so nothing here depends on the locale's punctuation or field order.
 *
 * @param {string|Date} instant  an ISO 8601 timestamp with an offset, or a Date
 * @returns {{date: string, dayOfWeek: number, minutes: number}}
 *   date 'YYYY-MM-DD'; dayOfWeek 0-6 with 0 = Sunday, the convention
 *   venue_operating_hours.day_of_week uses (002); minutes since local
 *   midnight, with any seconds as a fraction
 */
export function toVenueLocal(instant) {
  const parts = Object.fromEntries(
    VENUE_CLOCK.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // The weekday of a calendar date does not depend on any zone, so it is
    // computed from the local date itself in UTC -- where no zone can shift
    // it -- rather than mapped from a locale's 'Wed'.
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutes: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60,
  };
}

/**
 * 'HH:MM:SS' (or 'HH:MM') to minutes since midnight.
 *
 * PostgREST returns `time` columns as 'HH:MM:SS'. The seconds are honoured
 * rather than dropped, so a venue opening at 09:00:30 does not cover an event
 * starting at 09:00. Each part is weighted by its position, which reads
 * 'HH:MM' and 'HH:MM:SS' alike without a branch for the missing seconds.
 */
const TIME_PART_MINUTES = [60, 1, 1 / 60];

function timeToMinutes(time) {
  return time
    .split(':')
    .reduce((total, part, index) => total + Number(part) * TIME_PART_MINUTES[index], 0);
}

/**
 * AC3: "capacity >= attendance".
 *
 * >= and not >: a 100-seat room holds an event of 100 (B-AC3-01). Off by one
 * here would refuse every venue sized exactly for its event.
 *
 * @param {{maxCapacity: number}} venue
 * @param {number} attendance  the event's expected attendance
 * @returns {boolean}
 */
export function meetsCapacity(venue, attendance) {
  return venue.maxCapacity >= attendance;
}

const MINUTES_PER_DAY = 24 * 60;

/** Whole calendar days from one 'YYYY-MM-DD' to another. */
function daysBetween(fromDate, toDate) {
  // Both are dates on the venue's clock, read at UTC midnight so no zone shifts them.
  const millisPerDay = MINUTES_PER_DAY * 60 * 1000;
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / millisPerDay);
}

/** A row closing at or before it opens closes the next day (00:00 is midnight). */
function isOvernight(row) {
  return timeToMinutes(row.closes_at) <= timeToMinutes(row.opens_at);
}

/**
 * A row's window in minutes from the midnight that begins the day it opens,
 * shifted by offset minutes so it can be laid against another day's clock.
 */
function windowOf(row, offset) {
  const opens = timeToMinutes(row.opens_at);
  const closes = timeToMinutes(row.closes_at);
  return {
    opens: opens + offset,
    closes: (isOvernight(row) ? closes + MINUTES_PER_DAY : closes) + offset,
  };
}

/**
 * AC3: whether the venue's operating hours cover the whole requested period,
 * and why -- the one home of the hours rule, read by coversPeriod (search) and
 * evaluateCriteria (SCRUM-188 AC2 suitability).
 *
 * A row's hours belong to the day the venue opens, and a closing time at or
 * before the opening time is the next day, so Friday 18:00-02:00 runs into
 * Saturday. One day's window must hold the whole event: the event's own
 * period, measured from the start's Singapore midnight, is laid against
 *
 *  - the start weekday's row, and
 *  - the previous weekday's row when it is overnight, which is what covers an
 *    early-hours event such as Saturday 00:30-01:30 under Friday's hours.
 *
 * Both edges are inclusive: an event 09:00-18:00 fits hours 09:00-18:00
 * exactly (B-AC3-04), while 08:59 or 18:01 does not (B-AC3-05/06). A weekday
 * with no row is closed (017's known limit), not open all day. Windows last
 * under 48 hours, so an event ending two dates after it starts never fits.
 *
 * When neither window fits, the verdict reports the row the start falls in:
 * the previous day's when the start is in its early hours, else the start
 * weekday's. Reasons: 'within_hours'; 'closed_that_day' when no row applies;
 * 'spans_midnight' when the event crosses a date but the reported row closes
 * before midnight; otherwise 'outside_hours'.
 *
 * start and end are toVenueLocal's readings, returned so a caller describing
 * the verdict shows the same Singapore wall clock the rule judged, rather than
 * converting the instants a second time.
 *
 * @param {Array<{day_of_week: number, opens_at: string, closes_at: string}>} hours
 * @param {string|Date} startsAt
 * @param {string|Date} endsAt
 * @returns {{
 *   met: boolean,
 *   reason: 'spans_midnight'|'closed_that_day'|'outside_hours'|'within_hours',
 *   dayOfWeek: number,
 *   opensAt?: string,
 *   closesAt?: string,
 *   start: {date: string, dayOfWeek: number, minutes: number},
 *   end: {date: string, dayOfWeek: number, minutes: number},
 * }}  dayOfWeek, opensAt and closesAt are the reported row's; with no row,
 *     dayOfWeek is the start's and the times are absent
 */
export function hoursVerdict(hours, startsAt, endsAt) {
  const start = toVenueLocal(startsAt);
  const end = toVenueLocal(endsAt);
  const startMinutes = start.minutes;
  const endMinutes = end.minutes + MINUTES_PER_DAY * daysBetween(start.date, end.date);

  const sameDayRow = hours.find((entry) => entry.day_of_week === start.dayOfWeek);
  const previousDay = (start.dayOfWeek + 6) % 7;
  const previousRow = hours.find((entry) => entry.day_of_week === previousDay && isOvernight(entry));

  const candidates = [];
  if (sameDayRow !== undefined) candidates.push({ row: sameDayRow, window: windowOf(sameDayRow, 0) });
  if (previousRow !== undefined) {
    candidates.push({ row: previousRow, window: windowOf(previousRow, -MINUTES_PER_DAY) });
  }

  const fits = ({ window }) => window.opens <= startMinutes && window.closes >= endMinutes;
  const inEarlyHours = ({ row, window }) => row === previousRow && startMinutes < window.closes;
  const reported =
    candidates.find(fits) ??
    candidates.find(inEarlyHours) ??
    candidates.find(({ row }) => row === sameDayRow);

  if (reported === undefined) {
    return { met: false, reason: 'closed_that_day', dayOfWeek: start.dayOfWeek, start, end };
  }

  const met = fits(reported);
  let reason = 'outside_hours';
  if (met) reason = 'within_hours';
  else if (start.date !== end.date && !isOvernight(reported.row)) reason = 'spans_midnight';

  return {
    met,
    reason,
    dayOfWeek: reported.row.day_of_week,
    opensAt: reported.row.opens_at,
    closesAt: reported.row.closes_at,
    start,
    end,
  };
}

/**
 * AC3: the venue's operating hours cover the whole requested period.
 *
 * Just hoursVerdict's yes/no, so search and suitability share one hours rule;
 * the conditions are documented there.
 *
 * @param {Array<{day_of_week: number, opens_at: string, closes_at: string}>} hours
 * @param {string|Date} startsAt
 * @param {string|Date} endsAt
 * @returns {boolean}
 */
export function coversPeriod(hours, startsAt, endsAt) {
  return hoursVerdict(hours, startsAt, endsAt).met;
}

/**
 * AC3: the requested layout is one the venue supports.
 *
 * AC1 makes layout optional, so no layout asked for means every venue passes.
 * A single code, not a list: an event is set out in one layout.
 *
 * @param {{layouts: string[]}} venue
 * @param {string} [layout]
 * @returns {boolean}
 */
export function supportsLayout(venue, layout) {
  return layout === undefined || venue.layouts.includes(layout);
}

/**
 * AC3: the venue provides every requested item -- used for both accessibility
 * features and facilities.
 *
 * "Every", so a venue with more than was asked for passes (B-AC3-14/17) and a
 * venue missing even one does not (B-AC3-15/18). Nothing asked for -- the
 * criterion absent, or an empty list -- passes, since [].every() is true.
 *
 * @param {string[]} venueCodes  what the venue has
 * @param {string[]} [requested] what the event needs
 * @returns {boolean}
 */
export function providesAll(venueCodes, requested) {
  return requested === undefined || requested.every((code) => venueCodes.includes(code));
}

/**
 * SCRUM-141: the venue's location contains the requested text, ignoring case.
 *
 * The same meaning as the old /search's ilike '%...%' (venueService
 * searchVenues), so "orchard" finds "Orchard Road" in both searches. Only
 * the meaning: ilike treats % and _ as wildcards, and this treats them as
 * the characters they are, which is what someone typing them means.
 *
 * toLowerCase rather than toLocaleLowerCase: the locale variant depends on
 * the server's locale (a Turkish one lowercases 'I' to a dotless 'ı'), so
 * the same request could match differently on two machines. toLowerCase
 * applies Unicode's default mapping everywhere.
 *
 * No location asked for means every venue passes, like supportsLayout. The
 * validator has already trimmed it and turned a blank one into absent.
 *
 * @param {{location: string}} venue
 * @param {string} [location]
 * @returns {boolean}
 */
export function matchesLocation(venue, location) {
  return (
    location === undefined ||
    venue.location.toLowerCase().includes(location.toLowerCase())
  );
}

/**
 * AC3 and AC4: does this venue meet every supplied criterion?
 *
 * Returns a boolean and nothing else, on purpose. It never says which check
 * failed, so no caller can pass a reason on: SCRUM-143's no-match message is
 * general, and SCRUM-145 checks that nothing diagnoses why a venue was left
 * out. Keeping the reason out of this function makes that true by
 * construction rather than by every caller remembering not to.
 *
 * The per-criterion "why" lives in evaluateCriteria, built from the same
 * predicates and used by the suitability check only (SCRUM-188), never by
 * search (SCRUM-145).
 *
 * @param {object} venue     as described in the header
 * @param {object} criteria  as described in the header
 * @returns {boolean}
 */
export function matchesAllCriteria(venue, criteria) {
  return (
    meetsCapacity(venue, criteria.expectedAttendance) &&
    coversPeriod(venue.hours, criteria.startsAt, criteria.endsAt) &&
    supportsLayout(venue, criteria.layout) &&
    providesAll(venue.accessibility, criteria.accessibility) &&
    providesAll(venue.facilities, criteria.facilities) &&
    matchesLocation(venue, criteria.location)
  );
}


/**
 * SCRUM-188 AC2: the criteria a suitability check reports, in the order it
 * reports them.
 *
 * Display labels, not codes: the frontend's BookingRequestPanel renders each
 * entry as "<criterion>: <detail>", so the label is what the Venue Staff
 * member reads. Frozen so no caller can reorder or rename them in place.
 *
 * Location is deliberately absent -- it is a search filter (SCRUM-141), not a
 * SCRUM-188 criterion. SCRUM-190 adds 'Availability' alongside these, since
 * whether a venue is free is SQL (venue_occupancy_conflicts()), not a pure
 * rule this module can judge.
 */
export const SUITABILITY_CRITERIA = Object.freeze([
  'Capacity',
  'Operating hours',
  'Layout',
  'Accessibility',
  'Facilities',
]);

/** The sixth criterion's label, judged by SQL and reported after the five. */
export const AVAILABILITY_CRITERION = 'Availability';

/**
 * SCRUM-188 AC2: every criterion the suitability check reports, in order --
 * the five above, then Availability. Defined here (and re-exported by
 * venueSuitabilityService.js) so a pure module -- the booking request's
 * validation of acknowledgedCriteria (SCRUM-193/194, F2) -- can name the
 * criteria without importing a service.
 */
export const SUITABILITY_CHECK_CRITERIA = Object.freeze([
  ...SUITABILITY_CRITERIA,
  AVAILABILITY_CRITERION,
]);

/** day_of_week 0-6, 0 = Sunday, the convention toVenueLocal returns (002). */
const DAY_NAMES = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);

/** What an optional criterion that was not asked for reads as. */
const NONE_REQUESTED = 'None requested';

/**
 * Minutes since midnight as 'HH:MM' on the venue's clock.
 *
 * Seconds are dropped, not rounded: a reading of 08:59:59 shows as 08:59, so
 * the displayed start never looks later than the one the rule judged.
 */
function minutesToClock(minutes) {
  const whole = Math.floor(minutes);
  const hh = String(Math.floor(whole / 60)).padStart(2, '0');
  const mm = String(whole % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 'HH:MM:SS' or 'HH:MM' from venue_operating_hours as 'HH:MM'. */
function timeToClock(time) {
  return time.slice(0, 5);
}

/** A weekday as its first three letters, 'Fri'. */
function shortDay(dayOfWeek) {
  return DAY_NAMES[dayOfWeek].slice(0, 3);
}

/**
 * The words for an hours verdict.
 *
 * Anything crossing midnight -- the event or the venue's window -- names both
 * days, short ('Fri 22:00 – Sat 01:00'), because the two times alone would
 * read as running backwards; otherwise one day is named in full, since the
 * whole event falls on it. A 00:00 close reads 'midnight', not the next day's
 * 00:00, so it is not mistaken for an early-morning time.
 */
function describeHours(verdict) {
  const { start, end } = verdict;
  const at = (local) => `${shortDay(local.dayOfWeek)} ${minutesToClock(local.minutes)}`;

  if (verdict.reason === 'spans_midnight') {
    return `Event spans midnight (${at(start)} – ${at(end)})`;
  }

  const dayName = DAY_NAMES[verdict.dayOfWeek];
  if (verdict.reason === 'closed_that_day') return `Venue closed on ${dayName}`;

  const opens = timeToClock(verdict.opensAt);
  const closes = timeToClock(verdict.closesAt);
  const overnight = timeToMinutes(verdict.closesAt) <= timeToMinutes(verdict.opensAt);

  if (start.date === end.date && !overnight) {
    return (
      `Event runs ${minutesToClock(start.minutes)}–${minutesToClock(end.minutes)} ` +
      `on ${dayName}; venue open ${opens}–${closes}`
    );
  }

  let closing = `${shortDay(verdict.dayOfWeek)} ${closes}`;
  if (overnight) {
    closing = timeToMinutes(verdict.closesAt) === 0
      ? 'midnight'
      : `${shortDay((verdict.dayOfWeek + 1) % 7)} ${closes}`;
  }
  return (
    `Event runs ${at(start)} – ${at(end)}; ` +
    `venue open ${shortDay(verdict.dayOfWeek)} ${opens} – ${closing}`
  );
}

/**
 * The verdict for an accessibility or facilities request.
 *
 * Missing items are listed in the order they were requested, so the detail
 * reads back the event's own list rather than the venue's.
 */
function itemsVerdict(criterion, venueCodes, requested) {
  const met = providesAll(venueCodes, requested);
  const asked = requested ?? [];
  const missing = asked.filter((code) => !venueCodes.includes(code));
  let detail = NONE_REQUESTED;
  if (asked.length > 0) {
    detail = met ? `All ${asked.length} requested provided` : `Missing: ${missing.join(', ')}`;
  }
  // SCRUM-193/194 (F4): the codes as well as the words, so a screen can show
  // its own labels for them; detail stays as the fallback.
  return { criterion, met, detail, missing, requested: [...asked] };
}

/**
 * SCRUM-188 AC2: each criterion as met or not met, with the values compared.
 *
 * SCRUM-189: one entry per SUITABILITY_CRITERIA label, in that order. Every
 * `met` comes from the predicate search uses -- meetsCapacity, hoursVerdict,
 * supportsLayout, providesAll -- and never from a second copy of the rule, so
 * a venue the suitability check calls suitable is one the search would return
 * for the same request, and the other way round. The detail only describes a
 * verdict; it never decides one.
 *
 * Unlike matchesAllCriteria this says why, which is why search must not call
 * it (SCRUM-145). Location is not evaluated: it is not a SCRUM-188 criterion.
 *
 * criteria has the search's shape, so SCRUM-190 can pass a booking's own
 * layout and attendance without changes here. An optional criterion that is
 * absent, or an empty list, is met and reads "None requested".
 *
 * @param {object} venue  as described in the header
 * @param {{startsAt: string|Date, endsAt: string|Date, expectedAttendance: number,
 *   layout?: string, accessibility?: string[], facilities?: string[]}} criteria
 * SCRUM-193/194 (F4): besides the words, the Layout entry carries `layout`
 * (the code asked for, or null) and `offers` (the venue's layout codes), and
 * the Accessibility and Facilities entries carry `requested` (the codes asked
 * for) and `missing` (those the venue lacks, [] when met), so the screen can
 * show its own labels for the codes. They describe the verdict; `met` is
 * decided exactly as before.
 *
 * @returns {Array<{criterion: string, met: boolean, detail: string}>}
 */
export function evaluateCriteria(venue, criteria) {
  const [capacityLabel, hoursLabel, layoutLabel, accessibilityLabel, facilitiesLabel] =
    SUITABILITY_CRITERIA;

  const attendance = criteria.expectedAttendance;
  const capacityMet = meetsCapacity(venue, attendance);

  const hours = hoursVerdict(venue.hours, criteria.startsAt, criteria.endsAt);

  const { layout } = criteria;
  const layoutMet = supportsLayout(venue, layout);
  let layoutDetail = NONE_REQUESTED;
  if (layout !== undefined) {
    const offers = venue.layouts.length > 0 ? venue.layouts.join(', ') : 'none';
    layoutDetail = layoutMet
      ? `Layout ${layout} offered`
      : `Layout ${layout} not offered (offers: ${offers})`;
  }

  return [
    {
      criterion: capacityLabel,
      met: capacityMet,
      detail: `Capacity ${venue.maxCapacity} ${capacityMet ? '≥' : '<'} expected attendance ${attendance}`,
    },
    { criterion: hoursLabel, met: hours.met, detail: describeHours(hours) },
    {
      criterion: layoutLabel,
      met: layoutMet,
      detail: layoutDetail,
      // SCRUM-193/194 (F4): the code asked for (null: none) and the venue's
      // layouts, for the screen's labels.
      layout: layout ?? null,
      offers: [...venue.layouts],
    },
    itemsVerdict(accessibilityLabel, venue.accessibility, criteria.accessibility),
    itemsVerdict(facilitiesLabel, venue.facilities, criteria.facilities),
  ];
}
