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
// AC2, nothing recorded: a fact that is null, missing or blank reads "Not
// recorded" (safetyFactText), muted, rather than as an empty line that looks
// like the screen failed to load.
//
// The hand-off to SCRUM-490 (the Safety Officer's event review):
//   - mount one instance per booked venue, e.g.
//     <VenueSafetyFacts {...venue} venueName={venue.name} />;
//   - read each venue with getVenueDetails(id) from services/venueService.js.
//     GET /api/venues/:id needs only a signed-in user
//     (backend/src/routes/venues.js:433, behind the router.use(requireAuth) at
//     :310), so a future Safety Officer can already read it;
//   - SCRUM-490 decides whether to role-gate that route once it adds the role.
//
// Presentational only: no fetching, no loading or error states. The caller
// owns those, as VenueDetail does.

import { SAFETY_FACTS, safetyFactText } from "../services/venueSafetyFacts";

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

  return (
    <section
      className="venue-safety-facts"
      aria-label={hasName ? `Safety information for ${venueName}` : "Safety information"}
    >
      {hasName && <Heading className="venue-safety-facts__heading">{venueName}</Heading>}
      <dl>
        {SAFETY_FACTS.map(({ key, label }) => {
          // Muted, so "Not recorded" cannot be mistaken for text someone
          // typed. Decided from the value, not by comparing the rendered
          // string, so a venue whose notes literally say "Not recorded"
          // still reads as entered text.
          const value = values[key];
          const recorded = typeof value === "string" && value.trim() !== "";
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
    </section>
  );
}
