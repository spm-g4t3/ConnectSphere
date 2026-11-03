// scrum585OrganiserControls.test.jsx
//
// The UI standard's button and status rules on the Event Organiser screens:
// every button is the shared Button, every status the shared StatusBadge, a
// back control is the link variant, and a My Events row offers at most one
// primary action. Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventOrganiserDashboard from "../../src/components/EventOrganiserDashboard.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import ChangeRequestForm from "../../src/components/ChangeRequestForm.jsx";
import ChangeRequestStatusList from "../../src/components/ChangeRequestStatusList.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import RegistrationEventsList from "../../src/components/RegistrationEventsList.jsx";
import EventRegistrationList from "../../src/components/EventRegistrationList.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
} from "../../src/services/eventRequestService";
import { getChangeRequests, submitChangeRequest } from "../../src/services/changeRequestService";
import { getEventRegistrations, getRegistrationSettings } from "../../src/services/eventRegistrationService";
import { httpError } from "../helpers/async.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getMyEventRequests: vi.fn(),
}));
vi.mock("../../src/services/changeRequestService", () => ({ getChangeRequests: vi.fn(), submitChangeRequest: vi.fn() }));
vi.mock("../../src/services/eventRegistrationService", () => ({
  getEventRegistrations: vi.fn(),
  getRegistrationSettings: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

// The per-screen classes these screens used before the shared components.
const OWN_CLASSES = [
  "status-badge",
  "my-event-requests__back",
  "my-event-requests__registration-link",
  "event-registration-page__back",
  "event-registration-page__configure",
  "dashboard--organiser__create-event",
  "dashboard--organiser__manage-event",
  "deadline-tag",
  "clarification-amendments__badge",
  "change-request-status-list__badge",
];

const display = (status, label, group) => ({ status, label, group, description: `${label}.` });
const eventRequest = (status, label, group, overrides = {}) => ({
  id: `e-${status}`, eventName: `${label} event`, purpose: "Networking", status,
  proposedStart: "2030-01-01T12:00:00.000Z", clarificationNote: null, decision: null,
  statusDisplay: display(status, label, group),
  ...overrides,
});
const draft = eventRequest("draft", "Draft", "DRAFT");
const rejected = eventRequest("rejected", "Rejected", "REJECTED");
const clarification = eventRequest("pending_clarification", "Needs reply", "ACTION_REQUIRED", { clarificationNote: "Which hall?" });
const approved = eventRequest("approved", "Approved", "APPROVED");
const confirmed = eventRequest("confirmed", "Confirmed", "CONFIRMED");
const settingsResponse = {
  eventName: "Industry Night", status: "approved", proposedStart: "2030-01-01T12:00:00.000Z",
  settings: { enabled: false, opensAt: null, closesAt: null, capacity: 80, withdrawalDeadline: null, registeredCount: 0 },
};

function expectSharedControls(container) {
  for (const button of container.querySelectorAll("button")) expect(button).toHaveClass("ui-button");
  for (const name of OWN_CLASSES) expect(container.querySelector(`.${name}`)).toBeNull();
  expect(container.querySelector('[class*="status--"], [class*="change-request-outcome"]')).toBeNull();
}
function expectBadge(scope, text, tone) {
  expect(within(scope).getByText(text)).toHaveClass("ui-status-badge", `ui-status-badge--${tone}`);
}
function expectControl(role, name, variant) {
  expect(screen.getByRole(role, { name })).toHaveClass("ui-button", `ui-button--${variant}`);
}
const rowOf = (eventName) => screen.getByText(eventName).closest("li");
// The dashboard lists an event needing a reply twice; this is its My events row.
const eventRowOf = (eventName) => screen.getAllByText(eventName)
  .map((el) => el.closest(".dashboard--organiser__event-row")).find(Boolean);

async function openPanel(requests, buttonName) {
  vi.mocked(getMyEventRequests).mockResolvedValue(requests);
  const view = render(<MyEventRequests />, { wrapper: MemoryRouter });
  await userEvent.click(await screen.findByRole("button", { name: buttonName }));
  return view;
}

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", name: "Ada", role: "event_organiser" } });
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockResolvedValue([]);
});

describe("SCRUM585 AC3 the Organiser's dashboard uses the shared Button and StatusBadge", () => {
  it("SCRUM585_AC3_dashboard_shows_statuses_as_status_badges_and_links_as_buttons", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarification, confirmed]);
    const { container } = render(<EventOrganiserDashboard user={{ name: "Ada" }} />, { wrapper: MemoryRouter });

    await screen.findByRole("link", { name: "Respond in My Events" });
    expectBadge(eventRowOf("Needs reply event"), "Needs reply", "danger");
    expectBadge(eventRowOf("Confirmed event"), "Confirmed", "accent");
    expectControl("link", "+ Create new event", "primary");
    expectControl("link", "Respond in My Events", "link");
    expectSharedControls(container);
  });
});

describe("SCRUM585 AC3 My Events uses the shared Button and StatusBadge", () => {
  it("SCRUM585_AC3_my_events_shows_statuses_as_status_badges_with_their_groups_tone", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([rejected, clarification, confirmed]);
    const { container } = render(<MyEventRequests />, { wrapper: MemoryRouter });

    await screen.findByText("Rejected event");
    expectBadge(rowOf("Rejected event"), "Rejected", "danger");
    expectBadge(rowOf("Needs reply event"), "Needs reply", "danger");
    expectBadge(rowOf("Confirmed event"), "Confirmed", "accent");
    expectControl("button", "+ New event request", "primary");
    expectSharedControls(container);
  });

  it.each([
    ["draft", draft, "Continue editing"],
    ["rejected", rejected, "Revise and resubmit"],
    ["pending_clarification", clarification, "Respond to clarification"],
  ])("SCRUM585_AC3_a_%s_row_makes_its_next_step_the_only_primary_action", async (_status, request, nextStep) => {
    vi.mocked(getMyEventRequests).mockResolvedValue([request]);
    render(<MyEventRequests />, { wrapper: MemoryRouter });

    await screen.findByText(request.eventName);
    const row = rowOf(request.eventName);
    const primaries = row.querySelectorAll(".my-event-requests__item-actions .ui-button--primary");
    expect([...primaries].map((el) => el.textContent)).toEqual([nextStep]);
  });

  it.each([
    ["approved", approved],
    ["confirmed", confirmed],
  ])("SCRUM585_AC3_a_%s_row_offers_request_a_change_as_a_secondary_action", async (_status, request) => {
    vi.mocked(getMyEventRequests).mockResolvedValue([request]);
    render(<MyEventRequests />, { wrapper: MemoryRouter });

    await screen.findByText(request.eventName);
    const row = rowOf(request.eventName);
    expect(within(row).getByRole("button", { name: "Request a change" })).toHaveClass("ui-button", "ui-button--secondary");
    expect(row.querySelectorAll(".my-event-requests__item-actions .ui-button--primary").length).toBeLessThanOrEqual(1);
    for (const link of within(row).getAllByRole("link")) expect(link).toHaveClass("ui-button", "ui-button--secondary");
  });

  it.each([
    ["+ New event request", []],
    ["Continue editing", [draft]],
    ["Respond to clarification", [clarification]],
    ["Request a change", [approved]],
  ])("SCRUM585_AC3_the_panel_opened_by_%s_has_a_link_variant_back_control", async (buttonName, requests) => {
    const { container } = await openPanel(requests, buttonName);

    expectControl("button", "← Back to my requests", "link");
    expectSharedControls(container);
  });

  it("SCRUM585_AC3_event_request_form_makes_submit_primary_and_save_draft_secondary", async () => {
    await openPanel([draft], "Continue editing");

    expectControl("button", "Submit request", "primary");
    expectControl("button", "Save draft", "secondary");
  });

  it("SCRUM585_AC3_clarification_reply_shows_its_amendment_state_as_a_status_badge_and_submits_with_a_primary_button", async () => {
    const { container } = await openPanel([clarification], "Respond to clarification");

    await screen.findByText("Reply only");
    expectBadge(container, "Reply only", "neutral");
    expectControl("button", "Send reply", "primary");
    expect(screen.getByRole("button", { name: "Send reply" })).toHaveAttribute("type", "submit");
  });
});

describe("SCRUM585 AC3 the change request screens use the shared Button and StatusBadge", () => {
  it("SCRUM585_AC3_change_request_form_keeps_submit_primary_and_the_row_controls_secondary", async () => {
    const user = userEvent.setup();
    vi.mocked(submitChangeRequest).mockResolvedValue([]);
    const { container } = render(<ChangeRequestForm eventRequestId="e1" onSubmitted={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add another change" }));
    expectControl("button", "Add another change", "secondary");
    for (const remove of screen.getAllByRole("button", { name: "Remove" })) {
      expect(remove).toHaveClass("ui-button", "ui-button--secondary");
      expect(remove).toHaveAttribute("type", "button");
    }
    expectControl("button", "Submit change request", "primary");
    expect(screen.getByRole("button", { name: "Submit change request" })).toHaveAttribute("type", "submit");
    expectSharedControls(container);

    for (const [i, group] of screen.getAllByRole("group", { name: /^Change \d/ }).entries()) {
      await user.selectOptions(within(group).getByLabelText("What needs to change?"), i ? "description" : "purpose");
      await user.type(within(group).getByRole("textbox"), "New text");
    }
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(await screen.findByRole("button", { name: "Request another change" })).toHaveClass("ui-button", "ui-button--secondary");
  });

  it.each([
    ["outstanding", "Outstanding", "warning"],
    ["in_progress", "In Progress", "info"],
    ["processed", "Processed", "neutral"],
    ["withdrawn", "withdrawn", "neutral"],
  ])("SCRUM585_AC3_change_request_status_%s_is_a_status_badge", async (status, label, tone) => {
    vi.mocked(getChangeRequests).mockResolvedValue([{
      id: "c1", changeField: "purpose", details: "New purpose", status, decision: null, createdAt: "2030-01-01T00:00:00.000Z",
    }]);
    const { container } = render(<ChangeRequestStatusList eventRequestId="e1" />);

    await screen.findByText("New purpose");
    expectBadge(container, label, tone);
    expectSharedControls(container);
  });
});

describe("SCRUM585 AC3 the registration screens use the shared Button", () => {
  it("SCRUM585_AC3_registration_settings_uses_a_link_variant_back_and_primary_configure_and_save", async () => {
    const user = userEvent.setup();
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    const { container } = render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: "Configure registration" });
    expectControl("link", "← Back to Registration", "link");
    expectControl("button", "Configure registration", "primary");
    expectSharedControls(container);

    await user.click(screen.getByRole("button", { name: "Configure registration" }));
    expectControl("button", "← Back to registration settings", "link");
    expectControl("button", "Save registration settings", "primary");
    expect(screen.getByRole("button", { name: "Save registration settings" })).toHaveAttribute("type", "submit");
    expectSharedControls(container);
  });

  it("SCRUM585_AC3_registration_settings_try_again_is_a_shared_button", async () => {
    vi.mocked(getRegistrationSettings).mockRejectedValue(httpError(500));
    const { container } = render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });

    await screen.findByRole("alert");
    expectControl("button", "Try again", "secondary");
    expectSharedControls(container);
  });

  it("SCRUM585_AC3_registration_events_list_links_each_event_as_a_secondary_button", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([approved]);
    const { container } = render(<RegistrationEventsList />, { wrapper: MemoryRouter });

    await screen.findByText("Approved event");
    expectControl("link", "Configure registration", "secondary");
    expectSharedControls(container);
  });

  it("SCRUM585_AC3_registration_list_back_is_the_link_variant", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue({
      event: { id: "e1", eventName: "Industry Night", status: "confirmed", capacity: 50 },
      counts: { registered: 0, waitlisted: 0, capacity: 50 }, hideWithdrawn: false, entries: [],
    });
    const { container } = render(<EventRegistrationList eventId="e1" />, { wrapper: MemoryRouter });

    await screen.findByText("No registrations to show.");
    expectControl("link", "← Back to My Events", "link");
    expectSharedControls(container);
  });
});
