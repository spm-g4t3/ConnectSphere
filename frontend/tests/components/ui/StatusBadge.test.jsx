import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import StatusBadge from "../../../src/components/ui/StatusBadge.jsx";

describe("StatusBadge", () => {
  it("SCRUM584_AC3_renders_the_tone_class_with_the_label", () => {
    render(<StatusBadge tone="warning">Awaiting review</StatusBadge>);

    const badge = screen.getByText("Awaiting review");
    expect(badge).toHaveClass("ui-status-badge", "ui-status-badge--warning");
    // The old per-screen classes carry per-dashboard margins and must not leak in.
    expect(badge).not.toHaveClass("status-badge");
  });

  it("SCRUM584_AC3_defaults_to_the_neutral_tone", () => {
    render(<StatusBadge>Draft</StatusBadge>);

    expect(screen.getByText("Draft")).toHaveClass("ui-status-badge--neutral");
  });
});
