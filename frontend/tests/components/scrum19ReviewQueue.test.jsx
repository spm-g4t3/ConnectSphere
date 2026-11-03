// scrum19ReviewQueue.test.jsx
//
// The review queue's detail panel: opened from a row or from router state,
// and kept in step with the queue after the Coordinator acts on a request.
// The detail panel is stubbed with buttons standing in for its actions, so
// these cases test only how the queue reacts; the service is mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import ReviewQueue from "../../src/components/ReviewQueue.jsx";
import { getEventRequestQueue } from "../../src/services/eventRequestService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/components/CoordinatorRequestDetail", () => ({
  default: ({ request, onReviewDecisionProcessed, onChangeRequestProcessed }) => (
    <div>
      <h2>Detail of {request.eventName}</h2>
      <p>Status: {request.status}</p>
      <button type="button" onClick={onReviewDecisionProcessed}>Stub: decide</button>
      <button type="button" onClick={onChangeRequestProcessed}>Stub: start review</button>
    </div>
  ),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestQueue: vi.fn(),
}));

const SUBMITTED = { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "x" };
const UNDER_REVIEW = { status: "under_review", label: "Under review", group: "UNDER_REVIEW", description: "x" };

const NIGHT = { id: "q1", eventName: "IS212 Industry Night", status: "submitted", statusDisplay: SUBMITTED };
const FRESHERS = { id: "q2", eventName: "Freshers Welcome", status: "submitted", statusDisplay: SUBMITTED };

function renderQueue(state) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[{ pathname: "/review-queue", state }]}>
      <ReviewQueue asPage />
    </MemoryRouter>,
  );
  return { user };
}

async function openNight(user) {
  await user.click((await screen.findAllByRole("button", { name: "Review" }))[0]);
  expect(screen.getByRole("heading", { name: "Detail of IS212 Industry Night" })).toBeInTheDocument();
}

beforeEach(() => {
  vi.mocked(getEventRequestQueue).mockReset();
  vi.mocked(getEventRequestQueue).mockResolvedValue([NIGHT, FRESHERS]);
});

describe("SCRUM-20: back from the venue search to the request being reviewed", () => {
  it("SCRUM20_arriving_with_a_request_in_router_state_opens_its_detail", async () => {
    renderQueue({ request: FRESHERS });

    expect(screen.getByRole("heading", { name: "Detail of Freshers Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Review queue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });
});

describe("SCRUM-19 AC1: the queue after a Coordinator acts on a request", () => {
  it("SCRUM19_AC1_a_decision_closes_the_detail_and_reads_the_queue_again", async () => {
    const { user } = renderQueue();
    await openNight(user);
    vi.mocked(getEventRequestQueue).mockResolvedValue([FRESHERS]);

    await user.click(screen.getByRole("button", { name: "Stub: decide" }));

    expect(await screen.findByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
    expect(getEventRequestQueue).toHaveBeenCalledTimes(2);
  });

  it("SCRUM19_AC1_starting_the_review_keeps_the_detail_open_on_the_refreshed_request", async () => {
    const { user } = renderQueue();
    await openNight(user);
    expect(screen.getByText("Status: submitted")).toBeInTheDocument();
    vi.mocked(getEventRequestQueue).mockResolvedValue([
      { ...NIGHT, status: "under_review", statusDisplay: UNDER_REVIEW },
      FRESHERS,
    ]);

    await user.click(screen.getByRole("button", { name: "Stub: start review" }));

    expect(await screen.findByText("Status: under_review")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Detail of IS212 Industry Night" })).toBeInTheDocument();
    expect(getEventRequestQueue).toHaveBeenCalledTimes(2);
  });

  it("SCRUM19_AC1_a_request_gone_from_the_refreshed_queue_leaves_the_detail_as_it_was", async () => {
    const { user } = renderQueue();
    await openNight(user);
    vi.mocked(getEventRequestQueue).mockResolvedValue([FRESHERS]);

    await user.click(screen.getByRole("button", { name: "Stub: start review" }));

    await waitFor(() => expect(getEventRequestQueue).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Detail of IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getByText("Status: submitted")).toBeInTheDocument();
  });

  it("SCRUM19_AC1_going_back_while_the_queue_refreshes_is_not_undone", async () => {
    const { user } = renderQueue();
    await openNight(user);
    const refresh = deferred();
    vi.mocked(getEventRequestQueue).mockReturnValue(refresh.promise);

    await user.click(screen.getByRole("button", { name: "Stub: start review" }));
    await user.click(screen.getByRole("button", { name: /Back to the review queue/ }));
    refresh.resolve([{ ...NIGHT, status: "under_review", statusDisplay: UNDER_REVIEW }]);

    expect(await screen.findByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Detail of IS212 Industry Night" })).not.toBeInTheDocument();
  });
});
