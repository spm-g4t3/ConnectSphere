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
//     EventVenueFinder's codesText uses, rather than vanishing.

import { toVenueWallClock } from "../services/datetimeFormat";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../services/venueLookups";

const NONE_REQUESTED = "None requested";

function labelFor(code, options) {
  return options.find((option) => option.code === code)?.label ?? code;
}

function codesText(codes, options) {
  if (!Array.isArray(codes) || codes.length === 0) return NONE_REQUESTED;
  return codes.map((code) => labelFor(code, options)).join(", ");
}

/**
 * "2026-11-11 10:00 – 12:00 (Singapore time)", or both dates in full when the
 * period crosses a Singapore midnight.
 */
function periodText(startsAt, endsAt) {
  const start = toVenueWallClock(startsAt);
  const end = toVenueWallClock(endsAt);
  if (!start || !end) return "Not set";
  const [startDate, startTime] = start.split("T");
  const [endDate, endTime] = end.split("T");
  const endText = startDate === endDate ? endTime : `${endDate} ${endTime}`;
  return `${startDate} ${startTime} – ${endText} (Singapore time)`;
}

export default function VenueSuitabilityResult({ result }) {
  const criteria = Array.isArray(result?.criteria) ? result.criteria : [];
  const checked = result?.checked ?? {};
  const suitable = result?.suitable === true;

  const checkedRows = [
    { term: "When", value: periodText(checked.startsAt, checked.endsAt) },
    { term: "Expected attendance", value: checked.expectedAttendance ?? "Not specified" },
    {
      term: "Layout",
      value: checked.layout ? labelFor(checked.layout, ROOM_LAYOUTS) : NONE_REQUESTED,
    },
    { term: "Accessibility features", value: codesText(checked.accessibility, ACCESSIBILITY_FEATURES) },
    { term: "Facilities", value: codesText(checked.facilities, FACILITIES) },
  ];

  return (
    <div className="venue-suitability">
      <p
        className={`venue-suitability__verdict venue-suitability__verdict--${suitable ? "met" : "unmet"}`}
        role="status"
      >
        {suitable ? "Suitable" : "Not suitable"}
      </p>

      <ul className="venue-suitability__criteria" aria-label="Criteria">
        {criteria.map((criterion, i) => (
          <li
            key={`${criterion?.criterion ?? "criterion"}-${i}`}
            className={`venue-suitability__criterion venue-suitability__criterion--${criterion?.met ? "met" : "unmet"}`}
          >
            <strong>{criterion?.met ? "Met" : "Not met"}</strong>
            <span className="venue-suitability__criterion-name">{criterion?.criterion}</span>
            {criterion?.detail && (
              <span className="venue-suitability__criterion-detail">{criterion.detail}</span>
            )}
          </li>
        ))}
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
