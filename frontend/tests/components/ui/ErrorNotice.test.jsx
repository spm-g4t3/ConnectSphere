import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import ErrorNotice from "../../../src/components/ui/ErrorNotice.jsx";

describe("ErrorNotice", () => {
  it("SCRUM584_AC5_Try_again_calls_onRetry", () => {
    const onRetry = vi.fn();
    render(<ErrorNotice message="Could not load notifications." onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load notifications.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("SCRUM584_AC3_shows_no_button_without_onRetry", () => {
    render(<ErrorNotice message="That request no longer exists." />);

    expect(screen.getByRole("alert")).toHaveTextContent("That request no longer exists.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
