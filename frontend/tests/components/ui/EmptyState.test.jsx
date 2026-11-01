import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import EmptyState from "../../../src/components/ui/EmptyState.jsx";

describe("EmptyState", () => {
  it("SCRUM584_AC5_says_what_is_missing_and_what_to_do_next_with_the_action", () => {
    render(
      <EmptyState
        message="You have no event requests yet."
        nextStep="Submit a request to start planning an event."
        action={<button type="button">New request</button>}
      />,
    );

    expect(screen.getByText("You have no event requests yet.")).toBeInTheDocument();
    expect(screen.getByText("Submit a request to start planning an event.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New request" })).toBeInTheDocument();
  });
});
