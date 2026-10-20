// setupOptions.js
//
// SCRUM-137 (SCRUM-20, Week 7 Customer Change). The setup time Venue Staff
// need to prepare a venue before an event starts, as the durations the venue
// form offers.
//
// The minutes mirror SETUP_MINUTES_OPTIONS in
// backend/src/domain/setupOptions.js and the named CHECK
// `venues_setup_minutes_allowed` in
// backend/db/migrations/023_venue_setup_time.sql, in the same order. A test
// keeps this copy in step with the backend's. Only the labels are the
// frontend's own.
//
// 0 ("None") is a real choice -- the event can start the moment the venue is
// free -- and the default, because nothing enforces setup until SCRUM-139.
//
// A list of its own rather than a re-export of TURNAROUND_MINUTES: setup and
// turnaround are two settings the customer may want to differ, and today's
// equal lists are a coincidence, not a rule.

import { makeMinuteOptions } from "./turnaroundOptions";

export const SETUP_MINUTES = Object.freeze([0, 15, 30, 45, 60, 90, 120]);

export const DEFAULT_SETUP_MINUTES = 0;

// The turnaround factory is reused rather than copied. Its formatTurnaround
// labels any whole number of minutes ("None", "30 minutes", "1 hour 30
// minutes") and never throws, so a setup time reads exactly like a turnaround.
const setup = makeMinuteOptions(SETUP_MINUTES);

export const SETUP_OPTIONS = setup.options;

/** @param {*} current  the saved setupMinutes, or null/undefined */
export const setupOptionsWith = setup.optionsWith;
