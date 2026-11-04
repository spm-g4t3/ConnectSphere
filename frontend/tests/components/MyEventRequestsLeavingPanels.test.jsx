// MyEventRequestsLeavingPanels.test.jsx
//
// The Organiser leaves a panel with Back while its save is still in flight.
// When the save lands the list refreshes, and the panel is not reopened.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  createEventRequest,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  submitEventRequest,
  updateEventRequest,
} from "../../src/services/eventRequestService";
import { getChangeRequests, submitChangeRequest } from "../../src/services/changeRequestService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  createEventRequest: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getMyEventRequests: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));
vi.mock("../../src/services/changeRequestService", () => ({ getChangeRequests: vi.fn(), submitChangeRequest: vi.fn() }));

const approved = {
  id: "e-approved", eventName: "Industry Night", purpose: "Networking", status: "approved",
  proposedStart: "2030-01-01T12:00:00.000Z", clarificationNote: null, decision: null,
  statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "Approved." },
};

function renderList(state) {
  vi.mocked(getMyEventRequests).mockResolvedValue([approved]);
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/events", state }]}>
      <MyEventRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", name: "Ada", role: "event_organiser" } });
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockResolvedValue([]);
});

describe("leaving a panel before its save lands", () => {
  it("SCRUM10_AC7_a_submission_that_lands_after_back_refreshes_the_list_and_does_not_reopen_the_form", async () => {
    const user = userEvent.setup();
    const saved = { ...approved, id: "e-new", eventName: "Alumni Talk", status: "draft" };
    vi.mocked(createEventRequest).mockResolvedValue(saved);
    vi.mocked(updateEventRequest).mockResolvedValue(saved);
    const submission = deferred();
    vi.mocked(submitEventRequest).mockReturnValue(submission.promise);
    renderList({ openNewEventRequest: true });

    await user.type(screen.getByLabelText("Event name"), "Alumni Talk");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(await screen.findByRole("button", { name: "Submit request" }));
    await user.click(screen.getByRole("button", { name: /Back to my requests/ }));
    const readsBefore = vi.mocked(getMyEventRequests).mock.calls.length;

    await act(async () => submission.resolve({ ...saved, status: "submitted" }));

    expect(vi.mocked(getMyEventRequests).mock.calls.length).toBe(readsBefore + 1);
    expect(screen.queryByText("Request submitted")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create event request" })).not.toBeInTheDocument();
    expect(await screen.findByText("Industry Night")).toBeInTheDocument();
  });

  it("SCRUM402_AC1_a_change_request_that_lands_after_back_refreshes_the_list_and_does_not_reopen_the_form", async () => {
    const user = userEvent.setup();
    const sending = deferred();
    vi.mocked(submitChangeRequest).mockReturnValue(sending.promise);
    renderList();

    const row = (await screen.findByText("Industry Night")).closest("li");
    await user.click(within(row).getByRole("button", { name: "Request a change" }));
    const group = screen.getByRole("group", { name: /^Change 1/ });
    await user.selectOptions(within(group).getByLabelText("What needs to change?"), "purpose");
    await user.type(within(group).getByRole("textbox"), "Alumni networking");
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    await user.click(screen.getByRole("button", { name: /Back to my requests/ }));
    const readsBefore = vi.mocked(getMyEventRequests).mock.calls.length;

    await act(async () => sending.resolve([]));

    expect(vi.mocked(getMyEventRequests).mock.calls.length).toBe(readsBefore + 1);
    expect(screen.queryByRole("heading", { name: "Request a change" })).not.toBeInTheDocument();
    expect(await screen.findByText("Industry Night")).toBeInTheDocument();
  });
});
