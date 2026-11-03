// scrum585OrganiserStates.test.jsx
//
// The UI standard's loading, empty, error and date rules on the Event Organiser
// screens, and the "Request submitted" page staying on screen after a submit.
// Services are mocked; every date is pinned to the standard's en-SG format.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventOrganiserDashboard from "../../src/components/EventOrganiserDashboard.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import EventRequestForm from "../../src/components/EventRequestForm.jsx";
import ChangeRequestForm from "../../src/components/ChangeRequestForm.jsx";
import ChangeRequestStatusList from "../../src/components/ChangeRequestStatusList.jsx";
import ClarificationReplyForm from "../../src/components/ClarificationReplyForm.jsx";
import ClarificationHistory from "../../src/components/ClarificationHistory.jsx";
import ConfirmedArrangements from "../../src/components/ConfirmedArrangements.jsx";
import DecisionHistory from "../../src/components/DecisionHistory.jsx";
import DecisionOutcome from "../../src/components/DecisionOutcome.jsx";
import EventChangeHistory from "../../src/components/EventChangeHistory.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import RegistrationEventsList from "../../src/components/RegistrationEventsList.jsx";
import EventRegistrationList from "../../src/components/EventRegistrationList.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  createEventRequest,
  getAssignmentHistory,
  getConfirmedArrangements,
  getEventChangeHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  reopenEventRequest,
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
import { deferred, httpError } from "../helpers/async.js";
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

// 01:00Z is 9:00 am in Singapore; the standard's own example.
const NINE_AM = "2026-01-15T01:00:00Z";
const ELEVEN_AM = "2026-01-15T03:00:00Z";

const display = (status, label, group) => ({ status, label, group, description: `${label}.` });
const eventRequest = (status, label, group, overrides = {}) => ({
  id: `e-${status}`, eventName: `${label} event`, purpose: "Networking", status,
  proposedStart: NINE_AM, proposedEnd: ELEVEN_AM, clarificationNote: null, decision: null,
  statusDisplay: display(status, label, group),
  ...overrides,
});
const draft = eventRequest("draft", "Draft", "DRAFT");
const submitted = eventRequest("submitted", "Requested", "AWAITING_REVIEW", { id: "new-1", eventName: "Gala" });
const clarification = eventRequest("pending_clarification", "Needs reply", "ACTION_REQUIRED", {
  clarificationNote: "Which hall?", clarificationReplyByDate: "2026-01-15",
});
const rejected = eventRequest("rejected", "Rejected", "REJECTED");
const cancelled = eventRequest("cancelled", "Cancelled", "CANCELLED", { cancelledAt: NINE_AM, cancellationReason: "Weather" });
const settingsResponse = {
  eventName: "Industry Night", status: "approved", proposedStart: NINE_AM,
  settings: {
    enabled: true, opensAt: NINE_AM, closesAt: null, capacity: 80, withdrawalDeadline: null,
    registeredCount: 0, waitlistEnabled: false, waitlistCount: 0,
  },
};
const listing = (entries) => ({
  event: { id: "e1", eventName: "Gala", status: "confirmed", capacity: 50 },
  counts: { registered: entries.length, waitlisted: 0, capacity: 50 },
  hideWithdrawn: false,
  entries,
});

const inRouter = (ui) => render(ui, { wrapper: MemoryRouter });

/** The standard's loading line: exactly "Loading...", as a status. */
function expectLoading(scope = screen) {
  const statuses = scope.getAllByRole("status").filter((el) => el.textContent.startsWith("Loading"));
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) expect(status).toHaveTextContent(/^Loading\.\.\.$/);
}
/** An ErrorNotice, with or without its Try again button, and never "Retry". */
async function expectErrorNotice(message, { tryAgain }) {
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveClass("ui-error-notice");
  expect(alert).toHaveTextContent(message);
  const button = within(alert).queryByRole("button", { name: "Try again" });
  if (tryAgain) expect(button).toBeInTheDocument();
  else expect(button).toBeNull();
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  return button;
}
function expectEmpty(message, nextStep) {
  const empty = screen.getByText(message).closest(".ui-empty-state");
  expect(empty).not.toBeNull();
  expect(within(empty).getByText(nextStep)).toBeInTheDocument();
  return empty;
}

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", name: "Ada", role: "event_organiser" } });
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getAssignmentHistory).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockResolvedValue([]);
});

describe("SCRUM585 AC4 the Organiser's dashboard", () => {
  const renderDashboard = () => inRouter(<EventOrganiserDashboard user={{ id: "u1", name: "Ada" }} />);

  it("SCRUM585_AC4_dashboard_loading_says_Loading_in_each_section", () => {
    vi.mocked(getMyEventRequests).mockReturnValue(deferred().promise);
    renderDashboard();

    const loading = screen.getAllByRole("status");
    expect(loading).toHaveLength(2);
    expectLoading();
  });

  it("SCRUM585_AC4_dashboard_empty_sections_say_what_to_do_next_with_one_create_link", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([]);
    renderDashboard();

    await screen.findByText("You haven't created any events yet.");
    expectEmpty("No outstanding amendments before your event dates.",
      "When a Coordinator asks you a question about an event, it will appear here.");
    const empty = expectEmpty("You haven't created any events yet.", "Create an event request to get started.");
    expect(within(empty).getByRole("link", { name: "+ Create new event" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "+ Create new event" })).toHaveLength(1);
  });

  it("SCRUM585_AC4_dashboard_failed_read_shows_one_error_and_try_again_reads_again", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce([submitted]);
    renderDashboard();

    const tryAgain = await expectErrorNotice("Could not load your event requests.", { tryAgain: true });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await userEvent.click(tryAgain);

    expect(await screen.findByText("Gala")).toBeInTheDocument();
    expect(getMyEventRequests).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("SCRUM585_AC4_dashboard_expired_session_has_no_try_again", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValue(httpError(401));
    renderDashboard();

    await expectErrorNotice("Could not load your event requests.", { tryAgain: false });
  });

  it("SCRUM585_AC4_dashboard_dates_and_reply_by_days_read_in_the_standard_format", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarification]);
    renderDashboard();

    const deadline = (await screen.findByRole("link", { name: "Respond in My Events" })).closest("li");
    expect(within(deadline).getByText("15 Jan 2026")).toBeInTheDocument();
    expect(screen.getByText(/^Reply by 15 Jan 2026/)).toBeInTheDocument();
    expect(screen.getAllByText("15 Jan 2026, 9:00 am").length).toBeGreaterThan(0);
    expect(screen.getByText("15 Jan 2026, 11:00 am")).toBeInTheDocument();
  });
});

describe("SCRUM585 AC4 My Events", () => {
  const renderMyEvents = () => inRouter(<MyEventRequests />);

  it("SCRUM585_AC4_my_events_loading_says_Loading", () => {
    vi.mocked(getMyEventRequests).mockReturnValue(deferred().promise);
    renderMyEvents();

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM585_AC4_my_events_empty_points_to_the_new_request_button", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([]);
    renderMyEvents();

    await screen.findByText("You haven't created any event requests yet.");
    expectEmpty("You haven't created any event requests yet.", "Select + New event request to start one.");
    expect(screen.getAllByRole("button", { name: "+ New event request" })).toHaveLength(1);
  });

  it("SCRUM585_AC4_my_events_failed_read_try_again_reads_again", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce([submitted]);
    renderMyEvents();

    await userEvent.click(await expectErrorNotice("Could not load your event requests.", { tryAgain: true }));

    expect(await screen.findByText("Gala")).toBeInTheDocument();
    expect(getMyEventRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM585_AC4_my_events_expired_session_has_no_try_again", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValue(httpError(401));
    renderMyEvents();

    await expectErrorNotice("Could not load your event requests.", { tryAgain: false });
  });

  it("SCRUM585_AC4_my_events_failed_reopen_is_an_error_notice_without_try_again", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([rejected]);
    vi.mocked(reopenEventRequest).mockRejectedValue(httpError(409, { error: "It has moved on." }));
    renderMyEvents();

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));

    await expectErrorNotice("It has moved on.", { tryAgain: false });
  });

  it("SCRUM585_AC4_my_events_dates_read_in_the_standard_format", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([clarification, cancelled]);
    renderMyEvents();

    expect(await screen.findByText(/Please respond by 15 Jan 2026\./)).toBeInTheDocument();
    const cancelledRow = screen.getByText("Cancelled event").closest("li");
    expect(within(cancelledRow).getAllByText("15 Jan 2026, 9:00 am")).toHaveLength(2); // cancelled on, proposed start
    expect(within(cancelledRow).getByText("15 Jan 2026, 11:00 am")).toBeInTheDocument();
  });
});

describe("SCRUM585 AC1 the event request's Request submitted page", () => {
  beforeEach(() => {
    vi.mocked(createEventRequest).mockResolvedValue({ ...submitted, status: "draft" });
    vi.mocked(updateEventRequest).mockResolvedValue({ ...submitted, status: "draft" });
    vi.mocked(submitEventRequest).mockResolvedValue(submitted);
  });

  async function createAndSubmit() {
    vi.mocked(getMyEventRequests).mockResolvedValue([]);
    inRouter(<MyEventRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "+ New event request" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Event name" }), "Gala");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    vi.mocked(getMyEventRequests).mockResolvedValue([submitted]);
    await userEvent.click(await screen.findByRole("button", { name: "Submit request" }));
  }

  it("SCRUM585_AC1_submitting_a_request_shows_the_request_submitted_page_with_its_reference", async () => {
    await createAndSubmit();

    expect(await screen.findByRole("heading", { level: 1, name: "Request submitted" })).toBeInTheDocument();
    expect(screen.getByText("new-1")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My event requests" })).toBeNull();
  });

  it("SCRUM585_AC1_back_from_request_submitted_returns_to_the_refreshed_list", async () => {
    await createAndSubmit();
    await screen.findByRole("heading", { name: "Request submitted" });

    await userEvent.click(screen.getByRole("button", { name: "← Back to my requests" }));

    expect(await screen.findByRole("heading", { level: 1, name: "My event requests" })).toBeInTheDocument();
    expect(await screen.findByText("Gala")).toBeInTheDocument();
  });

  it("SCRUM585_AC1_submitting_a_revision_shows_the_request_submitted_page_without_the_old_rejection", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([{ ...draft, id: "new-1" }]);
    vi.mocked(getEventDecisionHistory).mockResolvedValue([
      { id: "d1", decision: "rejected", decisionNote: "Too large", decidedAt: NINE_AM, decidedByName: "Priya" },
    ]);
    inRouter(<MyEventRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue editing" }));
    expect(await screen.findByRole("heading", { name: "Previous decisions" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByRole("heading", { name: "Request submitted" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Previous decisions" })).toBeNull();
  });
});

describe("SCRUM585 AC4 form submit errors offer no Try again", () => {
  it("SCRUM585_AC4_event_request_form_save_error_has_no_try_again", async () => {
    vi.mocked(createEventRequest).mockRejectedValue(httpError(500));
    render(<EventRequestForm />);

    await userEvent.type(screen.getByRole("textbox", { name: "Event name" }), "Gala");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await expectErrorNotice("Could not save your draft. Please try again.", { tryAgain: false });
  });

  it("SCRUM585_AC4_change_request_form_submit_error_has_no_try_again", async () => {
    vi.mocked(submitChangeRequest).mockRejectedValue(httpError(500));
    render(<ChangeRequestForm eventRequestId="e1" />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "purpose");
    await userEvent.type(screen.getByRole("textbox", { name: "Describe the change" }), "Alumni");
    await userEvent.click(screen.getByRole("button", { name: "Submit change request" }));

    await expectErrorNotice("Could not submit your change request.", { tryAgain: false });
  });

  it("SCRUM585_AC4_clarification_reply_send_error_has_no_try_again", async () => {
    vi.mocked(respondToEventClarification).mockRejectedValue(httpError(500));
    render(<ClarificationReplyForm request={clarification} />);

    await userEvent.type(await screen.findByRole("textbox", { name: "Your reply" }), "Hall B");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await expectErrorNotice("Could not send your reply.", { tryAgain: false });
  });
});

describe("SCRUM585 AC4 the clarification reply", () => {
  it("SCRUM585_AC4_clarification_reply_loading_and_reply_by_day_read_as_the_standard", () => {
    vi.mocked(getEventClarificationHistory).mockReturnValue(deferred().promise);
    render(<ClarificationReplyForm request={clarification} />);

    expect(screen.getByText("Please reply by 15 Jan 2026.")).toBeInTheDocument();
    expectLoading(within(screen.getByRole("region", { name: "Event amendments" })));
  });

  it("SCRUM585_AC4_clarification_reply_failed_options_read_try_again_reads_again", async () => {
    // Twice: the history inside the form makes the same read.
    vi.mocked(getEventClarificationHistory)
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue([{ id: "q1", type: "question", message: "Which hall?", requestedFields: ["purpose"] }]);
    render(<ClarificationReplyForm request={clarification} />);

    const amendments = screen.getByRole("region", { name: "Event amendments" });
    const tryAgain = await within(amendments).findByRole("button", { name: "Try again" });
    expect(within(amendments).getByRole("alert")).toHaveTextContent("Could not load the clarification details.");
    await userEvent.click(tryAgain);

    expect(await screen.findByText("1 field editable")).toBeInTheDocument();
  });
});

describe("SCRUM585 AC4 the change request history", () => {
  it("SCRUM585_AC4_change_requests_loading_says_Loading", () => {
    vi.mocked(getChangeRequests).mockReturnValue(deferred().promise);
    render(<ChangeRequestStatusList eventRequestId="e1" />);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM585_AC4_change_requests_empty_points_to_the_form", async () => {
    render(<ChangeRequestStatusList eventRequestId="e1" />);

    await screen.findByText("You haven't requested any changes for this event.");
    expectEmpty("You haven't requested any changes for this event.", "Use the form above to request one.");
  });

  it("SCRUM585_AC4_change_requests_failed_read_try_again_reads_again", async () => {
    vi.mocked(getChangeRequests).mockRejectedValueOnce(httpError(500)).mockResolvedValue([{
      id: "r1", requestGroupId: "g1", changeField: "purpose", details: "Alumni", status: "processed",
      decision: "approved", createdAt: NINE_AM, processedAt: ELEVEN_AM,
    }]);
    render(<ChangeRequestStatusList eventRequestId="e1" />);

    await userEvent.click(await expectErrorNotice("Could not load your change requests.", { tryAgain: true }));

    expect(await screen.findByText(/^Requested 15 Jan 2026, 9:00 am; processed 15 Jan 2026, 11:00 am$/))
      .toBeInTheDocument();
  });
});

describe("SCRUM585 AC4 the clarification history", () => {
  it("SCRUM585_AC4_clarification_history_loading_and_empty_follow_the_standard", async () => {
    const pending = deferred();
    vi.mocked(getEventClarificationHistory).mockReturnValue(pending.promise);
    render(<ClarificationHistory eventRequestId="e1" />);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
    pending.resolve([]);
    await screen.findByText("No clarification updates yet.");
    expectEmpty("No clarification updates yet.", "Questions and replies about this event will appear here.");
  });

  it("SCRUM585_AC4_clarification_history_failed_read_try_again_shows_dated_entries", async () => {
    vi.mocked(getEventClarificationHistory).mockRejectedValueOnce(httpError(500)).mockResolvedValue([
      { id: "q1", type: "question", message: "Which hall?", authorName: "Priya", createdAt: NINE_AM, replyByDate: "2026-01-20" },
    ]);
    render(<ClarificationHistory eventRequestId="e1" />);

    await userEvent.click(await expectErrorNotice("Clarification history could not be loaded.", { tryAgain: true }));

    expect(await screen.findByText("15 Jan 2026, 9:00 am")).toBeInTheDocument();
    expect(screen.getByText("20 Jan 2026")).toBeInTheDocument();
  });
});

describe("SCRUM585 AC4 the panels inside a My Events row", () => {
  it("SCRUM585_AC4_confirmed_arrangements_failed_read_says_try_again_not_retry", async () => {
    vi.mocked(getConfirmedArrangements).mockRejectedValue(httpError(500));
    render(<ConfirmedArrangements eventRequestId="e1" />);
    await userEvent.click(screen.getByText("Confirmed arrangements"));

    await expectErrorNotice("Confirmed arrangements could not be loaded.", { tryAgain: true });
  });

  it("SCRUM585_AC4_decision_history_failed_read_try_again_reads_again", async () => {
    vi.mocked(getEventDecisionHistory).mockRejectedValueOnce(httpError(500)).mockResolvedValue([
      { id: "d1", decision: "rejected", decisionNote: "Too large", decidedAt: NINE_AM, decidedByName: "Priya" },
    ]);
    render(<DecisionHistory eventRequestId="e1" />);

    await userEvent.click(await expectErrorNotice("Previous decisions could not be loaded.", { tryAgain: true }));

    expect(await screen.findByText("15 Jan 2026, 9:00 am", { exact: false })).toBeInTheDocument();
  });

  // A refused or missing record answers the same again, so there is nothing to try.
  it("SCRUM585_AC4_decision_and_change_histories_refused_read_has_no_try_again", async () => {
    vi.mocked(getEventDecisionHistory).mockRejectedValue(httpError(403));
    vi.mocked(getEventChangeHistory).mockRejectedValue(httpError(404));
    render(<><DecisionHistory eventRequestId="e1" /><EventChangeHistory eventRequestId="e1" /></>);

    await screen.findByText("The change history could not be loaded.");
    await screen.findByText("Previous decisions could not be loaded.");
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(alert).toHaveClass("ui-error-notice");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("SCRUM585_AC4_decision_outcome_failed_name_read_says_so_and_try_again_names_the_decider", async () => {
    vi.mocked(getAssignmentHistory).mockRejectedValueOnce(httpError(500))
      .mockResolvedValue([{ newCoordinatorId: "c1", newCoordinatorName: "Priya Nair" }]);
    render(<DecisionOutcome request={{ ...rejected, decision: "rejected", decidedBy: "c1", decidedAt: NINE_AM }} view="organiser" />);

    expect(screen.getByText("15 Jan 2026, 9:00 am")).toBeInTheDocument();
    await userEvent.click(await expectErrorNotice("The decider's name could not be loaded.", { tryAgain: true }));

    expect(await screen.findByText("Priya Nair")).toBeInTheDocument();
  });

  it("SCRUM585_AC4_change_history_empty_and_failed_read_follow_the_standard", async () => {
    vi.mocked(getEventChangeHistory).mockRejectedValueOnce(httpError(500)).mockResolvedValue([]);
    render(<EventChangeHistory eventRequestId="e1" />);

    await userEvent.click(await expectErrorNotice("The change history could not be loaded.", { tryAgain: true }));

    await screen.findByText("No changes have been recorded.");
    expectEmpty("No changes have been recorded.", "Changes made to this event's details will appear here.");
  });
});

describe("SCRUM585 AC4 the registration screens", () => {
  it("SCRUM585_AC4_registration_settings_loading_says_Loading", () => {
    vi.mocked(getRegistrationSettings).mockReturnValue(deferred().promise);
    inRouter(<EventRegistrationSettings eventId="e1" />);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM585_AC4_registration_settings_failed_read_try_again_reads_again", async () => {
    vi.mocked(getRegistrationSettings).mockRejectedValueOnce(httpError(503)).mockResolvedValue(settingsResponse);
    inRouter(<EventRegistrationSettings eventId="e1" />);

    await userEvent.click(await expectErrorNotice("Could not load registration settings.", { tryAgain: true }));

    expect(await screen.findByRole("heading", { level: 1, name: "Industry Night" })).toBeInTheDocument();
    expect(getRegistrationSettings).toHaveBeenCalledTimes(2);
  });

  it("SCRUM585_AC4_registration_settings_expired_session_has_no_try_again", async () => {
    vi.mocked(getRegistrationSettings).mockRejectedValue(httpError(401, { error: "Session expired." }));
    inRouter(<EventRegistrationSettings eventId="e1" />);

    await expectErrorNotice("Session expired.", { tryAgain: false });
  });

  it("SCRUM585_AC4_registration_settings_save_error_has_no_try_again", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    vi.mocked(saveRegistrationSettings).mockRejectedValue(httpError(500));
    inRouter(<EventRegistrationSettings eventId="e1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Configure registration" }));
    await userEvent.click(screen.getByRole("button", { name: "Save registration settings" }));

    await expectErrorNotice("Could not save registration settings.", { tryAgain: false });
  });

  it("SCRUM585_AC4_registration_settings_times_read_in_the_standard_format_with_one_zone_note", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(settingsResponse);
    inRouter(<EventRegistrationSettings eventId="e1" />);

    expect(await screen.findByText("Event starts: 15 Jan 2026, 9:00 am (Singapore time)")).toBeInTheDocument();
    const opens = screen.getByText("Opens").closest("div");
    expect(within(opens).getByText("15 Jan 2026, 9:00 am")).toBeInTheDocument();
    expect(screen.getAllByText(/\(Singapore time\)/)).toHaveLength(1);
  });

  it("SCRUM585_AC4_registration_events_loading_and_empty_follow_the_standard", async () => {
    const pending = deferred();
    vi.mocked(getMyEventRequests).mockReturnValue(pending.promise);
    inRouter(<RegistrationEventsList />);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
    pending.resolve([draft]);
    await screen.findByText("None of your events can have registration set up yet.");
    expectEmpty("None of your events can have registration set up yet.",
      "An event must be Approved, in Safety review, Safety approved or Confirmed.");
  });

  it("SCRUM585_AC4_registration_events_failed_read_try_again_shows_dated_events", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValueOnce(httpError(500))
      .mockResolvedValue([eventRequest("approved", "Approved", "APPROVED")]);
    inRouter(<RegistrationEventsList />);

    await userEvent.click(await expectErrorNotice("Could not load your events.", { tryAgain: true }));

    expect(await screen.findByText(/15 Jan 2026, 9:00 am/)).toBeInTheDocument();
  });

  it("SCRUM585_AC4_registrations_list_loading_and_empty_follow_the_standard", async () => {
    const pending = deferred();
    vi.mocked(getEventRegistrations).mockReturnValue(pending.promise);
    inRouter(<EventRegistrationList eventId="e1" />);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
    pending.resolve(listing([]));
    await screen.findByText("No registrations to show.");
    expectEmpty("No registrations to show.", "Attendees who register for this event will appear here.");
  });

  it("SCRUM585_AC4_registrations_list_empty_with_withdrawn_hidden_says_how_to_show_them", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue(listing([]));
    inRouter(<EventRegistrationList eventId="e1" />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Hide withdrawn" }));

    await screen.findByText("Clear Hide withdrawn to include withdrawn registrations.");
    expectEmpty("No registrations to show.", "Clear Hide withdrawn to include withdrawn registrations.");
  });

  it("SCRUM585_AC4_registrations_list_refused_read_has_no_try_again", async () => {
    vi.mocked(getEventRegistrations).mockRejectedValue(httpError(403, { error: "Not your event." }));
    inRouter(<EventRegistrationList eventId="e1" />);

    await expectErrorNotice("Not your event.", { tryAgain: false });
  });

  it("SCRUM585_AC4_registrations_list_failed_read_try_again_shows_dated_entries_with_one_zone_note", async () => {
    vi.mocked(getEventRegistrations).mockRejectedValueOnce(httpError(500)).mockResolvedValue(listing([
      { id: "1", attendeeName: "Cy", attendeeEmail: "cy@example.com", registeredAt: NINE_AM, status: "registered", statusLabel: "Registered" },
    ]));
    inRouter(<EventRegistrationList eventId="e1" />);

    await userEvent.click(await expectErrorNotice("Could not load the registrations.", { tryAgain: true }));

    expect(await screen.findByRole("cell", { name: "15 Jan 2026, 9:00 am" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Joined (Singapore time)" })).toBeInTheDocument();
    expect(screen.getAllByText(/\(Singapore time\)/)).toHaveLength(1);
  });
});
