// singaporeTime.js
//
// Expected display text for an instant, built the way the app formats it:
// Singapore time in the runner's locale format, so the suite passes in any zone.

const SINGAPORE = "Asia/Singapore";

/** As formatTimestamp renders a parseable instant. */
export function sgTime(value) {
  return new Date(value).toLocaleString(undefined, { timeZone: SINGAPORE });
}

/** As formatMediumTimestamp renders a parseable instant. */
export function sgMediumTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: SINGAPORE,
  }).format(new Date(value));
}
