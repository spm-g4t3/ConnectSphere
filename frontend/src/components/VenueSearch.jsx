// VenueSearch.jsx
// Updated to match the backend's real supported filters (location, minCapacity)
// and response shape ({ id, name, location, maxCapacity }). Date filtering
// isn't supported by the backend yet — raise that as a separate ticket if
// your team needs it; don't invent it client-side.
//
// SCRUM-45 added the seeded arrival: a Coordinator reaching this page from an
// event request lands with ?minCapacity=<expected attendance> already applied
// and a banner naming the event. Two rules govern that, and both are load-
// bearing rather than stylistic:
//
//   - The URL seeds the form ONCE, on first render. It is not two-way bound.
//     Writing every keystroke back into the address bar would fight the input
//     and fill the history stack; reading it on every render would clobber
//     what the Coordinator is typing.
//   - Filters live in the query string, context lives in router state. The
//     filter must survive a reload — losing it silently is the exact bug the
//     handoff exists to prevent — while the event name must not, because a
//     request's title in a URL leaks into history and into any shared link.
//     So on reload the banner disappears and the search still behaves
//     correctly. The filters are the contract; the banner is decoration.

import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { searchActiveVenues } from "../services/venueService";

export default function VenueSearch() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  // The banner's copy, or undefined on an ordinary visit. Router state, so it
  // is gone after a reload by design — see the header.
  const context = location.state?.eventRequestContext;

  // A lazy initialiser, not a plain object. useState's argument is evaluated
  // on every render even though only the first result is kept, so building
  // the seed inline would re-read the URL on every keystroke — cheap, but it
  // invites the next reader to "simplify" it into a value that does get
  // reapplied. The function form says once and means it.
  const [filters, setFilters] = useState(() => ({
    location: searchParams.get("location") ?? "",
    minCapacity: searchParams.get("minCapacity") ?? "",
  }));
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const venues = await searchActiveVenues({
        location: filters.location || undefined,
        minCapacity: filters.minCapacity ? Number(filters.minCapacity) : undefined,
      });
      setResults(venues);
      setSearched(true);
    } catch {
      setError("Could not load venues. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Arriving with a filter in the URL means somebody already asked the
  // question; making them press Search to repeat it is a wasted click. Fired
  // once and only once.
  //
  // The guard is a ref rather than an empty dependency array, and that is not
  // belt-and-braces. handleSearch is useCallback([filters]), so its identity
  // changes on every keystroke — listing it as a dependency would re-run this
  // effect mid-typing, and omitting it is the stale-closure bug lint warns
  // about. A ref sidesteps the question: the effect may run as often as React
  // likes, and the body runs at most once.
  const autoSearched = useRef(false);

  useEffect(() => {
    if (autoSearched.current) return;
    if (!searchParams.get("location") && !searchParams.get("minCapacity")) return;

    autoSearched.current = true;
    handleSearch();
  }, [searchParams, handleSearch]);

  return (
    <div className="venue-search">
      {context && (
        <div className="venue-search__context">
          {location.state?.returnToReview && (
            <button
              type="button"
              className="venue-search__back"
              onClick={() => navigate("/review-queue", { state: location.state.returnToReview })}
            >
              Back to event review
            </button>
          )}
          <p>
            Finding a venue for <strong>{context.eventName}</strong>.
          </p>
          {/* Verbatim, never parsed into a filter. This is free prose — "a
              large room, ideally tiered seating" — and an ilike on a token
              guessed out of it would return zero rows and read as "no venues
              exist". Show it beside the search box and let a person do the
              matching. */}
          {context.venueRequirements && (
            <p>
              Their venue requirements: <em>{context.venueRequirements}</em>
            </p>
          )}
        </div>
      )}

      <div className="venue-search__filters">
        <input
          type="text"
          placeholder="Location"
          value={filters.location}
          onChange={(e) => setFilters({ ...filters, location: e.target.value })}
        />
        <input
          type="number"
          min="1"
          placeholder="Min capacity"
          value={filters.minCapacity}
          onChange={(e) => setFilters({ ...filters, minCapacity: e.target.value })}
        />
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search venues"}
        </button>
      </div>

      {error && <p className="venue-search__error">{error}</p>}

      <ul className="venue-search__results">
        {results.map((venue) => (
          <li key={venue.id}>
            <strong>{venue.name}</strong> — {venue.location}, seats up to {venue.maxCapacity}
          </li>
        ))}
        {searched && !loading && results.length === 0 && (
          <p>No active venues match your search.</p>
        )}
      </ul>
    </div>
  );
}
