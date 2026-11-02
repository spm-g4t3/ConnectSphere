// dialog.js
//
// jsdom has no HTMLDialogElement.showModal or close, which ConfirmDialog calls.
// Call stubDialogElement() at the top level of a test file to stand them in.

import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

export function stubDialogElement() {
  const original = {};

  beforeEach(() => {
    for (const name of ["showModal", "close"]) {
      original[name] = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
    }
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function () { this.setAttribute("open", ""); }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function () { this.removeAttribute("open"); }),
    });
  });

  afterEach(() => {
    // Unmount while the stubs exist: an open dialog's cleanup calls close().
    cleanup();
    for (const name of ["showModal", "close"]) {
      if (original[name]) Object.defineProperty(HTMLDialogElement.prototype, name, original[name]);
      else delete HTMLDialogElement.prototype[name];
    }
  });
}
