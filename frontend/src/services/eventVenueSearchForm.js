// eventVenueSearchForm.js
//
// SCRUM-141 (SCRUM-20 AC1/AC2). The pure half of EventVenueFinder: the
// coordinator's venue search, pre-filled from the event and editable before
// it runs. Pure so every rule can be tested without rendering anything, and
// kept out of the component file because react-refresh lets a component file
// export only the component.
//
// The form holds what its inputs hold, all strings except the two code lists:
//
//   { date: "YYYY-MM-DD", startTime: "HH:mm", endTime: "HH:mm",
//     expectedAttendance: "120", location: "", layout: "",
//     accessibility: [], facilities: [] }
//
// One date and two times rather than two datetime-local inputs: an event that
// crosses Singapore midnight can never match, because no venue's opening
// hours do (venueMatching.coversPeriod), so the form does not offer one.
//
// The date and times are Singapore wall clock -- the venues' local time --
// whatever zone the device is set to: toVenueWallClock reads an instant on
// the way in and toVenueOffsetIsoString stamps +08:00 on the way out. The
// device's clock would be the wrong one: the backend checks hours and "one
// date" in Singapore, so a New York reading of a 09:00-13:00 event
// (20:00-00:00, across device midnight) could not even be entered.
//
// The validation wording follows the backend's validateEventSearchCriteria
// where the two overlap ("is required", "must be later than the start",
// "must be a whole number"). The backend stays the authority; this names an
// obvious mistake before a round trip, as venueSearchValidation.js does.

import { toVenueOffsetIsoString, toVenueWallClock } from "./datetimeFormat";
import { parseDateTime } from "./venueBlockValidation";

/** The form's empty shape, so every caller starts from the same keys. */
export const EMPTY_EVENT_SEARCH_FORM = Object.freeze({
  date: "",
  startTime: "",
  endTime: "",
  expectedAttendance: "",
  location: "",
  layout: "",
  accessibility: Object.freeze([]),
  facilities: Object.freeze([]),
});

/**
 * Which form field a 400's details[] entry belongs beside.
 *
 * The API speaks in instants (startsAt, endsAt); the form in a date and two
 * times. A fault in an instant is shown beside its time: startsAt beside
 * Start, endsAt beside End. The end is the side that carries "must be later
 * than the start", as on every other form here, and the date has no wire
 * field of its own -- it is half of both instants -- so it takes none. The
 * other criteria travel under their own names.
 *
 * Anything a 400 names that is not here has no control to sit beside, and the
 * component shows its generic message instead.
 */
const SERVER_FIELD_TO_FORM_FIELD = Object.freeze({
  startsAt: "startTime",
  endsAt: "endTime",
  expectedAttendance: "expectedAttendance",
  location: "location",
  layout: "layout",
  accessibility: "accessibility",
  facilities: "facilities",
});

/** HH:MM, or HH:MM:SS, with real hour and minute ranges. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** YYYY-MM-DD; whether the day exists is parseDateTime's job. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed text, or "" for anything that is not a string. Blank means not given. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Only the strings in a list, so a stray value never reaches the wire. */
function codes(value) {
  return Array.isArray(value) ? value.filter((code) => typeof code === "string" && code !== "") : [];
}

/** An instant as its Singapore date and time, or two blanks. */
function splitVenueTime(isoString) {
  const local = toVenueWallClock(isoString);
  if (local === "") return { date: "", time: "" };
  const [date, time] = local.split("T");
  return { date, time };
}

/** A real calendar date in YYYY-MM-DD form. */
function isValidDate(date) {
  return DATE_PATTERN.test(date) && parseDateTime(`${date}T00:00`) !== null;
}

/**
 * The form's starting values, read from the event request.
 *
 * - proposedStart and proposedEnd become a date and two times in Singapore
 *   time, on any device. A missing or unreadable one leaves its fields empty
 *   for the coordinator to fill in, rather than inventing a time.
 * - The date is the start's, or the end's when there is no start.
 * - The end time is filled only when the end falls on that Singapore date. A
 *   request running past Singapore midnight cannot be searched as one period
 *   (see the header), so its end is left for the coordinator to decide rather
 *   than silently moved onto the start's date.
 * - expectedAttendance is filled only when it is a whole number of at least 1;
 *   the column is nullable.
 * - Location, layout, accessibility and facilities start empty. The event
 *   holds those as free prose ("a large room, ideally tiered"), which is not
 *   parsed into codes: a guessed code would filter out venues for a reason the
 *   coordinator never chose. The prose is shown under Requirements instead.
 *
 * @param {object} [request]  an event request row
 * @returns {object} form values, in the shape described in the header
 */
export function seedFromEvent(request) {
  const start = splitVenueTime(request?.proposedStart);
  const end = splitVenueTime(request?.proposedEnd);
  const date = start.date || end.date;
  const attendance = request?.expectedAttendance;

  return {
    ...EMPTY_EVENT_SEARCH_FORM,
    date,
    startTime: start.time,
    endTime: end.date === date ? end.time : "",
    expectedAttendance:
      Number.isInteger(attendance) && attendance >= 1 ? String(attendance) : "",
    accessibility: [],
    facilities: [],
  };
}

/**
 * Check the form before searching.
 *
 * Date, start, end and attendance are required (AC1). The end must be later
 * than the start on the same date -- equal is refused too, since an event
 * with no length has nothing to look for. Attendance must be a whole number
 * of at least 1. The optional criteria have no client rule: a blank one is
 * simply not sent, and an unknown code is the backend's to name.
 *
 * Every fault is reported at once, in the backend's { field, message } shape,
 * so the component shows client and server faults with one renderer.
 *
 * @param {object} values  form values
 * @returns {{field: string, message: string}[]} empty when the form is fine
 */
export function validateEventSearchForm(values = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  const date = text(values.date);
  const startTime = text(values.startTime);
  const endTime = text(values.endTime);
  const attendance = text(values.expectedAttendance);

  const dateOk = date !== "" && isValidDate(date);
  const startOk = startTime !== "" && TIME_PATTERN.test(startTime);
  const endOk = endTime !== "" && TIME_PATTERN.test(endTime);

  if (date === "") add("date", "is required");
  else if (!dateOk) add("date", "must be a valid date");

  if (startTime === "") add("startTime", "is required");
  else if (!startOk) add("startTime", "must be a valid time");

  if (endTime === "") add("endTime", "is required");
  else if (!endOk) add("endTime", "must be a valid time");

  if (dateOk && startOk && endOk) {
    const start = parseDateTime(`${date}T${startTime}`);
    const end = parseDateTime(`${date}T${endTime}`);
    if (start && end && end <= start) add("endTime", "must be later than the start");
  }

  if (attendance === "") {
    add("expectedAttendance", "is required");
  } else {
    const number = Number(attendance);
    if (Number.isNaN(number)) add("expectedAttendance", "must be a number");
    else if (!Number.isInteger(number)) add("expectedAttendance", "must be a whole number");
    else if (number < 1) add("expectedAttendance", "must be at least 1");
  }

  return errors;
}

/**
 * The form as findVenuesForEvent's criteria. Validate first: this does not judge.
 *
 * startsAt and endsAt carry Singapore's +08:00 (toVenueOffsetIsoString), and
 * expectedAttendance is a number. Optional criteria appear only when set --
 * location and layout non-blank, the code lists non-empty -- so a search that
 * leaves them alone sends exactly the required three.
 *
 * @param {object} values  form values
 * @returns {object} criteria for findVenuesForEvent
 */
export function toSearchCriteria(values = {}) {
  const date = text(values.date);
  const criteria = {
    startsAt: toVenueOffsetIsoString(`${date}T${text(values.startTime)}`),
    endsAt: toVenueOffsetIsoString(`${date}T${text(values.endTime)}`),
    expectedAttendance: Number(text(values.expectedAttendance)),
  };

  const location = text(values.location);
  if (location !== "") criteria.location = location;

  const layout = text(values.layout);
  if (layout !== "") criteria.layout = layout;

  for (const field of ["accessibility", "facilities"]) {
    const selected = codes(values[field]);
    if (selected.length > 0) criteria[field] = selected;
  }

  return criteria;
}

/**
 * Sort a 400's details[] into what can sit beside a form field and what
 * cannot (see SERVER_FIELD_TO_FORM_FIELD).
 *
 * @param {unknown} details  err.response.data.details, whatever arrived
 * @returns {{fieldErrors: {field: string, message: string}[], hasUnmapped: boolean}}
 *   fieldErrors renamed to form fields; hasUnmapped when anything was left
 *   over, or when details was not a usable list at all
 */
export function mapServerDetails(details) {
  if (!Array.isArray(details) || details.length === 0) {
    return { fieldErrors: [], hasUnmapped: true };
  }

  const fieldErrors = [];
  let hasUnmapped = false;
  for (const detail of details) {
    const field = Object.hasOwn(SERVER_FIELD_TO_FORM_FIELD, detail?.field)
      ? SERVER_FIELD_TO_FORM_FIELD[detail.field]
      : undefined;
    if (field && typeof detail.message === "string") {
      fieldErrors.push({ field, message: detail.message });
    } else {
      hasUnmapped = true;
    }
  }
  return { fieldErrors, hasUnmapped };
}

/**
 * The message for a failed search that has no field to sit beside.
 *
 * @param {unknown} err  what findVenuesForEvent threw
 * @returns {string}
 */
export function searchErrorMessage(err) {
  if (err?.response?.status === 403) {
    return "Only Event Coordinators can search by event requirements.";
  }
  return "Could not search venues. Please try again.";
}
