// dialog.js
//
// jsdom has no showModal or close on <dialog>, which ConfirmDialog calls. Plain
// functions rather than vi.fn, so a file's vi.resetAllMocks cannot empty them.

import { afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";

/** Call at the top of a file (or describe) whose tests open a ConfirmDialog. */
export function stubDialogElement() {
  const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function showModal() {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function close() {
        this.removeAttribute("open");
      },
    });
  });

  afterEach(() => {
    // Unmount while the stubs exist: an open dialog's cleanup calls close().
    cleanup();
    for (const [name, original] of [["showModal", originalShowModal], ["close", originalClose]]) {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
      else delete HTMLDialogElement.prototype[name];
    }
  });
}

/** Escape on a modal dialog fires a cancelable "cancel" event. */
export function pressEscape(dialog) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}
