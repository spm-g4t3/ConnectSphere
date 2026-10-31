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
    // SCRUM-486 (SCRUM-522): one worker per physical core, not per logical one.
    // Each tests/db suite builds its own PGlite database (CPU-bound WebAssembly)
    // from the baseline in beforeAll. Vitest's default of
    // availableParallelism() - 1 processes puts two of them on one physical
    // core (SMT), and a test's clock keeps running while its process waits, so
    // full runs failed random cheap tests on the 5000ms timeout that passed
    // alone. Capping the workers removes the oversubscription without costing
    // wall time (the run is as long as its slowest file); '50%' rather than a
    // number so it scales with whoever runs it.
    //
    // (Vitest 5 has no poolOptions.threads.maxThreads; maxWorkers is the
    // top-level setting for every pool.)
    maxWorkers: '50%',
    // SCRUM-486 (after the merge of dev, 12 October): the hook timeout, for the
    // same contention. The cap above manages it; it cannot remove it, and there
    // are now 25 PGlite suites, up from 20. A PGlite suite builds its database
    // in beforeAll, which takes a few seconds alone and several times that
    // when the machine is busy. Under Vitest's 10-second default, three of
    // SCRUM-370's new suites failed in full runs with "Hook timed out" and
    // passed alone in 6 seconds: a starved hook read as a broken schema.
    // 60 seconds is what SCRUM-486's own suites already pass per hook. Global,
    // not per suite, so the next PGlite suite anyone adds is covered without
    // having to know this. A hook that genuinely hangs still fails, a minute
    // later. The tests themselves keep the 5-second default: they are cheap
    // once the database exists, and a slow test is still worth hearing about.
    hookTimeout: 60_000,
    // Point supertest's requests at the loopback of the family its server is
    // bound to ('[::1]' for the default dual-stack listener), not always
    // 127.0.0.1. Without this, parallel workers occasionally reach each
    // other's servers (a stray 401/404 or a 5000ms timeout in a random route
    // test); see the file's header for the evidence.
    setupFiles: ['tests/setup/loopbackServers.js'],
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
        // SCRUM-137: the same reasoning -- setupOptions.js is new and owned
        // outright, while the validation and service edits sit in shared files.
        'src/domain/setupOptions.js': FULL,
        // SCRUM-178 (SCRUM-179): the calendar read is a new file only this
        // story owns, so it gates without pulling in routes/venues.js.
        'src/services/venueCalendarService.js': FULL,
        // SCRUM-138 (SCRUM-20 AC3/AC4): the matching rule is a new pure file
        // only this story owns. The service and validation edits sit in
        // SCRUM-15's shared files, so they are reported but do not gate.
        'src/domain/venueMatching.js': FULL,
        // SCRUM-491: the hold files are new and owned outright. The edits to
        // shared files (venueService.js, bookingRequestService.js, the
        // routes) are reported but do not gate; venueCalendarService.js and
        // notificationService.js already gate above.
        'src/domain/venueHoldStatus.js': FULL,
        'src/validation/venueHoldValidation.js': FULL,
        'src/services/venueHoldService.js': FULL,
        'src/jobs/venueHoldExpiryScheduler.js': FULL,
        // SCRUM-460: hands out places freed while registration was closed.
        'src/jobs/waitlistPromotionScheduler.js': FULL,
        // SCRUM-237: announces registration opening and closing; and which jobs start.
        'src/jobs/registrationWindowScheduler.js': FULL,
        'src/jobs/backgroundJobs.js': FULL,
        // SCRUM-284 (SCRUM-285): the queue route, validation and service are new and owned outright.
        'src/routes/equipmentQueue.js': FULL,
        'src/validation/equipmentQueueValidation.js': FULL,
        'src/services/equipmentQueueService.js': FULL,
        // SCRUM-495: the browse files are new and owned outright.
        'src/routes/openEvents.js': FULL,
        'src/services/openEventService.js': FULL,
        'src/domain/registrationWindow.js': FULL,
        'src/domain/registrationAvailability.js': FULL,
        // SCRUM-24: the protected attendee read and its authorisation policy.
        'src/routes/attendeeEvents.js': FULL,
        'src/services/attendeeEventService.js': FULL,
        // SCRUM-266: the flagged-booking resolution files are new and owned outright.
        'src/routes/flaggedBookings.js': FULL,
        'src/services/flaggedBookingService.js': FULL,
        'src/validation/flaggedBookingValidation.js': FULL,
        // SCRUM-478: the registration list service and its labels are new and owned outright.
        'src/services/registrationListService.js': FULL,
        'src/domain/registrationEntryStatus.js': FULL,
      },
    },
  },
});
