// SCRUM-310 (SCRUM-315) AC6: the reasons written under an event on the coordinator's
// Needs attention list.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import NeedsAttentionReasons from "../../src/components/NeedsAttentionReasons.jsx";

const reasonsList = () => screen.queryByRole("list", { name: "Why this event needs attention" });

describe("NeedsAttentionReasons", () => {
  it("SCRUM310_AC6_lists_every_reason_the_server_gave", () => {
    render(
      <NeedsAttentionReasons
        event={{
          needsAttention: true,
          attentionReasons: ["Venue: a booking is flagged for review", "Equipment unavailable: Fewer units of this equipment are usable (Dropped)"],
        }}
      />,
    );

    expect(within(reasonsList()).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Venue: a booking is flagged for review",
      "Equipment unavailable: Fewer units of this equipment are usable (Dropped)",
    ]);
  });

  it.each([
    ["the event does not need attention", { needsAttention: false, attentionReasons: ["Equipment: x"] }],
    ["the reasons are missing", { needsAttention: true }],
    ["the reasons are empty", { needsAttention: true, attentionReasons: [] }],
    ["the reasons are blank", { needsAttention: true, attentionReasons: ["  ", ""] }],
    ["there is no event", undefined],
  ])("SCRUM310_AC6_shows_nothing_when_%s", (_label, event) => {
    const { container } = render(<NeedsAttentionReasons event={event} />);

    expect(reasonsList()).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM310_AC6_two_equal_reasons_do_not_break_the_list", () => {
    render(<NeedsAttentionReasons event={{ needsAttention: true, attentionReasons: ["Equipment: x", "Equipment: x"] }} />);

    expect(within(reasonsList()).getAllByRole("listitem").length).toBeGreaterThanOrEqual(1);
  });
});
