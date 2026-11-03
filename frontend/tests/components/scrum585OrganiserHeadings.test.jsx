// scrum585OrganiserHeadings.test.jsx
//
// The UI standard's heading rule on the Event Organiser screens: one h1 per
// page as its title, and section headings at h2. Each panel of My Events
// replaces the list, so each is checked as its own page. Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventOrganiserDashboard from "../../src/components/EventOrganiserDashboard.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import EventRequestForm from "../../src/components/EventRequestForm.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import RegistrationEventsList from "../../src/components/RegistrationEventsList.jsx";
import EventRegistrationList from "../../src/components/EventRegistrationList.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  submitEventRequest,
  updateEventRequest,
} from "../../src/services/eventRequestService";
import { getChangeRequests } from "../../src/services/changeRequestService";
import { getEventRegistrations, getRegistrationSettings } from "../../src/services/eventRegistrationService";
import { httpError } from "../helpers/async.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getMyEventRequests: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));
vi.mock("../../src/services/changeRequestService", () => ({ getChangeRequests: vi.fn(), submitChangeRequest: vi.fn() }));
vi.mock("../../src/services/eventRegistrationService", () => ({
  getEventRegistrations: vi.fn(),
  getRegistrationSettings: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));
// The inbox's own headings are covered by scrum584SharedScreenHeadings.
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

const eventRequest = (overrides = {}) => ({
  id: "e1", eventName: "Industry Night", purpose: "Networking", status: "approved",
  proposedStart: "2030-01-01T12:00:00.000Z", clarificationNote: null, decision: null,
  statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "Approved." },
  ...overrides,
});
const clarificationRequest = eventRequest({
  status: "pending_clarification", clarificationNote: "Which hall?",
  statusDisplay: { status: "pending_clarification", label: "Needs reply", group: "ACTION_REQUIRED", description: "Reply." },
});
const draftRequest = eventRequest({
  status: "draft", statusDisplay: { status: "draft", label: "Draft", group: "DRAFT", description: "Draft." },
});
const previousRejection = {
  id: "d1", decision: "rejected", decisionNote: "Hall too small.", decidedAt: "2029-12-01T00:00:00.000Z", decidedByName: "Priya",
};
const settingsResponse = {
  eventName: "Industry Night", status: "approved", proposedStart: "2030-01-01T12:00:00.000Z",
  settings: { enabled: false, opensAt: null, closesAt: null, capacity: 80, withdrawalDeadline: null, registeredCount: 0 },
};

// One h1 named as given, and every other heading an h2 with exactly these names.
function expectHeadings(h1, h2s) {
  const headings = screen.getAllByRole("heading");
  expect(headings.filter(h => h.tagName === "H1").map(h => h.textContent)).toEqual([h1]);
  expect(headings.filter(h => h.tagName !== "H1").map(h => `${h.tagName} ${h.textContent}`))
    .toEqual(h2s.map(name => `H2 ${name}`));
}

async function openPanel(requests, buttonName) {
  vi.mocked(getMyEventRequests).mockResolvedValue(requests);
  render(<MyEventRequests />, { wrapper: MemoryRouter });
  await userEvent.click(await screen.findByRole("button", { name: buttonName }));
}

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", name: "Ada", role: "event_organiser" } });
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockResolvedValue([]);
});

describe("SCRUM585 AC2 one h1 per Event Organiser screen, sections at h2", () => {
  it("SCRUM585_AC2_dashboard_has_one_h1_and_puts_needs_your_response_before_my_events", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarificationRequest]);
    render(<EventOrganiserDashboard user={{ name: "Ada" }} />, { wrapper: MemoryRouter });

    await screen.findByRole("link", { name: "Respond in My Events" });
    expectHeadings("Welcome, Ada", ["Needs your response", "My events"]);
  });

  it("SCRUM585_AC2_my_events_list_has_one_h1", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([eventRequest()]);
    render(<MyEventRequests />, { wrapper: MemoryRouter });

    await screen.findByText("Industry Night");
    expectHeadings("My event requests", []);
  });

  it("SCRUM585_AC2_create_form_is_titled_by_its_h1_alone", async () => {
    await openPanel([], "+ New event request");

    expectHeadings("Create event request", []);
  });

  it("SCRUM585_AC2_edit_draft_form_is_titled_by_its_h1_alone", async () => {
    await openPanel([draftRequest], "Continue editing");

    expect(getEventDecisionHistory).toHaveBeenCalled();
    expectHeadings("Edit draft request", []);
  });

  it("SCRUM585_AC2_revising_a_rejected_draft_puts_previous_decisions_at_h2_under_the_forms_h1", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([previousRejection]);
    await openPanel([draftRequest], "Continue editing");

    await screen.findByRole("heading", { name: "Previous decisions" });
    expectHeadings("Edit draft request", ["Previous decisions"]);
  });

  it("SCRUM585_AC2_a_rejected_row_in_my_events_puts_previous_decisions_at_h2", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([previousRejection]);
    vi.mocked(getMyEventRequests).mockResolvedValue([eventRequest({
      status: "rejected", decision: "rejected", decisionNote: "Hall too small.",
      statusDisplay: { status: "rejected", label: "Rejected", group: "REJECTED", description: "Rejected." },
    })]);
    render(<MyEventRequests />, { wrapper: MemoryRouter });

    expect(await screen.findByRole("heading", { name: "Previous decisions" })).toHaveProperty("tagName", "H2");
    expectHeadings("My event requests", ["Previous decisions"]);
  });

  it("SCRUM585_AC2_request_submitted_confirmation_has_one_h1", async () => {
    vi.mocked(updateEventRequest).mockResolvedValue(draftRequest);
    vi.mocked(submitEventRequest).mockResolvedValue(eventRequest({ status: "submitted" }));
    render(<EventRequestForm existingRequest={draftRequest} />);

    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByText("e1")).toBeInTheDocument();
    expectHeadings("Request submitted", []);
  });

  it("SCRUM585_AC2_request_a_change_panel_has_one_h1_naming_the_event_and_its_history_at_h2", async () => {
    vi.mocked(getChangeRequests).mockResolvedValue([
      { id: "c1", groupId: "g1", changeField: "purpose", details: "New purpose", status: "pending", createdAt: "2030-01-01T00:00:00.000Z" },
    ]);
    await openPanel([eventRequest()], "Request a change");

    expect(await screen.findByText("New purpose")).toBeInTheDocument();
    expectHeadings("Request a change", ["Change request history"]);
    expect(screen.getByText("Industry Night")).toBeInTheDocument();
  });

  it("SCRUM585_AC2_reply_to_clarification_panel_has_one_h1_and_event_amendments_at_h2", async () => {
    await openPanel([clarificationRequest], "Respond to clarification");

    await screen.findByText("Reply only");
    expectHeadings("Reply to the Coordinator", ["Event amendments"]);
  });

  it("SCRUM585_AC2_registration_settings_has_one_h1_and_its_summary_at_h2", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: "Configure registration" });
    expectHeadings("Industry Night", ["Current registration"]);
  });

  it("SCRUM585_AC2_registration_settings_keeps_its_h1_while_loading_and_on_a_load_error", async () => {
    vi.mocked(getRegistrationSettings).mockRejectedValue(httpError(500));
    render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });

    expectHeadings("Registration settings", []);
    await screen.findByRole("alert");
    expectHeadings("Registration settings", []);
  });

  it("SCRUM585_AC2_registration_events_list_has_one_h1", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([eventRequest()]);
    render(<RegistrationEventsList />, { wrapper: MemoryRouter });

    await screen.findByText("Industry Night");
    expectHeadings("Event registration", []);
  });

  it("SCRUM585_AC2_registration_list_has_one_h1_and_its_counts_at_h2", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue({
      event: { id: "e1", eventName: "Industry Night", status: "confirmed", capacity: 50 },
      counts: { registered: 0, waitlisted: 0, capacity: 50 }, hideWithdrawn: false, entries: [],
    });
    render(<EventRegistrationList eventId="e1" />, { wrapper: MemoryRouter });

    await screen.findByText("No registrations to show.");
    expectHeadings("Industry Night", ["Registered", "Waitlisted"]);
  });

  it("SCRUM585_AC2_registration_list_keeps_its_h1_while_loading_and_on_a_load_error", async () => {
    vi.mocked(getEventRegistrations).mockRejectedValue(httpError(500));
    render(<EventRegistrationList eventId="e1" />, { wrapper: MemoryRouter });

    expectHeadings("Registrations", []);
    await screen.findByRole("alert");
    expectHeadings("Registrations", []);
  });
});
