// scrum387EventDetailsEditPanel.test.jsx
//
// SCRUM-387 (SCRUM-391): the assigned coordinator's edit form. Which fields
// each status shows, what is sent (only altered fields, with the values the
// form opened with as `expected`), and what each refusal says. Every message
// is keyed on status and code: each refusal here carries server text the
// screen must not show.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventDetailsEditPanel from "../../src/components/EventDetailsEditPanel.jsx";
import { updateEventRequestDetails } from "../../src/services/eventRequestService";
import { toOffsetIsoString } from "../../src/services/datetimeFormat.js";
import { DETAIL_FIELD_LABELS, ORDINARY_DETAIL_FIELDS, SIGNIFICANT_DETAIL_FIELDS } from "../../src/services/eventDetailFields.js";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  updateEventRequestDetails: vi.fn(),
}));

const SERVER_TEXT = "Raw database wording the screen must never show";

const EVENT = Object.freeze({
  id: "e387",
  eventName: "Tech Talk",
  status: "under_review",
  purpose: "Industry networking",
  description: "Talks and networking",
  proposedStart: "2026-12-01T09:00:00.000Z",
  proposedEnd: "2026-12-01T11:00:00.000Z",
  expectedAttendance: 100,
  venueRequirements: "A large hall",
  accessibilityRequirements: null,
  equipmentRequirements: "Two microphones",
  updatedAt: "2026-10-20T03:00:00Z",
});

function renderPanel(event = EVENT, props = {}) {
  const user = userEvent.setup();
  const utils = render(<EventDetailsEditPanel eventRequest={event} {...props} />);
  return {
    user,
    ...utils,
    rerenderWith: (next) => utils.rerender(<EventDetailsEditPanel eventRequest={next} {...props} />),
  };
}

const field = (name) => screen.getByLabelText(DETAIL_FIELD_LABELS[name]);
const reasonBox = () => screen.getByLabelText("Reason for this change");
const save = () => screen.getByRole("button", { name: "Save changes" });

async function setText(user, name, value) {
  await user.clear(field(name));
  if (value) await user.type(field(name), value);
}

async function giveReason(user, text = "  Asked by the Organiser  ") {
  await user.type(reasonBox(), text);
}

function sent() {
  expect(updateEventRequestDetails).toHaveBeenCalledTimes(1);
  return vi.mocked(updateEventRequestDetails).mock.calls[0];
}

beforeEach(() => {
  vi.mocked(updateEventRequestDetails).mockReset();
  vi.mocked(updateEventRequestDetails).mockImplementation(async (id, { changes }) => ({
    ...EVENT, ...changes, id, changedFields: Object.keys(changes),
  }));
});


describe("SCRUM-387 which fields the form shows", () => {
  it.each(["under_review", "pending_clarification"])(
    "SCRUM387_AC2_an_event_that_is_%s_shows_all_nine_fields_with_the_organisers_labels",
    (status) => {
      renderPanel({ ...EVENT, status });

      for (const name of [...ORDINARY_DETAIL_FIELDS, ...SIGNIFICANT_DETAIL_FIELDS]) {
        expect(field(name)).toBeEnabled();
      }
      expect(field("proposedStart")).toHaveAttribute("type", "datetime-local");
      expect(field("expectedAttendance")).toHaveAttribute("type", "number");
      expect(screen.getByText(/Times are in your device's time zone/)).toBeInTheDocument();
      expect(screen.queryByText(/changed through Revise event details/)).not.toBeInTheDocument();
    },
  );

  it.each(["approved", "safety_review", "safety_approved"])(
    "SCRUM387_AC3_an_event_that_is_%s_shows_only_name_purpose_and_description",
    (status) => {
      renderPanel({ ...EVENT, status });

      for (const name of ORDINARY_DETAIL_FIELDS) expect(field(name)).toBeInTheDocument();
      for (const name of SIGNIFICANT_DETAIL_FIELDS) {
        expect(screen.queryByLabelText(DETAIL_FIELD_LABELS[name])).not.toBeInTheDocument();
      }
      expect(screen.getByText(
        "The date, time, attendance, requirements and equipment are changed through Revise event details.",
      )).toBeInTheDocument();
      expect(screen.queryByText(/Times are in your device's time zone/)).not.toBeInTheDocument();
    },
  );

  it("SCRUM387_AC2_opens_with_the_stored_values", () => {
    renderPanel();

    expect(field("eventName")).toHaveValue("Tech Talk");
    expect(field("expectedAttendance")).toHaveValue(100);
    expect(field("accessibilityRequirements")).toHaveValue("");
    expect(field("proposedStart").value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});


describe("SCRUM-387 what a save sends", () => {
  it("SCRUM387_AC9_sends_only_the_altered_field_with_the_value_the_form_opened_with", async () => {
    const onSaved = vi.fn();
    const { user } = renderPanel(EVENT, { onSaved });

    await setText(user, "eventName", "  Tech Talk 2026  ");
    await giveReason(user);
    await user.click(save());

    expect(sent()).toEqual(["e387", {
      changes: { eventName: "Tech Talk 2026" },
      expected: { eventName: "Tech Talk" },
      reason: "Asked by the Organiser",
    }]);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ changedFields: ["eventName"] })));
  });

  it("SCRUM387_AC9_the_snapshot_is_taken_when_the_form_opens_not_from_a_later_prop", async () => {
    // The parent refetches while the form is open: the Organiser's reply changed the purpose.
    const { user, rerenderWith } = renderPanel();
    rerenderWith({ ...EVENT, purpose: "The Organiser's own words", updatedAt: "2026-10-21T03:00:00Z" });

    expect(field("purpose")).toHaveValue("Industry networking");
    await setText(user, "purpose", "Alumni networking");
    await giveReason(user);
    await user.click(save());

    expect(sent()[1].expected).toEqual({ purpose: "Industry networking" });
  });

  it("SCRUM387_AC9_an_untouched_start_is_not_sent_and_a_moved_one_round_trips", async () => {
    const { user } = renderPanel();

    fireEvent.change(field("proposedEnd"), { target: { value: "2026-12-05T18:30" } });
    await setText(user, "expectedAttendance", "150");
    await giveReason(user);
    await user.click(save());

    expect(sent()[1]).toMatchObject({
      changes: { proposedEnd: toOffsetIsoString("2026-12-05T18:30"), expectedAttendance: 150 },
      expected: { proposedEnd: EVENT.proposedEnd, expectedAttendance: 100 },
    });
    expect(sent()[1].changes).not.toHaveProperty("proposedStart");
  });

  it("SCRUM387_AC6_a_cleared_box_is_sent_as_null", async () => {
    const { user } = renderPanel();

    await setText(user, "description", "");
    await setText(user, "expectedAttendance", "");
    await giveReason(user);
    await user.click(save());

    expect(sent()[1].changes).toEqual({ description: null, expectedAttendance: null });
  });

  it("SCRUM387_AC6_a_cleared_start_is_sent_as_null_for_the_server_to_refuse", async () => {
    const { user } = renderPanel();

    fireEvent.change(field("proposedStart"), { target: { value: "" } });
    await giveReason(user);
    await user.click(save());

    expect(sent()[1].changes).toEqual({ proposedStart: null });
  });

  it.each([
    ["nothing_touched", async () => {}],
    ["text_cleared_and_typed_back", async (user) => setText(user, "purpose", "Industry networking")],
    ["an_empty_field_given_only_spaces", async (user) => user.type(field("accessibilityRequirements"), "   ")],
    ["a_value_padded_with_spaces", async (user) => setText(user, "eventName", "  Tech Talk ")],
  ])("SCRUM387_AC9_%s_is_nothing_to_save_and_calls_nothing", async (_label, act) => {
    const { user } = renderPanel();

    await act(user);
    await giveReason(user);
    await user.click(save());

    expect(screen.getByRole("alert")).toHaveTextContent("There is nothing to save: no field has changed.");
    expect(updateEventRequestDetails).not.toHaveBeenCalled();
  });
});


describe("SCRUM-387 the reason", () => {
  it("SCRUM387_AC6_a_blank_reason_is_shown_beside_the_box_and_nothing_is_sent", async () => {
    const { user } = renderPanel();

    await setText(user, "eventName", "Tech Talk 2026");
    await user.type(reasonBox(), "   ");
    await user.click(save());

    expect(screen.getByText("A reason is required.")).toBeInTheDocument();
    expect(reasonBox()).toHaveAttribute("aria-invalid", "true");
    expect(updateEventRequestDetails).not.toHaveBeenCalled();

    await user.type(reasonBox(), "Now there is one");
    expect(screen.queryByText("A reason is required.")).not.toBeInTheDocument();
  });

  it("SCRUM387_AC6_the_counter_counts_characters_as_the_server_does_and_4000_is_the_limit", async () => {
    const { user } = renderPanel();
    await setText(user, "eventName", "Tech Talk 2026");

    // 4,000 emoji are 8,000 UTF-16 units, and still within the server's limit.
    fireEvent.change(reasonBox(), { target: { value: "😀".repeat(4000) } });
    expect(screen.getByText("4,000 / 4,000 characters")).toBeInTheDocument();
    await user.click(save());
    expect(updateEventRequestDetails).toHaveBeenCalledTimes(1);

    fireEvent.change(reasonBox(), { target: { value: "x".repeat(4001) } });
    expect(screen.getByText("4,001 / 4,000 characters")).toBeInTheDocument();
    await user.click(save());
    expect(screen.getByText("The reason must be 4,000 characters or fewer.")).toBeInTheDocument();
    expect(updateEventRequestDetails).toHaveBeenCalledTimes(1);
  });
});


describe("SCRUM-387 what each refusal says", () => {
  async function saveRefusedWith(err, event = EVENT) {
    vi.mocked(updateEventRequestDetails).mockRejectedValueOnce(err);
    const utils = renderPanel(event);
    await setText(utils.user, "eventName", "Tech Talk 2026");
    await giveReason(utils.user);
    await utils.user.click(save());
    return utils;
  }

  it("SCRUM387_AC6_every_fault_is_shown_beside_its_field_at_once_with_a_summary", async () => {
    await saveRefusedWith(httpError(400, {
      error: SERVER_TEXT,
      details: [
        { field: "eventName", message: "must be 200 characters or fewer" },
        { field: "proposedStart", message: "must be in the future" },
        { field: "reason", message: "is required" },
        { field: "expected.eventName", message: "must be text or null" },
      ],
    }));

    expect(await screen.findByText("must be 200 characters or fewer")).toBeInTheDocument();
    expect(screen.getByText("must be in the future")).toBeInTheDocument();
    expect(screen.getByText("is required")).toBeInTheDocument();
    expect(field("eventName")).toHaveAttribute("aria-invalid", "true");
    expect(field("proposedStart")).toHaveAttribute("aria-invalid", "true");
    expect(field("purpose")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("Some details need correcting. Nothing has been saved.");
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });

  it.each([
    ["a_400_with_no_field_named", httpError(400, { error: SERVER_TEXT }),
      "These changes could not be saved as written. Check each field and the reason, then try again."],
    ["a_401", httpError(401, { error: SERVER_TEXT }), "Your session has expired. Please sign in again."],
    ["a_403", httpError(403, { error: SERVER_TEXT }), "You're no longer the coordinator for this event."],
    ["a_404", httpError(404, { error: SERVER_TEXT }), "This event can't be found. It may have been removed."],
    ["EVENT_CHANGED_SINCE_OPENED", httpError(409, { error: SERVER_TEXT, code: "EVENT_CHANGED_SINCE_OPENED" }),
      "Someone changed this event after you opened the form. Go back to see the current details, then make your change again."],
    ["SIGNIFICANT_CHANGE_REQUIRED", httpError(409, { error: SERVER_TEXT, code: "SIGNIFICANT_CHANGE_REQUIRED" }),
      "This event has been approved since you opened the form, so its date, time, attendance, requirements and equipment can no longer be edited here. Go back and use Revise event details."],
    ["EVENT_CONFIRMED", httpError(409, { error: SERVER_TEXT, code: "EVENT_CONFIRMED" }),
      "This event has been confirmed since you opened the form, so it can no longer be edited here. Go back and use Revise event details."],
    ["EVENT_STATUS_NOT_ALLOWED", httpError(409, { error: SERVER_TEXT, code: "EVENT_STATUS_NOT_ALLOWED" }),
      "This event's status has changed since you opened the form, and it can no longer be edited. Go back to see where it stands."],
    ["EVENT_HOLDS_ARRANGEMENTS", httpError(409, { error: SERVER_TEXT, code: "EVENT_HOLDS_ARRANGEMENTS" }),
      "This request still holds venue bookings, holds or equipment from before it was reopened. Release them, or approve the request and use Revise event details, before changing the date, time, attendance, requirements or equipment. The name, purpose and description can still be saved on their own."],
    ["a_409_with_a_code_this_build_does_not_know", httpError(409, { error: SERVER_TEXT, code: "SOMETHING_NEW" }),
      "This event has changed since you opened the form. Go back to see the current details, then try again."],
    ["a_500", httpError(500, { error: SERVER_TEXT }), "Your changes could not be saved. Please try again."],
    ["a_network_failure", new Error("Network Error"), "Your changes could not be saved. Please try again."],
  ])("SCRUM387_AC1_AC3_AC4_AC5_AC9_%s_is_said_in_the_screens_own_words", async (_label, err, message) => {
    await saveRefusedWith(err);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });

  it("SCRUM387_AC9_a_stale_save_keeps_what_was_typed_until_they_go_back", async () => {
    const onBack = vi.fn();
    vi.mocked(updateEventRequestDetails).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "EVENT_CHANGED_SINCE_OPENED" }),
    );
    const { user } = renderPanel(EVENT, { onBack });
    await setText(user, "purpose", "Alumni networking");
    await giveReason(user, "Typed with care");
    await user.click(save());

    await screen.findByRole("alert");
    expect(field("purpose")).toHaveValue("Alumni networking");
    expect(reasonBox()).toHaveValue("Typed with care");

    await user.click(screen.getByRole("button", { name: "Back to event" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("SCRUM387_AC2_after_EVENT_HOLDS_ARRANGEMENTS_an_ordinary_field_saves_on_its_own", async () => {
    vi.mocked(updateEventRequestDetails).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "EVENT_HOLDS_ARRANGEMENTS" }),
    );
    const onSaved = vi.fn();
    const { user } = renderPanel(EVENT, { onSaved });
    await setText(user, "expectedAttendance", "150");
    await setText(user, "description", "Talks, then networking");
    await giveReason(user);
    await user.click(save());
    await screen.findByRole("alert");

    await setText(user, "expectedAttendance", "100");
    await user.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(vi.mocked(updateEventRequestDetails).mock.calls[1][1].changes).toEqual({ description: "Talks, then networking" });
  });
});


describe("SCRUM-387 while the save is in flight", () => {
  it("SCRUM387_AC6_save_is_disabled_and_a_second_submit_sends_nothing", async () => {
    const pending = deferred();
    vi.mocked(updateEventRequestDetails).mockReturnValueOnce(pending.promise);
    const { user } = renderPanel(EVENT, { onSaved: vi.fn() });
    await setText(user, "eventName", "Tech Talk 2026");
    await giveReason(user);
    await user.click(save());

    const busy = screen.getByRole("button", { name: "Saving..." });
    expect(busy).toBeDisabled();
    fireEvent.submit(busy.closest("form"));
    expect(updateEventRequestDetails).toHaveBeenCalledTimes(1);

    pending.resolve({ ...EVENT, eventName: "Tech Talk 2026", changedFields: ["eventName"] });
    await waitFor(() => expect(save()).toBeEnabled());
  });
});
