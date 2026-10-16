import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// SCRUM-17, SCRUM-186, SCRUM-178, SCRUM-137, SCRUM-491 and SCRUM-495 files are gated at 100%
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

// SCRUM-255's one exception, measured the same way: if (sending.current) return
// in MyBookingRequests.jsx's handleWithdraw is unreachable, because every
// Withdraw button is disabled while one is being sent and React does not
// dispatch clicks to disabled buttons. The ref is cheap defence behind them.
const MY_BOOKING_REQUESTS = { lines: 100, branches: 98.07, functions: 100, statements: 98.24 }

// SCRUM-525's one exception, measured the same way: if (checking) return in
// BookingRequestPanel.jsx's handleSubmit is unreachable, because the send
// button is disabled while a recheck runs and Enter in the attendance field
// only starts the check. The guard is cheap defence behind the button.
const BOOKING_REQUEST_PANEL = { lines: 100, branches: 99.4, functions: 100, statements: 99.3 }

const SCRUM17_FILES = [
  'src/components/VenueBlocksPanel.jsx',
  'src/components/VenueBlockForm.jsx',
  'src/components/BlockConflictList.jsx',
  'src/components/BlockHistory.jsx',
  'src/components/NotificationInbox.jsx',
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

// SCRUM-137 (SCRUM-20) likewise owns one new file outright; its VenueForm.jsx
// and VenueDetail.jsx edits sit in shared files and are not gated.
const SCRUM137_FILES = ['src/services/setupOptions.js']

// SCRUM-141 (SCRUM-20) owns the inline event venue search outright.
// CoordinatorRequestDetail.jsx and venueService.js are shared, so not gated.
const SCRUM141_FILES = [
  'src/services/eventVenueSearchForm.js',
  'src/components/EventVenueFinder.jsx',
]

// SCRUM-178 (the calendar, built in SCRUM-180) owns these three outright.
// venueService.js gains getVenueCalendar but is shared, so it is not gated,
// and neither is App.jsx for the route.
const SCRUM178_FILES = [
  'src/services/calendarRange.js',
  'src/services/calendarEntryDisplay.js',
  'src/components/VenueCalendar.jsx',
]

// SCRUM-254 owns these outright. VenueSearch.jsx and CoordinatorRequestDetail.jsx
// gain the request button and the richer handoff but are shared (SCRUM-45,
// SCRUM-130, SCRUM-185, SCRUM-334), so, like venueService.js, they are not gated.
const SCRUM254_FILES = [
  'src/components/BookingRequestPanel.jsx',
  'src/services/bookingRequestService.js',
  'src/services/bookingRequestEligibility.js',
  'src/services/bookingRequestErrors.js',
  'src/components/MyBookingRequests.jsx',
  'src/services/bookingRequestStatusDisplay.js',
]

// SCRUM-485 (SCRUM-509) owns the two new dashboards outright. Dashboard.jsx
// gains their map entries but is shared by every role, so, like App.jsx, it
// is not gated.
const SCRUM485_FILES = [
  'src/components/EventCoordinatorLeadDashboard.jsx',
  'src/components/SafetyOfficerDashboard.jsx',
]

// SCRUM-491 owns the tentative-hold panel, form and their two services
// outright. The edits it makes to shared files are gated where those files
// already are (calendarEntryDisplay.js, calendarRange.js, VenueCalendar.jsx,
// bookingRequestErrors.js, BookingRequestPanel.jsx, notificationDisplay.js,
// eventVenueSearchForm.js, EventVenueFinder.jsx); VenueCatalogue.jsx and
// venueService.js stay ungated, as above.
const SCRUM491_FILES = [
  'src/components/VenueHoldsPanel.jsx',
  'src/components/VenueHoldForm.jsx',
  'src/services/venueHoldErrors.js',
  'src/services/venueHoldValidation.js',
]

// SCRUM-486 (SCRUM-519) owns the Lead's unassigned queue, the assignment
// picker and the waiting-time helper outright. EventCoordinatorLeadDashboard.jsx,
// which now mounts the queue, is already gated above under SCRUM-485. The
// edits it makes to shared files (eventRequestService.js, ReassignEventPanel.jsx,
// CoordinatorRequestDetail.jsx, Navigation.jsx, App.jsx) stay ungated, as
// those files always have been.
const SCRUM486_FILES = [
  'src/components/UnassignedQueue.jsx',
  'src/components/AssignCoordinatorPanel.jsx',
  'src/services/waitingTime.js',
  // SCRUM-521: an event's coordinator screen by its address.
  'src/components/EventRequestReviewPage.jsx',
  // AC6: the Lead's list of assigned events, the way to that screen.
  'src/components/AssignedEvents.jsx',
]

// SCRUM-487: the Lead's coordinator overview. New files only this story owns,
// gated outright. AssignedEvents.jsx, which it extends, stays in
// SCRUM486_FILES, so its 100% gate holds over both stories' code.
const SCRUM487_FILES = [
  // SCRUM-543 (AC4): the unassigned count at the top.
  'src/components/UnassignedCount.jsx',
  // SCRUM-544 (AC2, AC3): the coordinators' table and the list's filters.
  'src/components/CoordinatorWorkloadTable.jsx',
  'src/components/AssignedEventsFilters.jsx',
]

// SCRUM-258 owns the Venue Staff queue and its decision card outright.
// VenueStaffDashboard.jsx, which mounts the queue, and the shared services
// it calls (bookingRequestService.js, already gated under SCRUM-254) are not
// added here.
const SCRUM258_FILES = [
  'src/components/PendingBookingRequests.jsx',
  'src/components/PendingBookingRequestCard.jsx',
]

// SCRUM-266 owns Venue Staff's flagged bookings list and its card, and the
// services behind them. flaggedBookingDisplay.js, shared with the venue
// catalogue and the coordinator's list, is gated here too: its older tests
// already cover every line, and this story adds flagReasons and its tests.
const SCRUM266_FILES = [
  'src/components/FlaggedBookings.jsx',
  'src/components/FlaggedBookingCard.jsx',
  'src/services/flaggedBookingService.js',
  'src/services/flaggedBookingErrors.js',
  'src/services/flaggedBookingDisplay.js',
]

// SCRUM-495: the Attendee's browse pages. New files only this story owns.
const SCRUM495_FILES = [
  'src/components/BrowseOpenEvents.jsx',
  'src/components/BrowseEventDetails.jsx',
  'src/components/useRefreshOnReturn.js',
  'src/components/useOpenEventRead.js',
  'src/components/OpenEventAvailability.jsx',
  'src/services/openEventDisplay.js',
  'src/services/openEventRoutes.js',
  'src/services/openEventService.js',
]

// SCRUM-489: the coordinator's safety check submission. Its one new file is
// gated outright; the shared files it touches stay ungated.
const SCRUM489_FILES = [
  // SCRUM-557 (AC3 to AC6): the checklist, the confirmation, the note and Submit.
  'src/components/SafetyCheckSubmissionPanel.jsx',
]

// SCRUM-172: the shared unread count behind the nav badge and the inbox
// heading. NotificationInbox.jsx and notificationService.js stay in
// SCRUM17_FILES, where their 100% gate already holds.
const SCRUM172_FILES = [
  'src/notifications/UnreadCountContext.jsx',
  // AC4: the re-read on returning to the tab, shared with the inbox.
  'src/notifications/useRefetchOnReturn.js',
  // AC7: where each role lands when it opens a notification.
  'src/services/notificationLink.js',
]

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
    testTimeout: 15000,
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
        ...SCRUM178_FILES.map((file) => [file, FULL]),
        ...SCRUM137_FILES.map((file) => [file, FULL]),
        ...SCRUM141_FILES.map((file) => [file, FULL]),
        ...SCRUM254_FILES.map((file) => [
          file,
          file === 'src/components/MyBookingRequests.jsx'
            ? MY_BOOKING_REQUESTS
            : file === 'src/components/BookingRequestPanel.jsx'
              ? BOOKING_REQUEST_PANEL
              : FULL,
        ]),
        ...SCRUM485_FILES.map((file) => [file, FULL]),
        ...SCRUM491_FILES.map((file) => [file, FULL]),
        ...SCRUM486_FILES.map((file) => [file, FULL]),
        ...SCRUM487_FILES.map((file) => [file, FULL]),
        ...SCRUM258_FILES.map((file) => [file, FULL]),
        ...SCRUM266_FILES.map((file) => [file, FULL]),
        ...SCRUM495_FILES.map((file) => [file, FULL]),
        ...SCRUM489_FILES.map((file) => [file, FULL]),
        ...SCRUM172_FILES.map((file) => [file, FULL]),
      ]),
    },
  },
})
