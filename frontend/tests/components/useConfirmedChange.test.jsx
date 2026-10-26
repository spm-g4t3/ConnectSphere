// AC2: the shared confirmation flow, tested on its own.
// A late answer must never reach the screen or the save after the staff member went back.
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useConfirmedChange from "../../src/components/useConfirmedChange";

const R1 = "11111111-1111-4111-8111-111111111111";
const answer = (affected) => ({ affected, usableBefore: 6, usableAfter: 2 });
const item = { reservationId: R1, eventName: "Gala", quantity: 2 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(previewPromise) {
  const save = vi.fn().mockResolvedValue({});
  const onSaved = vi.fn();
  const onFailure = vi.fn();
  const view = renderHook(() => useConfirmedChange());
  const change = { preview: () => previewPromise, save, onSaved, onFailure, action: "save" };
  return { ...view, save, onSaved, onFailure, change };
}

describe("cancelling while the check is still running", () => {
  it("SCRUM310_AC2_a_late_list_after_cancel_is_dropped", async () => {
    const checking = deferred();
    const { result, change, save } = setup(checking.promise);

    act(() => {
      result.current.start(change);
    });
    expect(result.current.stage).toBe("checking");
    act(() => result.current.cancel());
    expect(result.current.stage).toBe("idle");

    await act(async () => checking.resolve(answer([item])));

    expect(result.current.stage).toBe("idle");
    expect(result.current.impact).toBeNull();
    expect(result.current.reviewing).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC7_a_late_empty_answer_after_cancel_does_not_save", async () => {
    const checking = deferred();
    const { result, change, save, onSaved } = setup(checking.promise);

    act(() => {
      result.current.start(change);
    });
    act(() => result.current.cancel());
    await act(async () => checking.resolve(answer([])));

    expect(save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.stage).toBe("idle");
  });

  it("SCRUM310_AC2_a_late_failure_after_cancel_shows_nothing", async () => {
    const checking = deferred();
    const { result, change, onFailure } = setup(checking.promise);

    act(() => {
      result.current.start(change);
    });
    act(() => result.current.cancel());
    await act(async () => checking.reject(new Error("boom")));

    expect(result.current.errors).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_a_new_check_after_cancel_works_and_the_old_answer_cannot_overwrite_it", async () => {
    const first = deferred();
    const second = deferred();
    const { result, change, save } = setup(first.promise);

    act(() => {
      result.current.start(change);
    });
    act(() => result.current.cancel());
    act(() => {
      result.current.start({ ...change, preview: () => second.promise });
    });
    await act(async () => second.resolve(answer([item])));
    await act(async () => first.resolve(answer([])));

    expect(result.current.stage).toBe("confirming");
    expect(result.current.impact.affected).toEqual([item]);
    expect(save).not.toHaveBeenCalled();
  });
});
