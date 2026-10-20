// VenueSuitabilityResult.jsx
//
// SCRUM-191 (SCRUM-188 AC2). One suitability result, as the server judged it:
// the overall verdict, every criterion met or not with its detail, and the
// values that were checked.
//
// Read-only on purpose: no state, no calls, only the `result` it is given. The
// live recheck on the event (SCRUM-192) and the Venue Staff view of a stored
// result can then show the same thing the same way without a second copy.
//
// Rules worth keeping:
//
//   - Every criterion is shown, met or not, in the order the server sends
//     them. Hiding the met ones would leave the coordinator unable to tell
//     "checked and fine" from "not checked".
//   - The detail text is the server's. An unmet Availability already names the
//     occupied period, setup and turnaround in it, so its `conflicts` are not
//     turned into a second table here.
//   - The checked period is Singapore wall clock, because the server judged
//     it against venue hours kept in Singapore time (datetimeFormat.js).
//   - Codes show as venueLookups labels. That copy is known to be stale, so a
//     code it has not heard of shows as itself, the same fallback
//     venueSuitabilityDisplay's codesText uses, rather than vanishing.
//
// SCRUM-188 AC7: an optional `overridden` list of criterion names. An unmet
// criterion the coordinator chose to override reads "Not met — overridden by
// coordinator", so Venue Staff can tell an override from an oversight.
// Without the prop the output is exactly what SCRUM-191 rendered.
//
// SCRUM-188 review fixes:
//   - A criterion that carries its codes (Layout's layout/offers,
//     Accessibility's and Facilities' missing) reads as labels, not raw codes
//     (venueSuitabilityDisplay.js). An older stored result without them shows
//     its detail, as before.
//   - An optional `subject` (the venue's name) is read out with the verdict,
//     "Hall A: Not suitable", so a screen reader user hears which venue the
//     answer is for. It is visually hidden: the heading above already says.

import { formatVenuePeriod } from "../services/datetimeFormat";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../services/venueLookups";
import { codesText, criterionDetailText, labelFor } from "../services/venueSuitabilityDisplay";

const NONE_REQUESTED = "None requested";

/** An unmet criterion the coordinator chose to go ahead without. */
function isOverridden(criterion, overriddenNames) {
  return !criterion?.met && overriddenNames.includes(criterion?.criterion);
}

/** "Met", "Not met", or -- for an overridden criterion -- says so. */
function metText(criterion, overriddenNames) {
  if (criterion?.met) return "Met";
  return isOverridden(criterion, overriddenNames)
    ? "Not met — overridden by coordinator"
    : "Not met";
}

export default function VenueSuitabilityResult({ result, overridden, subject }) {
  const overriddenNames = Array.isArray(overridden) ? overridden : [];
  const criteria = Array.isArray(result?.criteria) ? result.criteria : [];
  const checked = result?.checked ?? {};
  const suitable = result?.suitable === true;
  const verdict = suitable ? "Suitable" : "Not suitable";

  const checkedRows = [
    { term: "When", value: formatVenuePeriod(checked.startsAt, checked.endsAt) },
    { term: "Expected attendance", value: checked.expectedAttendance ?? "Not specified" },
    {
      term: "Layout",
      value: checked.layout ? labelFor(checked.layout, ROOM_LAYOUTS) : NONE_REQUESTED,
    },
    { term: "Accessibility features", value: codesText(checked.accessibility, ACCESSIBILITY_FEATURES, NONE_REQUESTED) },
    { term: "Facilities", value: codesText(checked.facilities, FACILITIES, NONE_REQUESTED) },
  ];

  return (
    <div className="venue-suitability">
      <p
        className={`venue-suitability__verdict venue-suitability__verdict--${suitable ? "met" : "unmet"}`}
        role="status"
      >
        {subject ? (
          <>
            <span className="visually-hidden">{subject}: </span>
            <span>{verdict}</span>
          </>
        ) : (
          verdict
        )}
      </p>

      <ul className="venue-suitability__criteria" aria-label="Criteria">
        {criteria.map((criterion, i) => {
          const detail = criterionDetailText(criterion);
          return (
            <li
              key={`${criterion?.criterion ?? "criterion"}-${i}`}
              className={`venue-suitability__criterion venue-suitability__criterion--${criterion?.met ? "met" : "unmet"}${isOverridden(criterion, overriddenNames) ? " venue-suitability__criterion--overridden" : ""}`}
            >
              <strong>{metText(criterion, overriddenNames)}</strong>
              <span className="venue-suitability__criterion-name">{criterion?.criterion}</span>
              {detail && <span className="venue-suitability__criterion-detail">{detail}</span>}
            </li>
          );
        })}
      </ul>

      <h4>Checked against</h4>
      <dl className="venue-suitability__checked">
        {checkedRows.map(({ term, value }) => (
          <div key={term} className="venue-suitability__checked-row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
