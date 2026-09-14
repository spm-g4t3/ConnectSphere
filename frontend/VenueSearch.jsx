// VenueSearch.jsx
// Example component — adapt styling/props to match your existing venue search UI.

import { useState, useCallback } from "react";
import { searchActiveVenues } from "./venueService";

export default function VenueSearch() {
  const [filters, setFilters] = useState({
    date: "",
    capacity: "",
    location: "",
  });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const venues = await searchActiveVenues(filters);
      setResults(venues);
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
          type="date"
          value={filters.date}
          onChange={(e) => setFilters({ ...filters, date: e.target.value })}
        />
        <input
          type="number"
          placeholder="Min capacity"
          value={filters.capacity}
          onChange={(e) =>
            setFilters({ ...filters, capacity: e.target.value })
          }
        />
        <input
          type="text"
          placeholder="Location"
          value={filters.location}
          onChange={(e) =>
            setFilters({ ...filters, location: e.target.value })
          }
        />
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search venues"}
        </button>
      </div>

      {error && <p className="venue-search__error">{error}</p>}

      <ul className="venue-search__results">
        {results.map((venue) => (
          <li key={venue.id}>
            <strong>{venue.name}</strong> — capacity {venue.capacity}
          </li>
        ))}
        {!loading && results.length === 0 && <p>No active venues found.</p>}
      </ul>
    </div>
  );
}
