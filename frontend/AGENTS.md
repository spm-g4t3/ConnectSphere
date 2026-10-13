# Frontend

- Every page route is wrapped in `ProtectedRoute allowedRoles={[...]}` in `src/App.jsx`. Its roles must match the backend route's `requireRole`.
- Venue and event times are shown in Singapore time on every device. Format them with `src/services/datetimeFormat.js` (`VENUE_TIME_ZONE`), not the browser's local zone.
- All API calls go through `src/services/*.js`; components never call `fetch` or Supabase directly.
- Tests mock services with `vi.mock`. The factory is strict, so list every export the component tree reaches.
- A new story's files get an entry in the coverage thresholds in `vite.config.js`.
