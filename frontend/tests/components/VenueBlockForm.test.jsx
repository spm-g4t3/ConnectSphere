// VenueBlockForm.test.jsx
//
// SCRUM-126 (part of SCRUM-17, AC1): "a block is created with venue,
// start/end datetime, reason category". The form's behaviour in create and
// edit mode.
//
// Dates are set with fireEvent.change (user-event cannot type into a
// datetime-local input in jsdom); everything else uses user-event.
// Timezone-safe: inputs are built from instants via toDatetimeLocalValue, and
// what the form sends is checked by offset shape and getTime(), never by a
// hard-coded wall-clock string.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueBlockForm from "../../src/components/VenueBlockForm.jsx";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An instant relative to the real clock, minute-aligned, as ISO. */
function fromNow(ms) {
  const t = Math.floor((Date.now() + ms) / 60_000) * 60_000;
  return new Date(t).toISOString();
}

/** The datetime-local value for an instant, in this device's zone. */
function local(iso) {
  return toDatetimeLocalValue(new Date(iso).toISOString());
}

function startInput() {
  return screen.getByLabelText("Start");
}
function endInput() {
  return screen.getByLabelText("End");
}
function reasonSelect() {
  return screen.getByLabelText("Reason");
}
function notesInput() {
  return screen.getByRole("textbox");
}

function setDate(input, iso) {
  fireEvent.change(input, { target: { value: iso === "" ? "" : local(iso) } });
}

function renderForm(props = {}) {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  const utils = render(<VenueBlockForm onSubmit={onSubmit} {...props} />);
  return { onSubmit, user, ...utils };
}

async function fillValid(user, { start = fromNow(DAY), end = fromNow(2 * DAY), reason = "maintenance" } = {}) {
  setDate(startInput(), start);
  setDate(endInput(), end);
  await user.selectOptions(reasonSelect(), reason);
  return { start, end };
}

/** The error list under a control, via its aria-describedby. */
function errorsFor(control) {
  const id = control.getAttribute("aria-describedby");
  if (!id) return [];
  const list = document.getElementById(id);
  return within(list).getAllByRole("listitem").map((li) => li.textContent);
}

describe("VenueBlockForm rendering", () => {
  it("SCRUM17_AC1_renders_the_fields_hint_and_reasons_in_order", () => {
    renderForm();

    expect(screen.getByRole("heading", { level: 2, name: "Block this venue" })).toBeInTheDocument();
    expect(startInput()).toHaveAttribute("type", "datetime-local");
    expect(endInput()).toHaveAttribute("type", "datetime-local");
    expect(screen.getByLabelText("Notes (optional)")).toBe(notesInput());

    const hint = document.querySelector("p.venue-block-form__hint");
    expect(hint).toHaveTextContent(/^Times are in your device's time zone \(.+\)\.$/);

    const options = within(reasonSelect()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a reason",
      "Maintenance",
      "Renovation",
      "Safety",
      "Internal activity",
      "Other",
    ]);
    expect(options[0]).toBeDisabled();
    expect(options[0]).toHaveValue("");
    expect(reasonSelect()).toHaveValue("");

    expect(document.querySelector("p.venue-block-form__help")).toHaveTextContent("0/1000");
    expect(screen.getByRole("button", { name: "Block venue" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(startInput()).not.toHaveAttribute("aria-invalid");
    expect(startInput()).not.toHaveAttribute("aria-describedby");
  });
});

describe("VenueBlockForm create", () => {
  it("SCRUM17_AC1_submits_the_full_payload_with_offset_timestamps_that_round_trip", async () => {
    const { onSubmit, user } = renderForm();
    const { start, end } = await fillValid(user, { reason: "safety" });
    await user.type(notesInput(), "  Fire alarm test  ");
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["endsAt", "notes", "reason", "startsAt"]);
    expect(payload.startsAt).toMatch(OFFSET_SUFFIX);
    expect(payload.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(payload.startsAt).getTime()).toBe(new Date(start).getTime());
    expect(new Date(payload.endsAt).getTime()).toBe(new Date(end).getTime());
    expect(payload.reason).toBe("safety");
    expect(payload.notes).toBe("Fire alarm test");
  });

  it("leaves blank notes out of the payload", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user);
    await user.type(notesInput(), "   ");
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("notes");
  });

  it("SCRUM17_AC1_empty_submit_shows_required_errors_and_does_not_submit", async () => {
    const { onSubmit, user } = renderForm();
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).not.toHaveBeenCalled();
    for (const control of [startInput(), endInput(), reasonSelect()]) {
      expect(control).toHaveAttribute("aria-invalid", "true");
      expect(errorsFor(control)).toEqual(["is required"]);
    }
    const list = document.getElementById(startInput().getAttribute("aria-describedby"));
    expect(list).toHaveClass("venue-block-form__field-error");
    expect(list.tagName).toBe("UL");
    expect(notesInput()).not.toHaveAttribute("aria-invalid");
  });

  it("SCRUM17_AC1_shows_must_be_later_than_the_start", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user, { start: fromNow(2 * DAY), end: fromNow(DAY) });
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorsFor(endInput())).toEqual(["must be later than the start"]);
  });

  it("SCRUM17_AC1_shows_must_be_in_the_future_for_a_block_that_has_already_ended", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user, { start: fromNow(-3 * HOUR), end: fromNow(-HOUR) });
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorsFor(endInput())).toEqual(["must be in the future"]);
  });

  it("allows a start in the past when the end is ahead", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user, { start: fromNow(-3 * HOUR), end: fromNow(DAY) });
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("VenueBlockForm notes and errors", () => {
  it("SCRUM17_AC1_choosing_other_changes_the_label_and_makes_notes_required", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user, { reason: "other" });

    expect(screen.getByLabelText("Notes (required for Other)")).toBe(notesInput());
    expect(screen.queryByLabelText("Notes (optional)")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Block venue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorsFor(notesInput())).toEqual(["is required when the reason is other"]);

    await user.type(notesInput(), "Film shoot");
    await user.click(screen.getByRole("button", { name: "Block venue" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ reason: "other", notes: "Film shoot" });
  });

  it("updates the counter and shows the over-length error", async () => {
    const { onSubmit, user } = renderForm();
    await fillValid(user);

    await user.type(notesInput(), "abc");
    expect(document.querySelector("p.venue-block-form__help")).toHaveTextContent("3/1000");

    fireEvent.change(notesInput(), { target: { value: "a".repeat(1001) } });
    expect(document.querySelector("p.venue-block-form__help")).toHaveTextContent("1001/1000");

    await user.click(screen.getByRole("button", { name: "Block venue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorsFor(notesInput())).toEqual(["must be 1000 characters or fewer"]);
  });

  it("counts emoji as one character each", () => {
    renderForm();
    fireEvent.change(notesInput(), { target: { value: "\u{1F6A7}\u{1F6A7}" } });
    expect(document.querySelector("p.venue-block-form__help")).toHaveTextContent("2/1000");
  });

  it("editing a field clears its own client errors, and only its own", async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole("button", { name: "Block venue" }));
    expect(errorsFor(reasonSelect())).toEqual(["is required"]);

    await user.selectOptions(reasonSelect(), "renovation");
    expect(reasonSelect()).not.toHaveAttribute("aria-invalid");
    expect(reasonSelect()).not.toHaveAttribute("aria-describedby");
    expect(errorsFor(startInput())).toEqual(["is required"]);

    setDate(startInput(), fromNow(DAY));
    expect(startInput()).not.toHaveAttribute("aria-invalid");
    expect(errorsFor(endInput())).toEqual(["is required"]);
  });

  it("SCRUM17_AC1_server_errors_appear_under_all_four_fields_and_unmatched_ones_in_the_alert", () => {
    renderForm({
      serverErrors: [
        { field: "startsAt", message: "start is off" },
        { field: "endsAt", message: "end is off" },
        { field: "reason", message: "reason is off" },
        { field: "notes", message: "notes are off" },
        { field: "venueId", message: "is retired" },
      ],
    });

    expect(errorsFor(startInput())).toEqual(["start is off"]);
    expect(errorsFor(endInput())).toEqual(["end is off"]);
    expect(errorsFor(reasonSelect())).toEqual(["reason is off"]);
    expect(errorsFor(notesInput())).toEqual(["notes are off"]);
    for (const control of [startInput(), endInput(), reasonSelect(), notesInput()]) {
      expect(control).toHaveAttribute("aria-invalid", "true");
    }

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("venue-block-form__error");
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "venueId: is retired",
    ]);
  });

  it("does not show the alert when every server error matches a field", () => {
    renderForm({ serverErrors: [{ field: "endsAt", message: "end is off" }] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows formError in role=alert", () => {
    renderForm({ formError: "Could not reach the server." });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server.");
  });
});

describe("VenueBlockForm controls", () => {
  it("SCRUM17_AC1_submitting_disables_every_control_and_shows_Saving", async () => {
    const { onSubmit, rerender } = renderForm();
    rerender(<VenueBlockForm onSubmit={onSubmit} onCancel={() => {}} submitting />);

    const saving = screen.getByRole("button", { name: "Saving..." });
    expect(saving).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    for (const control of [startInput(), endInput(), reasonSelect(), notesInput()]) {
      expect(control).toBeDisabled();
    }

    fireEvent.submit(saving.closest("form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows Cancel only with onCancel, and Cancel does not submit", async () => {
    const onCancel = vi.fn();
    const { onSubmit, user } = renderForm({ onCancel });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC1_onDatesChanged_fires_for_date_changes_but_not_reason_or_notes", async () => {
    const onDatesChanged = vi.fn();
    const { user } = renderForm({ onDatesChanged });
    const start = fromNow(DAY);
    const end = fromNow(2 * DAY);

    setDate(startInput(), start);
    expect(onDatesChanged).toHaveBeenCalledTimes(1);
    const first = onDatesChanged.mock.calls[0][0];
    expect(first.startsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(first.startsAt).getTime()).toBe(new Date(start).getTime());
    expect(first.endsAt).toBeUndefined();

    setDate(endInput(), end);
    expect(onDatesChanged).toHaveBeenCalledTimes(2);
    const second = onDatesChanged.mock.calls[1][0];
    expect(new Date(second.startsAt).getTime()).toBe(new Date(start).getTime());
    expect(second.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(second.endsAt).getTime()).toBe(new Date(end).getTime());

    await user.selectOptions(reasonSelect(), "maintenance");
    await user.type(notesInput(), "note");
    expect(onDatesChanged).toHaveBeenCalledTimes(2);
  });
});

describe("VenueBlockForm edit", () => {
  function storedBlock(overrides = {}) {
    return {
      id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      startsAt: fromNow(DAY),
      endsAt: fromNow(2 * DAY),
      reason: "renovation",
      notes: "Repainting",
      ...overrides,
    };
  }

  it("SCRUM17_AC1_prefills_from_initialBlock", () => {
    const block = storedBlock();
    renderForm({ initialBlock: block });

    expect(screen.getByRole("heading", { level: 2, name: "Change this block" })).toBeInTheDocument();
    expect(startInput()).toHaveValue(local(block.startsAt));
    expect(endInput()).toHaveValue(local(block.endsAt));
    expect(reasonSelect()).toHaveValue("renovation");
    expect(notesInput()).toHaveValue("Repainting");
    expect(document.querySelector("p.venue-block-form__help")).toHaveTextContent("10/1000");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("an unchanged submit shows Nothing has changed and does not submit", async () => {
    const { onSubmit, user } = renderForm({ initialBlock: storedBlock() });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nothing has changed, so there is nothing to save.",
    );

    // Editing a field retires the notice.
    await user.type(notesInput(), "!");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC1_sends_only_the_changed_endsAt", async () => {
    const { onSubmit, user } = renderForm({ initialBlock: storedBlock() });
    const newEnd = fromNow(3 * DAY);
    setDate(endInput(), newEnd);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const changes = onSubmit.mock.calls[0][0];
    expect(Object.keys(changes)).toEqual(["endsAt"]);
    expect(changes.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(changes.endsAt).getTime()).toBe(new Date(newEnd).getTime());
  });

  it("sends cleared notes as null", async () => {
    const { onSubmit, user } = renderForm({ initialBlock: storedBlock() });
    await user.clear(notesInput());
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({ notes: null });
  });

  it("a notes-only edit on an ended block does not require a future end", async () => {
    const { onSubmit, user } = renderForm({
      initialBlock: storedBlock({ startsAt: fromNow(-3 * DAY), endsAt: fromNow(-2 * DAY) }),
    });
    await user.type(notesInput(), " and sanding");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({ notes: "Repainting and sanding" });
  });

  it("moving the end of a block into the past is refused", async () => {
    const { onSubmit, user } = renderForm({
      initialBlock: storedBlock({ startsAt: fromNow(-3 * DAY) }),
    });
    setDate(endInput(), fromNow(-HOUR));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorsFor(endInput())).toEqual(["must be in the future"]);
  });

  it("SCRUM17_AC1_shows_an_unknown_reason_code_as_an_option_and_allows_editing_the_block", async () => {
    const { onSubmit, user } = renderForm({ initialBlock: storedBlock({ reason: "flood" }) });

    const option = within(reasonSelect()).getByRole("option", { name: "flood (unrecognised reason)" });
    expect(option).toHaveValue("flood");
    expect(reasonSelect()).toHaveValue("flood");

    // Unchanged unknown reason: not the user's mistake, so a notes edit goes through.
    await user.type(notesInput(), " again");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(reasonSelect()).not.toHaveAttribute("aria-invalid");
    expect(onSubmit).toHaveBeenCalledWith({ notes: "Repainting again" });
  });

  it("does not offer the unrecognised option for a known reason", () => {
    renderForm({ initialBlock: storedBlock() });
    expect(screen.queryByRole("option", { name: /unrecognised reason/ })).not.toBeInTheDocument();
  });
});
