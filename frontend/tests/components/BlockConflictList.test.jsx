// BlockConflictList.test.jsx
//
// SCRUM-125 (part of SCRUM-17, AC3): "the conflicting bookings are listed to
// the Venue Staff member, who must either choose a non-overlapping period or
// explicitly confirm the override."
//
// Timezone-safe: expected ranges are computed with toLocaleString from
// fixtures that carry offsets.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import BlockConflictList from "../../src/components/BlockConflictList.jsx";

const CONFLICT_A = {
  bookingId: "a1b2c3d4-0000-4000-8000-000000000001",
  eventRequestId: "e1b2c3d4-0000-4000-8000-000000000001",
  eventName: "Tech Talk",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
};

const CONFLICT_B = {
  bookingId: "a1b2c3d4-0000-4000-8000-000000000002",
  eventRequestId: "f9e8d7c6-0000-4000-8000-000000000002",
  eventName: "Career Fair",
  startsAt: "2026-10-01T13:00:00+08:00",
  endsAt: "2026-10-01T16:00:00+08:00",
};

const CONFLICT_C = {
  bookingId: "a1b2c3d4-0000-4000-8000-000000000003",
  eventRequestId: "c0ffee00-0000-4000-8000-000000000003",
  eventName: "Hackathon",
  startsAt: "2026-10-01T16:00:00+08:00",
  endsAt: "2026-10-01T18:00:00+08:00",
};

function range(startsAt, endsAt) {
  return `${new Date(startsAt).toLocaleString()} – ${new Date(endsAt).toLocaleString()}`;
}

function renderList(props = {}) {
  const onChangePeriod = vi.fn();
  const onConfirmOverride = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <BlockConflictList
      conflicts={[CONFLICT_A, CONFLICT_B]}
      onChangePeriod={onChangePeriod}
      onConfirmOverride={onConfirmOverride}
      {...props}
    />,
  );
  return { onChangePeriod, onConfirmOverride, user, ...utils };
}

const CONFIRM_TEXT = "Flag these bookings for review and notify Event Coordinators?";

let confirmSpy;

beforeEach(() => {
  confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

describe("SCRUM17_AC3 the conflict list", () => {
  it("SCRUM17_AC3_renders_nothing_for_an_empty_list", () => {
    const { container } = render(<BlockConflictList conflicts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no conflicts prop is given", () => {
    const { container } = render(<BlockConflictList />);
    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM17_AC3_heading_is_plural_for_several_bookings", () => {
    renderList();
    const status = screen.getByRole("status");
    expect(
      within(status).getByRole("heading", { level: 3, name: "This period overlaps 2 approved bookings" }),
    ).toBeInTheDocument();
  });

  it("SCRUM17_AC3_heading_is_singular_for_one_booking", () => {
    renderList({ conflicts: [CONFLICT_A] });
    expect(
      screen.getByRole("heading", { level: 3, name: "This period overlaps 1 approved booking" }),
    ).toBeInTheDocument();
  });

  it("has the section, status, list and actions structure", () => {
    const { container } = renderList();
    const section = container.querySelector("section.block-conflicts");
    expect(section).not.toBeNull();
    expect(section.querySelector('div[role="status"] > h3')).not.toBeNull();
    expect(section.querySelector("ul.block-conflicts__list")).not.toBeNull();
    expect(section.querySelector("div.block-conflicts__actions")).not.toBeNull();
  });

  it("SCRUM17_AC3_lists_each_conflict_with_name_range_and_short_id", () => {
    renderList();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    for (const [item, conflict] of [
      [items[0], CONFLICT_A],
      [items[1], CONFLICT_B],
    ]) {
      expect(item.querySelector("strong")).toHaveTextContent(conflict.eventName);
      expect(item.querySelector("span").textContent).toBe(range(conflict.startsAt, conflict.endsAt));
      const code = item.querySelector("code");
      expect(code.textContent).toBe(conflict.eventRequestId.slice(0, 8));
      expect(code).toHaveAttribute("title", conflict.eventRequestId);
    }
  });

  it("falls back for a missing name and a missing event id", () => {
    renderList({
      conflicts: [{ ...CONFLICT_A, eventName: "", eventRequestId: null }],
    });
    const item = within(screen.getByRole("list")).getByRole("listitem");
    expect(item.querySelector("strong").textContent).toBe("Unnamed event");
    const code = item.querySelector("code");
    expect(code.textContent).toBe("no event");
    expect(code).not.toHaveAttribute("title");
  });

  it("falls back when the name is missing altogether", () => {
    const withoutName = { ...CONFLICT_A };
    delete withoutName.eventName;
    renderList({ conflicts: [withoutName] });
    expect(screen.getByText("Unnamed event")).toBeInTheDocument();
  });
});

describe("SCRUM17_AC3 choosing a different period", () => {
  it("SCRUM17_AC3_choose_a_different_period_calls_onChangePeriod", async () => {
    const { user, onChangePeriod, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Choose a different period" }));
    expect(onChangePeriod).toHaveBeenCalledTimes(1);
    expect(onConfirmOverride).not.toHaveBeenCalled();
  });
});

describe("SCRUM17_AC3 the override", () => {
  it("SCRUM17_AC3_override_needs_a_second_click_and_passes_the_acknowledged_ids", async () => {
    const { user, onConfirmOverride } = renderList();

    expect(screen.queryByText(CONFIRM_TEXT)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));

    expect(onConfirmOverride).not.toHaveBeenCalled();
    expect(screen.getByText(CONFIRM_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Override and flag/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Yes, override" }));
    expect(onConfirmOverride).toHaveBeenCalledTimes(1);
    expect(onConfirmOverride).toHaveBeenCalledWith([CONFLICT_A.bookingId, CONFLICT_B.bookingId]);
  });

  it("passes the ids in on-screen order", async () => {
    const { user, onConfirmOverride } = renderList({ conflicts: [CONFLICT_B, CONFLICT_A] });
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));
    await user.click(screen.getByRole("button", { name: "Yes, override" }));
    expect(onConfirmOverride).toHaveBeenCalledWith([CONFLICT_B.bookingId, CONFLICT_A.bookingId]);
  });

  it("SCRUM17_AC3_override_label_is_singular_for_one_booking", () => {
    renderList({ conflicts: [CONFLICT_A] });
    expect(screen.getByRole("button", { name: "Override and flag 1 booking" })).toBeInTheDocument();
  });

  it("SCRUM17_AC3_cancel_closes_the_confirm_without_overriding", async () => {
    const { user, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirmOverride).not.toHaveBeenCalled();
    expect(screen.queryByText(CONFIRM_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, override" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Override and flag 2 bookings" })).toBeInTheDocument();
  });

  it("SCRUM17_AC3_submitting_disables_every_button_and_shows_flagging", async () => {
    const { user, rerender, onChangePeriod, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));

    rerender(
      <BlockConflictList
        conflicts={[CONFLICT_A, CONFLICT_B]}
        onChangePeriod={onChangePeriod}
        onConfirmOverride={onConfirmOverride}
        submitting
      />,
    );

    expect(screen.getByRole("button", { name: "Flagging..." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, override" })).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toBeDisabled();
  });

  it("disables both first-step buttons while submitting", () => {
    renderList({ submitting: true });
    expect(screen.getByRole("button", { name: "Choose a different period" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Override and flag 2 bookings" })).toBeDisabled();
  });

  it("SCRUM17_AC3_a_replaced_conflict_list_resets_the_confirm", async () => {
    const { user, rerender, onChangePeriod, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));
    expect(screen.getByText(CONFIRM_TEXT)).toBeInTheDocument();

    // A stale override came back with a new 409 naming a different set.
    rerender(
      <BlockConflictList
        conflicts={[CONFLICT_A, CONFLICT_B, CONFLICT_C]}
        onChangePeriod={onChangePeriod}
        onConfirmOverride={onConfirmOverride}
      />,
    );

    expect(screen.queryByText(CONFIRM_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, override" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Override and flag 3 bookings" })).toBeInTheDocument();
    expect(onConfirmOverride).not.toHaveBeenCalled();

    // Going through the confirm again hands back the new list.
    await user.click(screen.getByRole("button", { name: "Override and flag 3 bookings" }));
    await user.click(screen.getByRole("button", { name: "Yes, override" }));
    expect(onConfirmOverride).toHaveBeenCalledWith([
      CONFLICT_A.bookingId,
      CONFLICT_B.bookingId,
      CONFLICT_C.bookingId,
    ]);
  });

  it("a replaced list of the same size but different ids resets the confirm", async () => {
    const { user, rerender, onChangePeriod, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));

    rerender(
      <BlockConflictList
        conflicts={[CONFLICT_A, CONFLICT_C]}
        onChangePeriod={onChangePeriod}
        onConfirmOverride={onConfirmOverride}
      />,
    );

    expect(screen.queryByText(CONFIRM_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Override and flag 2 bookings" })).toBeInTheDocument();
  });

  it("SCRUM17_AC3_the_same_ids_reordered_keep_the_confirm_open", async () => {
    const { user, rerender, onChangePeriod, onConfirmOverride } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));

    rerender(
      <BlockConflictList
        conflicts={[{ ...CONFLICT_B }, { ...CONFLICT_A }]}
        onChangePeriod={onChangePeriod}
        onConfirmOverride={onConfirmOverride}
      />,
    );

    expect(screen.getByText(CONFIRM_TEXT)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, override" }));
    expect(onConfirmOverride).toHaveBeenCalledWith([CONFLICT_B.bookingId, CONFLICT_A.bookingId]);
  });

  it("SCRUM17_AC3_never_uses_window_confirm", async () => {
    const { user } = renderList();
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));
    await user.click(screen.getByRole("button", { name: "Yes, override" }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
