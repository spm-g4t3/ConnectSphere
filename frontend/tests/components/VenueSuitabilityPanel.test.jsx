// VenueSuitabilityPanel.test.jsx
//
// SCRUM-191 (SCRUM-188 AC1/AC2). The panel that runs one suitability check:
// loading, then the result; a failure with "Check again"; and "Request this
// venue", which hands the result to the parent. venueSuitabilityService is
// mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueSuitabilityPanel from "../../src/components/VenueSuitabilityPanel.jsx";
import { checkVenueSuitability } from "../../src/services/venueSuitabilityService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
}));

const EVENT = { id: "e1", eventName: "Tech Talk" };
const VENUE = { id: "v1", name: "Hall A" };
const REQUIREMENTS = { layout: "theatre", accessibility: ["hearing_loop"], facilities: ["wifi"] };

const RESULT = {
  suitable: false,
  criteria: [
    { criterion: "Capacity", met: false, detail: "Capacity 80 < expected attendance 150" },
    { criterion: "Operating hours", met: true, detail: "Open" },
    { criterion: "Layout", met: true, detail: "Offered" },
    { criterion: "Accessibility", met: true, detail: "Provided" },
    { criterion: "Facilities", met: true, detail: "Provided" },
    { criterion: "Availability", met: true, detail: "Free" },
  ],
  checked: {
    startsAt: "2026-11-11T10:00:00+08:00",
    endsAt: "2026-11-11T12:00:00+08:00",
    expectedAttendance: 150,
    layout: "theatre",
    accessibility: ["hearing_loop"],
    facilities: ["wifi"],
  },
};

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

function renderPanel(props = {}) {
  const callbacks = { onRequest: vi.fn(), onClose: vi.fn() };
  const user = userEvent.setup();
  const utils = render(
    <VenueSuitabilityPanel
      event={EVENT}
      venue={VENUE}
      requirements={REQUIREMENTS}
      canRequest
      {...callbacks}
      {...props}
    />,
  );
  return { user, ...callbacks, ...utils };
}

const requestButton = () => screen.queryByRole("button", { name: "Request this venue" });

beforeEach(() => {
  vi.mocked(checkVenueSuitability).mockReset();
});

describe("SCRUM-191 checking a venue (SCRUM188_AC1)", () => {
  it("SCRUM188_AC1_is_a_section_named_for_the_venue", () => {
    vi.mocked(checkVenueSuitability).mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole("region", { name: "Suitability of Hall A" })).toBeInTheDocument();
  });

  it("SCRUM188_AC1_checks_on_mount_with_the_event_venue_and_requirements", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(RESULT);
    renderPanel();

    await screen.findByText("Not suitable");
    expect(checkVenueSuitability).toHaveBeenCalledTimes(1);
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", REQUIREMENTS);
  });

  it("SCRUM188_AC2_shows_loading_then_the_result", async () => {
    const pending = deferred();
    vi.mocked(checkVenueSuitability).mockReturnValue(pending.promise);
    renderPanel();

    expect(screen.getByRole("status")).toHaveTextContent("Checking Hall A against this event...");
    expect(requestButton()).not.toBeInTheDocument();

    pending.resolve(RESULT);

    expect(await screen.findByText("Not suitable")).toBeInTheDocument();
    expect(screen.queryByText(/Checking Hall A/)).not.toBeInTheDocument();
    expect(screen.getByText("Capacity 80 < expected attendance 150")).toBeInTheDocument();
  });
});

describe("SCRUM-191 a failed check", () => {
  it("SCRUM188_AC1_shows_the_error_as_an_alert_without_the_servers_text", async () => {
    vi.mocked(checkVenueSuitability).mockRejectedValue(
      httpError(409, { error: "prose with a uuid", code: "VENUE_RETIRED" }),
    );
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/retired/);
    expect(alert).not.toHaveTextContent(/prose/);
    expect(requestButton()).not.toBeInTheDocument();
  });

  it("SCRUM188_AC1_check_again_runs_the_same_check_once_more", async () => {
    vi.mocked(checkVenueSuitability)
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce(RESULT);
    const { user } = renderPanel();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Not suitable")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(checkVenueSuitability).toHaveBeenCalledTimes(2);
    expect(vi.mocked(checkVenueSuitability).mock.calls[1]).toEqual(["e1", "v1", REQUIREMENTS]);
  });
});

describe("SCRUM-191 carrying the result into a request", () => {
  it("SCRUM191_request_this_venue_hands_the_venue_and_result_to_the_parent", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(RESULT);
    const { user, onRequest } = renderPanel();

    await screen.findByText("Not suitable");
    expect(requestButton()).toHaveAttribute("type", "button");
    await user.click(requestButton());

    expect(onRequest).toHaveBeenCalledWith(VENUE, RESULT);
  });

  it("SCRUM191_request_this_venue_is_hidden_when_a_request_cannot_be_made", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(RESULT);
    renderPanel({ canRequest: false });

    await screen.findByText("Not suitable");
    expect(requestButton()).not.toBeInTheDocument();
  });

  it("SCRUM191_close_calls_onClose", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(RESULT);
    const { user, onClose } = renderPanel();

    await screen.findByText("Not suitable");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

// SCRUM-188 review fix F3 (AC4/AC7): a venue whose period is taken is not
// offered for a request at all.
describe("SCRUM-188 an unavailable venue cannot be requested", () => {
  const UNAVAILABLE = {
    ...RESULT,
    criteria: RESULT.criteria.map((c) =>
      c.criterion === "Availability"
        ? { ...c, met: false, detail: "Needs 13:45–16:45 on Wed 11 Nov (setup 13:45–14:00, turnaround 16:00–16:45). Blocked 15:00–18:00 for maintenance" }
        : c,
    ),
  };
  const UNAVAILABLE_TEXT = "This venue is not available for this event's period, so it can't be requested.";

  it("SCRUM188_AC7_unmet_availability_offers_no_request_and_says_why", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(UNAVAILABLE);
    renderPanel();

    await screen.findByText("Not suitable");
    expect(requestButton()).not.toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    // AC4: the server's detail, own occupied period first, is shown verbatim.
    expect(screen.getByText(/^Needs 13:45–16:45 on Wed 11 Nov \(setup 13:45–14:00, turnaround 16:00–16:45\)\. Blocked/)).toBeInTheDocument();
  });

  it("SCRUM188_AC7_other_unmet_criteria_can_still_be_requested", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(RESULT);
    renderPanel();

    await screen.findByText("Not suitable");
    expect(requestButton()).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE_TEXT)).not.toBeInTheDocument();
  });

  it("SCRUM188_AC7_when_no_request_can_be_made_the_unavailable_note_is_not_shown_either", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(UNAVAILABLE);
    renderPanel({ canRequest: false });

    await screen.findByText("Not suitable");
    expect(screen.queryByText(UNAVAILABLE_TEXT)).not.toBeInTheDocument();
  });
});

// SCRUM-188 review fix F7 (AC3): the check uses the saved event, not the form.
describe("SCRUM-188 what the check is against", () => {
  it("SCRUM188_AC3_says_it_checks_the_events_saved_date_time_and_attendance", () => {
    vi.mocked(checkVenueSuitability).mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(
      screen.getByText(/Checked against this event's saved date, time and expected attendance, not the search form's/),
    ).toBeInTheDocument();
  });
});

// SCRUM-188 review fix F8 (AC1): focus and the live status.
describe("SCRUM-188 the panel announces itself", () => {
  it("SCRUM188_AC1_focus_moves_to_the_heading_when_the_panel_opens", () => {
    vi.mocked(checkVenueSuitability).mockReturnValue(new Promise(() => {}));
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderPanel();
      const heading = screen.getByRole("heading", { name: "Suitability of Hall A" });
      expect(heading).toHaveAttribute("tabindex", "-1");
      expect(heading).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("SCRUM188_AC1_the_live_status_names_the_venue_while_checking_and_when_answered", async () => {
    const pending = deferred();
    vi.mocked(checkVenueSuitability).mockReturnValue(pending.promise);
    renderPanel();

    expect(screen.getByRole("status")).toHaveTextContent("Checking Hall A");
    pending.resolve(RESULT);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/^Hall A: Not suitable$/));
  });
});
