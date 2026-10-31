import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import LoadingText from "../../../src/components/ui/LoadingText.jsx";

describe("LoadingText", () => {
  it("SCRUM584_AC5_announces_exactly_Loading_with_three_full_stops", () => {
    render(<LoadingText />);

    // Exact text match: the ellipsis character would fail it.
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });
});
