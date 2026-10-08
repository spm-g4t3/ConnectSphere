// VenueSafetyFacts.jsx
//
// SCRUM-493: one venue's safety facts -- emergency access and known
// restrictions -- read-only. VenueDetail shows them with it now, and the
// Safety Officer's review will too, so the two screens cannot drift into two
// renderings of the same record.
//
// AC3, read-only: there are no form controls, buttons or links here, so
// "read-only" is the structure of the component, not only its styling.
//
// AC2, nothing recorded: a fact that is null, missing, blank or made only of
// invisible characters reads "Not recorded" (safetyFactText), muted, rather than as an empty line that looks
// like the screen failed to load.
//
// The hand-off to SCRUM-490 (the Safety Officer's event review):
//   - mount one instance per booked venue and pass venueName for each, e.g.
//     <VenueSafetyFacts {...venue} venueName={venue.name} />. With a
//     venueName the facts are a <section> named by their own heading
//     (aria-labelledby), so each booked venue is a distinct, named region
//     a screen reader can jump between;
//   - without a venueName they are a plain <div>, not a region: VenueDetail
//     already wraps them in its "Safety information" section, and a second
//     region with the same name would only repeat it;
//   - read each venue with getVenueDetails(id) from services/venueService.js.
//     GET /api/venues/:id needs only a signed-in user
//     (backend/src/routes/venues.js:433, behind the router.use(requireAuth) at
//     :310), so a future Safety Officer can already read it;
//   - SCRUM-490 decides whether to role-gate that route once it adds the role.
//
// Presentational only: no fetching, no loading or error states. The caller
// owns those, as VenueDetail does.

import { useId } from "react";

import { SAFETY_FACTS, isRecordedText, safetyFactText } from "../services/venueSafetyFacts";

/** h2-h6 only: h1 is the page's, and anything else is not a heading. */
function clampHeadingLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 4;
  return Math.min(6, Math.max(2, Math.round(n)));
}

export default function VenueSafetyFacts({
  emergencyAccess,
  knownRestrictions,
  venueName,
  headingLevel = 4,
}) {
  const values = { emergencyAccess, knownRestrictions };
  const hasName = typeof venueName === "string" && venueName.trim() !== "";
  const Heading = `h${clampHeadingLevel(headingLevel)}`;
  const headingId = useId();

  const facts = (
    <dl>
      {SAFETY_FACTS.map(({ key, label }) => {
        // Muted, so "Not recorded" cannot be mistaken for text someone
        // typed. Decided from the value, not by comparing the rendered
        // string, so a venue whose notes literally say "Not recorded"
        // still reads as entered text. isRecordedText, the same test
        // safetyFactText uses, so whitespace- or invisible-only text is muted
        // along with the "Not recorded" shown in its place.
        const value = values[key];
        const recorded = isRecordedText(value);
        return (
          <div key={key}>
            <dt>{label}</dt>
            <dd className={recorded ? undefined : "venue-safety-facts__not-recorded"}>
              {safetyFactText(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );

  // Named by the visible heading rather than a separate aria-label, so what
  // a screen reader announces is what a sighted reader sees.
  if (hasName) {
    return (
      <section className="venue-safety-facts" aria-labelledby={headingId}>
        <Heading className="venue-safety-facts__heading" id={headingId}>
          {venueName}
        </Heading>
        {facts}
      </section>
    );
  }

  return <div className="venue-safety-facts">{facts}</div>;
}
