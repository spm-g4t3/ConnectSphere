// BookingSuitabilitySummary.jsx
//
// SCRUM-188 AC7: "The suitability result, including any criterion the
// coordinator chose to override, is attached to the booking request so that
// Venue Staff can see it."
//
// The suitability result as it stood when the coordinator sent the booking
// request: the verdict, the criteria they chose to go ahead without, and the
// full check behind a collapsed <details>. The breakdown is
// VenueSuitabilityResult (SCRUM-191), given the `overridden` names so an
// overridden criterion reads as one.
//
// Read-only and self-contained: no state, no calls, only its props, so that
// SCRUM-258's Venue Staff review screen can drop it in as it is used on
// VenueDetail's bookings list.
//
// Props come straight from GET /api/venues/:id/bookings (Venue Staff rows):
//   suitability           {suitable, criteria, checked} | null
//   suitabilityOverridden boolean
//   overriddenCriteria    string[]

import VenueSuitabilityResult from "./VenueSuitabilityResult";

export default function BookingSuitabilitySummary({
  suitability,
  suitabilityOverridden,
  overriddenCriteria,
}) {
  if (!suitability) {
    return (
      <div className="booking-suitability">
        <p className="booking-suitability__none">
          No suitability result was recorded for this request.
        </p>
      </div>
    );
  }

  const suitable = suitability.suitable === true;
  const overridden = Array.isArray(overriddenCriteria) ? overriddenCriteria : [];
  const showOverride = suitabilityOverridden === true && overridden.length > 0;

  return (
    <div className="booking-suitability">
      <p className="booking-suitability__verdict">
        Suitability when requested:{" "}
        <strong
          className={`booking-suitability__verdict-value booking-suitability__verdict-value--${suitable ? "met" : "unmet"}`}
        >
          {suitable ? "Suitable" : "Not suitable"}
        </strong>
      </p>

      {showOverride && (
        <p className="booking-suitability__override">
          Requested despite not meeting: {overridden.join(", ")}
        </p>
      )}

      <details className="booking-suitability__details">
        <summary>Show the full check</summary>
        <VenueSuitabilityResult result={suitability} overridden={overridden} />
      </details>
    </div>
  );
}
