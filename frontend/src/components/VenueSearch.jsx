// VenueSearch.jsx
// Updated to match the backend's real supported filters (location, minCapacity)
// and response shape ({ id, name, location, maxCapacity }). Date filtering
// isn't supported by the backend yet — raise that as a separate ticket if
// your team needs it; don't invent it client-side.

import { useState, useCallback } from "react";
import { searchActiveVenues } from "../services/venueService";

export default function VenueSearch() {
  const [filters, setFilters] = useState({
    location: "",
    minCapacity: "",
  });
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
    } catch (err) {
      setError("Could not load venues. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  return (
    <div className="venue-search">
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
