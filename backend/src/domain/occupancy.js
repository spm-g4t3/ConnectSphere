/**
 * The occupied part of a venue_occupancy_conflicts() or occupancy_conflict_json()
 * row, in camelCase, for every mapper that returns one.
 *
 * Read from the row, never recomputed, so the setup and turnaround padding
 * formula stays in SQL. Pure, so any service can use it without an import cycle.
 */

/**
 * @param {object} row  snake_case; a field the row does not carry stays undefined
 * @returns {{occupiedStartsAt: string, occupiedEndsAt: string,
 *            setupMinutes: number, turnaroundMinutes: number}}
 */
export function toOccupiedPeriod(row) {
  return {
    occupiedStartsAt: row.occupied_starts_at,
    occupiedEndsAt: row.occupied_ends_at,
    setupMinutes: row.setup_minutes,
    turnaroundMinutes: row.turnaround_minutes,
  };
}
