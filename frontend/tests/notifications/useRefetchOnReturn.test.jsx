// useRefetchOnReturn.test.jsx
//
// SCRUM-172 AC4: the re-read on returning to the tab, shared by the inbox and
// the unread count.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { useRefetchOnReturn } from "../../src/notifications/useRefetchOnReturn.js";
import { setVisibility } from "../helpers/visibility.js";

const focus = () => window.dispatchEvent(new Event("focus"));
const visibilityChange = () => document.dispatchEvent(new Event("visibilitychange"));

beforeEach(() => {
  setVisibility("visible");
});

afterEach(() => {
  delete document.visibilityState;
});

describe("SCRUM172_AC4 refetching when the user returns", () => {
  it("SCRUM172_AC4_refetches_on_window_focus", () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));

    focus();

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("SCRUM172_AC4_refetches_when_the_tab_becomes_visible", () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));

    visibilityChange();

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("SCRUM172_AC4_does_not_refetch_while_the_tab_is_hidden", () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));

    setVisibility("hidden");
    visibilityChange();
    focus();

    expect(refetch).not.toHaveBeenCalled();
  });

  it("SCRUM172_AC4_registers_nothing_when_disabled", () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch, false));

    focus();
    visibilityChange();

    expect(refetch).not.toHaveBeenCalled();
  });

  it("SCRUM172_AC4_removes_its_listeners_on_unmount", () => {
    const refetch = vi.fn();
    const { unmount } = renderHook(() => useRefetchOnReturn(refetch));

    unmount();
    focus();
    visibilityChange();

    expect(refetch).not.toHaveBeenCalled();
  });
});
