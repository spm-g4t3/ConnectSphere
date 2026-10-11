// openEventService.test.js
//
// SCRUM-495. The one call the browse page makes. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { getOpenEvents, getOpenEvent } from "../../src/services/openEventService.js";
import { BROWSE_OPEN_EVENTS_PATH, openEventDetailsPath } from "../../src/services/openEventRoutes.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe("getOpenEvents", () => {
  it("SCRUM495_gets_/open-events_with_no_parameters_and_returns_the_body", async () => {
    const rows = [{ id: "e1", eventName: "Open Day" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(getOpenEvents()).resolves.toBe(rows);

    // No attendee id, no filter: the backend takes the caller from the token.
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/open-events");
  });

  it("SCRUM495_lets_a_failure_through_for_the_page_to_read", async () => {
    const failure = Object.assign(new Error("403"), { response: { status: 403 } });
    vi.mocked(apiClient.get).mockRejectedValue(failure);

    await expect(getOpenEvents()).rejects.toBe(failure);
  });
});

describe("open event routes", () => {
  it("SCRUM495_keeps_the_browse_page_and_its_details_under_one_path", () => {
    expect(BROWSE_OPEN_EVENTS_PATH).toBe("/open-events");
    expect(openEventDetailsPath("abc")).toBe("/open-events/abc");
  });
});

describe("getOpenEvent", () => {
  it("SCRUM495_gets_/open-events/:id_and_returns_the_body", async () => {
    const event = { id: "e1", eventName: "Open Day" };
    vi.mocked(apiClient.get).mockResolvedValue({ data: event });

    await expect(getOpenEvent("e1")).resolves.toBe(event);

    expect(apiClient.get).toHaveBeenCalledWith("/open-events/e1");
  });

  it("SCRUM495_encodes_the_id_so_it_cannot_change_the_path", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });

    await getOpenEvent("a/b?c");

    expect(apiClient.get).toHaveBeenCalledWith("/open-events/a%2Fb%3Fc");
  });

  it("SCRUM495_lets_a_404_through_for_the_page_to_read", async () => {
    const failure = Object.assign(new Error("404"), { response: { status: 404 } });
    vi.mocked(apiClient.get).mockRejectedValue(failure);

    await expect(getOpenEvent("e1")).rejects.toBe(failure);
  });
});
