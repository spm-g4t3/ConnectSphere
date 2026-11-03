// scrum585OrganiserKeyboard.test.jsx
//
// The Event Organiser screens by keyboard alone: every control is reached by
// Tab, opening a panel puts focus on its title and Back returns it to the
// control that opened it, and a confirmation that replaces a form takes focus.
// Also a submitted change request keeps its confirmation on screen. Services
// are mocked. jsdom does not lay pages out, so the 360px rules are read from
// App.css as text.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EventOrganiserDashboard from "../../src/components/EventOrganiserDashboard.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import EventRegistrationList from "../../src/components/EventRegistrationList.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  respondToEventClarification,
  submitEventRequest,
  updateEventRequest,
} from "../../src/services/eventRequestService";
import { getChangeRequests, submitChangeRequest } from "../../src/services/changeRequestService";
import {
  getEventRegistrations,
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  createEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getConfirmedArrangements: vi.fn(),
  getEventChangeHistory: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getMyEventRequests: vi.fn(),
  reopenEventRequest: vi.fn(),
  respondToEventClarification: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));
vi.mock("../../src/services/changeRequestService", () => ({ getChangeRequests: vi.fn(), submitChangeRequest: vi.fn() }));
vi.mock("../../src/services/eventRegistrationService", () => ({
  getEventRegistrations: vi.fn(),
  getRegistrationSettings: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

const NINE_AM = "2026-01-15T01:00:00Z";
const eventRequest = (id, status, label, overrides = {}) => ({
  id, eventName: `${label} event`, purpose: "Networking", status, proposedStart: NINE_AM,
  clarificationNote: null, decision: null,
  statusDisplay: { status, label, group: "OTHER", description: `${label}.` },
  ...overrides,
});
const draft = eventRequest("e-draft", "draft", "Draft");
const clarification = eventRequest("e-clar", "pending_clarification", "Needs reply", {
  clarificationNote: "Which hall?", clarificationReplyByDate: "2026-01-14",
});
const approved = eventRequest("e-appr", "approved", "Approved");
const settingsResponse = {
  eventName: "Industry Night", status: "approved", proposedStart: NINE_AM,
  settings: {
    enabled: true, opensAt: NINE_AM, closesAt: null, capacity: 80, withdrawalDeadline: null,
    registeredCount: 0, waitlistEnabled: false, waitlistCount: 0,
  },
};

const CONTROLS = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary";

/** Tab from the top of the page until focus comes round again; the elements reached, in order. */
async function tabThrough() {
  document.activeElement?.blur();
  const reached = [];
  for (let i = 0; i < 200; i += 1) {
    await userEvent.tab();
    const active = document.activeElement;
    if (active === document.body || reached.includes(active)) break;
    reached.push(active);
  }
  return reached;
}

async function expectEveryControlReachedByTab(container) {
  const reached = await tabThrough();
  expect(reached).toEqual([...container.querySelectorAll(CONTROLS)]);
}

/** Tab until the named control has focus, then press Enter on it. */
async function enterOn(role, name) {
  const target = await screen.findByRole(role, { name });
  for (let i = 0; i < 100 && document.activeElement !== target; i += 1) await userEvent.tab();
  expect(target).toHaveFocus();
  await userEvent.keyboard("{Enter}");
}

const renderMyEvents = (requests) => {
  vi.mocked(getMyEventRequests).mockResolvedValue(requests);
  return render(<MyEventRequests />, { wrapper: MemoryRouter });
};

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", name: "Ada", role: "event_organiser" } });
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getAssignmentHistory).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockResolvedValue([]);
});

describe("SCRUM585 AC5 every control is reached by Tab", () => {
  it("SCRUM585_AC5_tab_reaches_every_control_on_the_dashboard", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarification, approved]);
    const { container } = render(<EventOrganiserDashboard user={{ id: "u1", name: "Ada" }} />, { wrapper: MemoryRouter });
    await screen.findByRole("link", { name: "Respond in My Events" });

    await expectEveryControlReachedByTab(container);
  });

  it("SCRUM585_AC5_tab_reaches_every_control_on_my_events", async () => {
    const { container } = renderMyEvents([draft, clarification, approved]);
    await screen.findByRole("button", { name: "Continue editing" });

    await expectEveryControlReachedByTab(container);
  });

  it("SCRUM585_AC5_tab_reaches_every_control_on_the_registration_settings_form", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    const { container } = render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });
    await userEvent.click(await screen.findByRole("button", { name: "Configure registration" }));

    await expectEveryControlReachedByTab(container);
  });
});

describe("SCRUM585 AC5 focus moves to an opened panel and back to its opener", () => {
  it("SCRUM585_AC5_new_event_request_by_keyboard_focuses_its_title_and_back_returns_to_the_button", async () => {
    renderMyEvents([]);
    await enterOn("button", "+ New event request");

    expect(screen.getByRole("heading", { level: 1, name: "Create event request" })).toHaveFocus();

    await enterOn("button", "← Back to my requests");
    expect(await screen.findByRole("button", { name: "+ New event request" })).toHaveFocus();
  });

  it.each([
    ["Continue editing", "Edit draft request"],
    ["Respond to clarification", "Reply to the Coordinator"],
    ["Request a change", "Request a change"],
  ])("SCRUM585_AC5_%s_by_keyboard_focuses_the_panel_title_and_back_returns_to_that_button", async (opener, title) => {
    renderMyEvents([draft, clarification, approved]);
    await enterOn("button", opener);

    expect(await screen.findByRole("heading", { level: 1, name: title })).toHaveFocus();

    await enterOn("button", "← Back to my requests");
    const button = await screen.findByRole("button", { name: opener });
    await vi.waitFor(() => expect(button).toHaveFocus());
  });

  it("SCRUM585_AC5_back_after_the_opener_has_gone_focuses_the_list_title", async () => {
    vi.mocked(respondToEventClarification).mockResolvedValue({});
    renderMyEvents([clarification]);
    await enterOn("button", "Respond to clarification");
    await userEvent.keyboard("{Tab}");
    await userEvent.type(screen.getByRole("textbox", { name: "Your reply" }), "The main hall.");

    // Answered, the row is waiting for its coordinator and has no Respond button.
    vi.mocked(getMyEventRequests).mockResolvedValue([{ ...clarification, status: "under_review" }]);
    await enterOn("button", "Send reply");

    const title = await screen.findByRole("heading", { level: 1, name: "My event requests" });
    await vi.waitFor(() => expect(title).toHaveFocus());
  });

  it("SCRUM585_AC5_respond_in_my_events_on_the_dashboard_focuses_the_reply_panel_title", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarification]);
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<EventOrganiserDashboard user={{ id: "u1", name: "Ada" }} />} />
          <Route path="/events" element={<MyEventRequests />} />
        </Routes>
      </MemoryRouter>,
    );

    await enterOn("link", "Respond in My Events");

    const title = await screen.findByRole("heading", { level: 1, name: "Reply to the Coordinator" });
    await vi.waitFor(() => expect(title).toHaveFocus());
  });
});

describe("SCRUM585 AC5 a confirmation that replaces a form takes focus", () => {
  it("SCRUM585_AC5_submitting_a_request_by_keyboard_focuses_request_submitted", async () => {
    vi.mocked(updateEventRequest).mockResolvedValue({ ...draft });
    vi.mocked(submitEventRequest).mockResolvedValue({ ...draft, status: "submitted" });
    renderMyEvents([draft]);
    await enterOn("button", "Continue editing");

    await enterOn("button", "Submit request");

    expect(await screen.findByRole("heading", { level: 1, name: "Request submitted" })).toHaveFocus();
  });

  it("SCRUM585_AC5_submitting_a_change_request_focuses_its_confirmation_and_another_change_focuses_the_first_choice", async () => {
    vi.mocked(submitChangeRequest).mockResolvedValue({});
    renderMyEvents([approved]);
    await enterOn("button", "Request a change");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "What needs to change?" }), "purpose");
    await userEvent.type(screen.getByRole("textbox", { name: "Describe the change" }), "Alumni night");

    await enterOn("button", "Submit change request");

    const confirmation = await screen.findByText("Your change request has been submitted.");
    expect(confirmation.parentElement).toHaveFocus();

    await enterOn("button", "Request another change");
    expect(screen.getByRole("combobox", { name: "What needs to change?" })).toHaveFocus();
  });

  it("SCRUM585_AC5_configure_registration_focuses_the_form_title_and_back_or_save_returns_to_configure", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    vi.mocked(saveRegistrationSettings).mockResolvedValue(settingsResponse.settings);
    render(<EventRegistrationSettings eventId="e1" />, { wrapper: MemoryRouter });

    await enterOn("button", "Configure registration");
    expect(screen.getByRole("heading", { level: 2, name: "Configure registration" })).toHaveFocus();

    await enterOn("button", "← Back to registration settings");
    expect(screen.getByRole("button", { name: "Configure registration" })).toHaveFocus();

    await enterOn("button", "Configure registration");
    await enterOn("button", "Save registration settings");
    expect(await screen.findByText("Registration settings saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure registration" })).toHaveFocus();
  });
});

describe("SCRUM585 AC1 a submitted change request shows its confirmation", () => {
  async function submitChange() {
    vi.mocked(submitChangeRequest).mockResolvedValue({});
    renderMyEvents([approved]);
    await userEvent.click(await screen.findByRole("button", { name: "Request a change" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "What needs to change?" }), "purpose");
    await userEvent.type(screen.getByRole("textbox", { name: "Describe the change" }), "Alumni night");
    vi.mocked(getChangeRequests).mockResolvedValue([
      { id: "c1", requestGroupId: "g1", changeField: "purpose", details: "Alumni night", status: "outstanding", createdAt: NINE_AM },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Submit change request" }));
  }

  it("SCRUM585_AC1_submitting_a_change_request_shows_its_confirmation", async () => {
    await submitChange();

    expect(await screen.findByText("Your change request has been submitted.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Request a change" })).toBeInTheDocument();
    // The history below the form reads again and shows the new request.
    const history = screen.getByRole("region", { name: "Change request history" });
    expect(await within(history).findByText("Alumni night")).toBeInTheDocument();
    expect(getMyEventRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM585_AC1_back_from_a_change_request_confirmation_returns_to_the_list", async () => {
    await submitChange();
    await screen.findByText("Your change request has been submitted.");

    await userEvent.click(screen.getByRole("button", { name: "← Back to my requests" }));

    expect(await screen.findByRole("heading", { level: 1, name: "My event requests" })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Request a change" })).toHaveFocus());
  });
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const APP_CSS = readFileSync(resolve(SRC, "App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of each rule for this selector, at any nesting, joined. */
const rulesFor = (selector, css = APP_CSS) =>
  [...css.matchAll(new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "gm"))]
    .map((match) => match[1])
    .join(";");
/** The rules inside every `@media (max-width: 720px)` block, joined. */
const narrowRules = [...APP_CSS.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
const ROOTS = [".dashboard--organiser", ".my-event-requests", ".event-registration-page"];

describe("SCRUM585 AC5 the focus ring", () => {
  it("SCRUM585_AC5_every_control_and_focused_title_on_the_organiser_screens_gets_the_accent_ring", () => {
    for (const root of ROOTS) {
      expect(rulesFor(`${root} :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible`))
        .toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    }
  });

  it("SCRUM585_AC5_form_fields_no_longer_set_the_faint_focus_outline", () => {
    for (const selector of [".event-request-form input:focus", ".event-registration-page__fields input:focus"]) {
      expect(rulesFor(selector)).not.toMatch(/outline/);
    }
  });
});

describe("SCRUM585 AC6 the 360px rules", () => {
  it("SCRUM585_AC6_long_event_names_notes_and_references_wrap_on_every_organiser_screen", () => {
    for (const root of ROOTS) expect(rulesFor(root)).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("SCRUM585_AC6_two_column_grids_become_one_column_at_phone_width", () => {
    expect(rulesFor(".event-request-form__row", narrowRules)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".event-registration-page__fields", narrowRules)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".dashboard--organiser__event-details dl", narrowRules)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".dashboard--organiser .dashboard--organiser__deadline-row", narrowRules)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".my-event-requests__details dl", narrowRules)).toMatch(/grid-template-columns:\s*1fr/);
  });

  it("SCRUM585_AC6_the_form_fieldsets_can_shrink_to_a_phone", () => {
    expect(rulesFor(".change-request-form__row")).toMatch(/min-width:\s*0/);
    expect(rulesFor(".clarification-reply__amendments")).toMatch(/min-width:\s*0/);
  });

  it("SCRUM585_AC6_the_registrations_table_stacks_into_labelled_cards_at_phone_width", async () => {
    expect(rulesFor(".registration-list__table tr", narrowRules)).toMatch(/display:\s*grid/);
    expect(rulesFor(".registration-list__table td::before", narrowRules)).toMatch(/content:\s*attr\(data-label\)/);

    vi.mocked(getEventRegistrations).mockResolvedValue({
      event: { id: "e1", eventName: "Gala", status: "confirmed", capacity: 50 },
      counts: { registered: 1, waitlisted: 0, capacity: 50 },
      hideWithdrawn: false,
      entries: [{ id: "r1", attendeeName: "Ada", attendeeEmail: "ada@example.com", registeredAt: NINE_AM, statusLabel: "Registered" }],
    });
    render(<EventRegistrationList eventId="e1" />, { wrapper: MemoryRouter });
    const cells = within(await screen.findByRole("table")).getAllByRole("cell");
    expect(cells.map((cell) => cell.dataset.label)).toEqual(["Attendee", "Email", "Joined (Singapore time)", "Status"]);
  });
});
