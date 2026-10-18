// scrum492BookingRequestService.test.js
//
// SCRUM-492 (SCRUM-567): the release call and what each refusal says, keyed on
// the HTTP status and the 409's code, never the server's text. apiClient is
// mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { releaseVenueBooking } from "../../src/services/bookingRequestService.js";
import { releaseErrorMessage } from "../../src/services/bookingRequestErrors.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const http = (status, data = {}) => ({ response: { status, data } });

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM492 releaseVenueBooking", () => {
  it("SCRUM492_AC2_releasing_posts_the_reason_to_the_bookings_release_route", async () => {
    const answer = { booking: { id: BOOKING_ID, status: "released" }, returnedToPending: [] };
    vi.mocked(apiClient.post).mockResolvedValue({ data: answer });

    await expect(releaseVenueBooking(BOOKING_ID, "Moved to Hall B")).resolves.toEqual(answer);

    expect(vi.mocked(apiClient.post).mock.calls).toEqual([
      [`/booking-requests/${BOOKING_ID}/release`, { reason: "Moved to Hall B" }],
    ]);
  });

  it("SCRUM492_AC1_a_refusal_reaches_the_caller_unchanged", async () => {
    const refusal = Object.assign(new Error("HTTP 409"), http(409, { code: "BOOKING_NOT_APPROVED" }));
    vi.mocked(apiClient.post).mockRejectedValue(refusal);

    await expect(releaseVenueBooking(BOOKING_ID, "Moved")).rejects.toBe(refusal);
  });
});

describe("SCRUM492 releaseErrorMessage", () => {
  it.each([
    ["a_400", http(400, { error: "server words" }), "Give a reason of up to 1,000 characters."],
    ["a_401", http(401), "Your session has expired. Please sign in again."],
    ["a_403", http(403), "Only the coordinator assigned to this event can release its venues."],
    ["a_404", http(404), "This booking no longer exists."],
    ["a_409_EVENT_NOT_APPROVED", http(409, { code: "EVENT_NOT_APPROVED" }), "Venues can be released only while the event is Approved."],
    ["a_409_BOOKING_NOT_APPROVED", http(409, { code: "BOOKING_NOT_APPROVED" }), "This booking is no longer approved. The list has been refreshed."],
    ["a_409_BOOKING_CHANGED", http(409, { code: "BOOKING_CHANGED" }), "This booking changed while you were releasing it. The list has been refreshed."],
    ["a_409_with_another_code", http(409, { code: "SOMETHING_ELSE" }), "The venue could not be released. Please try again."],
    ["a_409_with_no_code", http(409), "The venue could not be released. Please try again."],
    ["a_400_carrying_a_409s_code", http(400, { code: "BOOKING_CHANGED" }), "Give a reason of up to 1,000 characters."],
    ["a_500", http(500), "The venue could not be released. Please try again."],
    ["no_response", new Error("Network Error"), "The venue could not be released. Please try again."],
    ["nothing", undefined, "The venue could not be released. Please try again."],
  ])("SCRUM492_AC1_%s_reads_in_the_coordinators_words", (_label, err, message) => {
    expect(releaseErrorMessage(err)).toBe(message);
  });
});
