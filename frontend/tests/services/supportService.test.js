// supportService.test.js
//
// SCRUM-287, for SCRUM-284. getOpenTickets is still a stub: no ticket endpoint
// exists. This pins what the dashboard relies on until the real one replaces it:
// an empty list, and a warning rather than a silent empty answer.

import { describe, it, expect, vi, afterEach } from "vitest";
import { getOpenTickets } from "../../src/services/supportService";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getOpenTickets", () => {
  it("SCRUM287_the_ticket_stub_returns_an_empty_list_and_says_it_is_not_implemented", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await getOpenTickets()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not implemented"));
  });
});
