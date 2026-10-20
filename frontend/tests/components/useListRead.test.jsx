// useListRead.test.jsx
//
// The read the work-list screens share: loading on every fetch, a status-keyed
// error, and the last list kept on screen when a refresh fails.

import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import useListRead from "../../src/components/useListRead.js";

const MESSAGES = { 403: "Only coordinators can see this." };
const FALLBACK = "The list could not be loaded.";

const refusal = (status) => Object.assign(new Error("refused"), { response: { status } });

function renderList(fetcher) {
  return renderHook(() => useListRead(fetcher, { messages: MESSAGES, fallback: FALLBACK }));
}

describe("useListRead", () => {
  it("starts empty and loading, then shows the fetched list", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 1 }]);
    const { result } = renderList(fetcher);

    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("words a failure by its status, else the fallback", async () => {
    const { result } = renderList(vi.fn().mockRejectedValue(refusal(403)));
    await waitFor(() => expect(result.current.error).toBe("Only coordinators can see this."));

    const other = renderList(vi.fn().mockRejectedValue(new Error("offline")));
    await waitFor(() => expect(other.result.current.error).toBe(FALLBACK));
  });

  it("keeps the last list when a refresh fails, and clears the error on the next success", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([{ id: 1 }]);
    const { result } = renderList(fetcher);
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));

    fetcher.mockRejectedValueOnce(refusal(500));
    let outcome;
    await act(async () => {
      outcome = await result.current.load();
    });
    expect(outcome).toBeNull();
    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(result.current.error).toBe(FALLBACK);

    fetcher.mockResolvedValueOnce([{ id: 2 }]);
    await act(async () => {
      outcome = await result.current.load();
    });
    expect(outcome).toEqual([{ id: 2 }]);
    expect(result.current.error).toBeNull();
  });

  it("shows loading again while a refresh runs", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([]);
    const { result } = renderList(fetcher);
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolve;
    fetcher.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    let pending;
    act(() => {
      pending = result.current.load();
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolve([{ id: 3 }]);
      await pending;
    });
    expect(result.current.loading).toBe(false);
  });
});
