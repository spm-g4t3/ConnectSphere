/**
 * OPEN_EVENTS_ENABLED=true mounts GET /api/open-events. It ships dark because
 * it needs the registrations table; unset, the route is a 404, not a 500.
 */
export function isOpenEventsEnabled(env = process.env) {
  return env.OPEN_EVENTS_ENABLED === 'true';
}
