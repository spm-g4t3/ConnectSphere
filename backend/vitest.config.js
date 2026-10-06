import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the backend.
 *
 * The test include is left at Vitest's default, so `npm test` finds exactly
 * the files it found before this config existed. Only coverage is configured.
 *
 * Coverage (SCRUM-132): `npm run test:coverage` reports every file under src/
 * and enforces a 100% threshold per file on the SCRUM-17 (venue blocks)
 * files only. There is deliberately no global threshold: files shared with or
 * owned by other stories -- venueService.js and routes/venues.js belong to
 * SCRUM-15, which SCRUM-17 only extended -- are reported but never gate CI,
 * so a teammate's coverage cannot fail this story's build or vice versa.
 *
 * src/app.js is excluded: it only wires routers and starts the server, and
 * the route tests build their apps from the router factories instead.
 */
const FULL = { lines: 100, branches: 100, functions: 100, statements: 100 };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/app.js'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        'src/services/venueBlockService.js': FULL,
        'src/services/notificationService.js': FULL,
        'src/validation/venueBlockValidation.js': FULL,
        'src/validation/notificationValidation.js': FULL,
        'src/validation/timestampValidation.js': FULL,
        'src/http/handleError.js': FULL,
        'src/routes/notifications.js': FULL,
        'src/domain/venueBlockReason.js': FULL,
        'src/domain/bookingStatus.js': FULL,
        // SCRUM-186: a new file only this story owns, so it can gate without
        // pulling in SCRUM-15's shared venueService.js or venueValidation.js.
        'src/domain/turnaroundOptions.js': FULL,
        // SCRUM-178 (SCRUM-179): the calendar read is a new file only this
        // story owns, so it gates without pulling in routes/venues.js.
        'src/services/venueCalendarService.js': FULL,
      },
    },
  },
});
