import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// SCRUM-17 and SCRUM-186 files are gated at 100%
// lines/branches/functions/statements each.
// There is deliberately no global threshold: shared files -- venueService.js,
// VenueCatalogue.jsx, VenueSearch.jsx (other stories) and datetimeFormat.js
// (pre-existing; its time-zone-dependent sign branch cannot be reached in UTC
// CI) -- are reported but not gated.
const FULL = { lines: 100, branches: 100, functions: 100, statements: 100 }

// The one justified exception, set to the measured figures so any NEW
// uncovered line or branch still fails CI. Three double-click guards in
// VenueBlocksPanel.jsx are unreachable -- `if (submitting) return` in send,
// `if (!pendingPayload) return` in handleOverride and `if (removingId) return`
// in handleRemove -- because their buttons are disabled while those states
// hold, and React does not dispatch clicks to disabled buttons. They are kept
// as cheap defence; the disabled buttons are the real protection.
const PANEL = { lines: 100, branches: 97.56, functions: 100, statements: 97.81 }

const SCRUM17_FILES = [
  'src/components/VenueBlocksPanel.jsx',
  'src/components/VenueBlockForm.jsx',
  'src/components/BlockConflictList.jsx',
  'src/components/BlockHistory.jsx',
  'src/components/CoordinatorNotifications.jsx',
  'src/services/venueBlockValidation.js',
  'src/services/venueBlockReasons.js',
  'src/services/venueBlockErrors.js',
  'src/services/venueBlockDisplay.js',
  'src/services/venueBlockHistoryDisplay.js',
  'src/services/venueSearchValidation.js',
  'src/services/notificationDisplay.js',
  'src/services/notificationService.js',
  'src/services/displayFormat.js',
]

// SCRUM-186 owns one new file outright. VenueForm.jsx and VenueDetail.jsx
// are SCRUM-15's and shared, so, like venueService.js, they are not gated.
const SCRUM186_FILES = ['src/services/turnaroundOptions.js']

// https://vite.dev/config/
//
// defineConfig comes from vitest/config rather than vite so the `test` block
// below is typed and validated. Vite itself ignores `test`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // Explicit imports (describe/it/expect from 'vitest') rather than globals,
    // matching the backend suite and keeping ESLint's no-undef honest.
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      reporter: ['text', 'json-summary'],
      reportOnFailure: true,
      thresholds: Object.fromEntries([
        ...SCRUM17_FILES.map((file) => [
          file,
          file === 'src/components/VenueBlocksPanel.jsx' ? PANEL : FULL,
        ]),
        ...SCRUM186_FILES.map((file) => [file, FULL]),
      ]),
    },
  },
})
