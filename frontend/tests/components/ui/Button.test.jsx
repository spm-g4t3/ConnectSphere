import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import Button from "../../../src/components/ui/Button.jsx";

describe("Button", () => {
  it.each([
    [undefined, "ui-button--primary"],
    ["secondary", "ui-button--secondary"],
    ["danger", "ui-button--danger"],
    ["link", "ui-button--link"],
  ])("SCRUM584_AC3_variant_%s_renders_its_class", (variant, expected) => {
    render(<Button variant={variant}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveClass("ui-button", expected);
  });

  it("SCRUM584_AC3_appends_a_caller_class_without_dropping_the_variant", () => {
    render(<Button variant="link" className="back-link">Back</Button>);

    expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
      "ui-button",
      "ui-button--link",
      "back-link",
    );
  });

  it("SCRUM584_AC3_defaults_to_type_button_so_it_never_submits_a_form", () => {
    const onSubmit = vi.fn((event) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Check</Button>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Check" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("SCRUM584_AC3_disabled_blocks_the_click", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Delete</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
