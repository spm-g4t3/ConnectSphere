// UnreadCountContext.test.jsx
//
// SCRUM-172 AC4: the signed-in user's exact unread count, shared by the nav
// badge and the inbox heading. useAuth and the service are mocked, so nothing
// touches the network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { UnreadCountProvider, useUnreadCount } from "../../src/notifications/UnreadCountContext.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getUnreadCount } from "../../src/services/notificationService";
import { deferred, httpError } from "../helpers/async.js";
import { setVisibility } from "../helpers/visibility.js";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  getUnreadCount: vi.fn(),
}));

const ALICE = { id: "u1", name: "Alice", role: "attendee" };
const BOB = { id: "u2", name: "Bob", role: "attendee" };

/** Prints the count as the provider exposes it ("none" stands for null), with a way to refresh it. */
function Probe() {
  const { unreadCount, refreshUnreadCount } = useUnreadCount();
  return (
    <>
      <p data-testid="count">{unreadCount === null ? "none" : String(unreadCount)}</p>
      <button onClick={() => refreshUnreadCount()}>refresh</button>
    </>
  );
}

/** Calls refreshUnreadCount as a consumer would. Wrap in act. */
const refresh = () => screen.getByRole("button", { name: "refresh" }).click();

function renderAs(user) {
  vi.mocked(useAuth).mockReturnValue({ user });
  return render(
    <UnreadCountProvider>
      <Probe />
    </UnreadCountProvider>,
  );
}

const shown = () => screen.getByTestId("count").textContent;

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(getUnreadCount).mockReset();
  setVisibility("visible");
});

afterEach(() => {
  delete document.visibilityState;
});

describe("SCRUM172_AC4 reading the count", () => {
  it("SCRUM172_AC4_reads_the_count_for_the_signed_in_user", async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(73);

    renderAs(ALICE);

    expect(shown()).toBe("none");
    await act(async () => {});
    expect(shown()).toBe("73");
    expect(getUnreadCount).toHaveBeenCalledTimes(1);
  });

  it("SCRUM172_AC4_no_user_means_no_read_and_no_count", async () => {
    renderAs(null);
    await act(async () => {});

    expect(shown()).toBe("none");
    await act(async () => refresh());
    expect(getUnreadCount).not.toHaveBeenCalled();
  });

  it("SCRUM172_AC4_a_count_of_zero_is_a_number_not_none", async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(0);

    renderAs(ALICE);
    await act(async () => {});

    expect(shown()).toBe("0");
  });

  it("SCRUM172_AC4_keeps_the_last_count_when_a_read_fails", async () => {
    vi.mocked(getUnreadCount)
      .mockResolvedValueOnce(5)
      .mockRejectedValueOnce(httpError(500));

    renderAs(ALICE);
    await act(async () => {});
    expect(shown()).toBe("5");

    await act(async () => refresh());

    expect(getUnreadCount).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("5");
  });

  it("SCRUM172_AC4_refresh_shows_the_new_count", async () => {
    vi.mocked(getUnreadCount).mockResolvedValueOnce(5).mockResolvedValueOnce(4);

    renderAs(ALICE);
    await act(async () => {});
    await act(async () => refresh());

    expect(shown()).toBe("4");
  });
});

describe("SCRUM172_AC4 refreshing when the user returns", () => {
  it("SCRUM172_AC4_refreshes_when_the_tab_regains_focus", async () => {
    vi.mocked(getUnreadCount).mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);

    renderAs(ALICE);
    await act(async () => {});
    expect(shown()).toBe("1");

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(shown()).toBe("2");

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(shown()).toBe("3");
    expect(getUnreadCount).toHaveBeenCalledTimes(3);
  });

  it("SCRUM172_AC4_does_not_refresh_while_the_tab_is_hidden", async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    renderAs(ALICE);
    await act(async () => {});

    setVisibility("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(getUnreadCount).toHaveBeenCalledTimes(1);
  });

  it("SCRUM172_AC4_removes_its_listeners_on_unmount", async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    const { unmount } = renderAs(ALICE);
    await act(async () => {});
    unmount();

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {});

    expect(getUnreadCount).toHaveBeenCalledTimes(1);
  });

  it("SCRUM172_AC4_adds_no_listeners_with_no_one_signed_in", async () => {
    renderAs(null);
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(getUnreadCount).not.toHaveBeenCalled();
  });
});

describe("SCRUM172_AC4 one user's count never reaches another", () => {
  it("SCRUM172_AC4_never_shows_the_previous_users_count", async () => {
    const forAlice = deferred();
    const forBob = deferred();
    vi.mocked(getUnreadCount).mockReturnValueOnce(Promise.resolve(9));

    const { rerender } = renderAs(ALICE);
    await act(async () => {});
    expect(shown()).toBe("9");

    // Alice refreshes; the reply is held. Then Bob signs in, his read held too.
    vi.mocked(getUnreadCount).mockReturnValueOnce(forAlice.promise);
    act(() => {
      refresh();
    });
    vi.mocked(getUnreadCount).mockReturnValueOnce(forBob.promise);
    vi.mocked(useAuth).mockReturnValue({ user: BOB });
    rerender(
      <UnreadCountProvider>
        <Probe />
      </UnreadCountProvider>,
    );

    // Bob's read is in flight: no number, never Alice's 9.
    expect(shown()).toBe("none");

    // Alice's late reply must not land on Bob's badge.
    await act(async () => forAlice.resolve(42));
    expect(shown()).toBe("none");

    await act(async () => forBob.resolve(2));
    expect(shown()).toBe("2");
  });

  it("SCRUM172_AC4_signing_out_clears_the_count", async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(9);

    const { rerender } = renderAs(ALICE);
    await act(async () => {});
    expect(shown()).toBe("9");

    vi.mocked(useAuth).mockReturnValue({ user: null });
    rerender(
      <UnreadCountProvider>
        <Probe />
      </UnreadCountProvider>,
    );

    expect(shown()).toBe("none");
  });
});

describe("SCRUM172_AC4 outside a provider", () => {
  it("SCRUM172_AC4_outside_a_provider_shows_no_count_and_refresh_does_nothing", async () => {
    render(<Probe />);

    expect(shown()).toBe("none");
    expect(() => refresh()).not.toThrow();
    expect(getUnreadCount).not.toHaveBeenCalled();
  });
});
