import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import ConfirmDialog from "../../../src/components/ui/ConfirmDialog.jsx";

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function renderDialog(props = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      open
      title="Cancel this event?"
      confirmLabel="Cancel event"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      Registered attendees will be told.
    </ConfirmDialog>,
  );
  return { ...view, onConfirm, onCancel };
}

function pressEscape(dialog) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function () {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function () {
        this.removeAttribute("open");
      }),
    });
  });

  afterEach(() => {
    // Unmount while the stubs exist: the open dialog's cleanup calls close().
    cleanup();
    if (originalShowModal) {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
    } else {
      delete HTMLDialogElement.prototype.showModal;
    }
    if (originalClose) {
      Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
    } else {
      delete HTMLDialogElement.prototype.close;
    }
  });

  it("SCRUM584_AC3_opens_as_a_modal_labelled_by_its_h2_title", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Cancel this event?" });
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Cancel this event?",
    );
    expect(dialog).toHaveTextContent("Registered attendees will be told.");
  });

  it("SCRUM584_AC3_renders_nothing_while_closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  });

  it("SCRUM584_AC3_closes_when_open_turns_false", () => {
    const { rerender, onConfirm, onCancel } = renderDialog();

    rerender(
      <ConfirmDialog
        open={false}
        title="Cancel this event?"
        confirmLabel="Cancel event"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Registered attendees will be told.
      </ConfirmDialog>,
    );

    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("SCRUM584_AC3_focus_starts_on_cancel_so_Enter_never_confirms", () => {
    renderDialog({ danger: true });

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("SCRUM584_AC3_confirm_and_cancel_call_their_callbacks", () => {
    const { onConfirm, onCancel } = renderDialog({ cancelLabel: "Keep event" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel event" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep event" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("SCRUM584_AC3_Escape_calls_onCancel", () => {
    const { onCancel } = renderDialog();

    pressEscape(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("SCRUM584_AC3_danger_uses_the_danger_variant_for_confirm_only", () => {
    const { unmount } = renderDialog({ danger: true });

    expect(screen.getByRole("button", { name: "Cancel event" })).toHaveClass("ui-button--danger");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("ui-button--secondary");
    unmount();

    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel event" })).toHaveClass("ui-button--primary");
  });

  it("SCRUM584_AC3_busy_disables_both_buttons_and_holds_Escape", () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });

    const confirm = screen.getByRole("button", { name: "Cancel event" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();

    fireEvent.click(confirm);
    fireEvent.click(cancel);
    pressEscape(screen.getByRole("dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
