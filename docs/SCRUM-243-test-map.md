# SCRUM-243 test map

Which test proves which acceptance criterion of SCRUM-243 (Submit a Venue
Booking Request), and what is not proved. Written for SCRUM-256. Paths are
under `backend/` unless marked `frontend/`.

Key to the layers:

- **DB** `tests/db/createBookingRequestMigration.test.js`,
  `tests/db/withdrawBookingRequestMigration.test.js`: the real migrations on
  PGlite (one connection, so no concurrency).
- **Route** `tests/routes/bookingRequests.test.js`: real Express routing and the
  real service over a fake client.
- **Service** `tests/services/bookingRequestService.test.js`,
  `tests/validation/bookingRequestValidation.test.js`,
  `tests/domain/bookingStatus.test.js`.
- **UI** under `frontend/tests/`: `components/BookingRequestPanel`,
  `components/VenueSearchRequest`, `components/CoordinatorRequestDetailVenueHandoff`,
  `components/MyBookingRequests`, `auth/myVenueRequestsRoute`,
  `services/bookingRequest*`.
- **Live** `scripts/check-booking-requests.js` (`npm run booking-requests:check`):
  the real database, real concurrent calls. Run by hand; needs migrations 027-031.

| # | Criterion | DB | Route / service | UI | Live |
|---|---|---|---|---|---|
| 1 | Only the assigned coordinator of an Approved or Confirmed event | not assigned, null caller, every other event status, no dates, handover moves the right (create and withdraw) | 401, 403 per role, 403 not assigned, 404 draft, 409 `EVENT_NOT_BOOKABLE` for each status | eligibility rules, disabled button with reason | handover race |
| 2 | Uses the event's period and requirements, chosen venue, optional notes, N10 result | period and requirements copied from the event, kept after the event is edited, attribution, notes cap, layout FK | body cannot set status, period, requester or suitability; validation (400s) | panel shows event and venue, sends only choices | status and period on the real column |
| 3 | Refused for a retired venue or an overlap; conflict shown | retired; blocks and approved bookings at both edges, one second inside, containing, contained; other venue; removed block; non-approved bookings | 409 `VENUE_RETIRED`, `BOOKING_PERIOD_CONFLICT` with the list | conflict list in the panel | request vs block race |
| 4 | Failed suitability warns and needs confirmation | gate after conflicts; recorded as overridden; missing result refused | `SUITABILITY_CONFIRMATION_REQUIRED` then confirmed; fails closed with 503; bad checker result 500 | warning, checkbox required, up front and after the server asks | n/a (N10 not built) |
| 5 | One Pending or Approved request per event; flagged counts (N24) | pending, approved, flagged named; a real SCRUM-17 override flags then blocks a request; cancelled flag frees it; rejected, withdrawn, cancelled do not count; per event | 409 `BOOKING_REQUEST_EXISTS`, `BOOKING_FLAGGED_FOR_REVIEW` with the booking id | buttons disabled after success or those answers | one winner across 3 venues and at one venue |
| 6 | New request is Pending, in Venue Staff's list, Venue Staff notified | status written by the function; pending is what the list reads | response is pending | "Pending" shown | |
| 7 | Coordinator can withdraw a Pending request; Venue Staff notified | pending to withdrawn, only status changes; notifications to every Venue Staff only; refused or failed withdrawal leaves nothing; failed notification rolls it back; non-pending refused; repeat refused | 200, 400, 401, 403, 404, 409 `BOOKING_NOT_PENDING`; repeat is 409 | confirm, one at a time, list refreshed, error refresh | two withdrawals; withdrawal vs status change; withdrawal vs handover |
| 8 | `bookings.status` default is pending | 028 default, existing rows kept, explicit statuses kept | | | insert with no status |
| - | Coordinator list (SCRUM-255) | pending list reads `status = 'pending'` | query narrowed to the token user; foreign rows dropped; labels for every status; roles | list, statuses, withdraw | embed filter and handover follow |

## Not proved, and why

- **Lock waiting.** PGlite is a single connection, and the live script reaches
  Postgres through PostgREST, which gives every call its own transaction. So
  nothing can hold a transaction open while another is seen waiting. The lock
  protocol is pinned from the function text (event `for update` before venue
  `for share`; booking `for update`; guarded update) and by races whose
  outcome must be explainable by a serial order. A direct-connection test would
  close this.
- **Request vs block order.** A pending request is not flagged by a block and
  does not stop one, so "request first, then block" and "block first, request
  refused" are both legal and the live race accepts both.
- **Withdrawal vs a Venue Staff transition.** Approve and reject (SCRUM-258) do
  not exist. The live race uses a guarded `UPDATE ... where status = 'pending'`
  as a stand-in for the contract 031 sets out. Replace it with the real
  transition when it lands.
- **Creation notification.** Not built (SCRUM-174), so nothing tests it. A
  rolled-back creation notifies nobody only because there is no notification.
- **Venue Staff pending list.** There is no endpoint; only the stored status is
  tested.
- **N10 suitability.** Not built; every suitability test uses a fake checker.
- **Live checks.** They have not been run against the project database, which
  did not have migrations 027-031 when this was written.
