/**
 * Features that ship dark until what they depend on is in the database.
 *
 * OPEN_EVENTS_ENABLED=true turns on GET /api/open-events (SCRUM-495), which
 * needs SCRUM-494's registration settings, SCRUM-22's `registrations` table and
 * migration 068. Unset, or anything but "true", leaves the route unmounted, so
 * it answers 404 rather than 500.
 */
export function isOpenEventsEnabled(env = process.env) {
  return env.OPEN_EVENTS_ENABLED === 'true';
}
