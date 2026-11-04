// FlaggedBookingFlagDetail.jsx
//
// Why a booking was flagged and any replacement already requested for it, as
// both Venue Staff's card and the coordinator's event screen show them.
//
// The heading level follows the page it sits in. Each screen may add its own
// note after the reasons and after the replacements, so those are passed in.

import { flagReasons, replacementRequestText, replacementRequests } from "../services/flaggedBookingDisplay";

export default function FlaggedBookingFlagDetail({ item, headingLevel, reasonsNote, replacementsNote }) {
  const Heading = `h${headingLevel}`;
  const reasons = flagReasons(item);
  const replacements = replacementRequests(item);

  return (
    <>
      <Heading>Why it was flagged</Heading>
      <ul className="pending-bookings__overlapping">
        {reasons.map((r) => (
          <li key={r.kind}>
            <strong>{r.text}</strong>
            {r.details.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </li>
        ))}
      </ul>
      {reasonsNote}

      {replacements.length > 0 && (
        <>
          <ul className="pending-bookings__overlapping">
            {replacements.map((r) => (
              <li key={r.id}>{replacementRequestText(r)}</li>
            ))}
          </ul>
          {replacementsNote}
        </>
      )}
    </>
  );
}
