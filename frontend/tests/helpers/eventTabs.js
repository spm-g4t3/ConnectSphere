// eventTabs.js
//
// The event page keeps its sections in tabs (Venues, Equipment, Details,
// Activity), and only the open tab's panel is in the accessibility tree.
// A test opens the tab, as a coordinator would, before reaching into it.

import { fireEvent, screen } from "@testing-library/react";

/** Opens the event page's tab named `name`, e.g. openTab(user, "Venues"). */
export async function openTab(user, name) {
  await user.click(await screen.findByRole("tab", { name }));
}

/** openTab for a test without a userEvent instance, e.g. one on fake timers. */
export function openTabNow(name) {
  fireEvent.click(screen.getByRole("tab", { name }));
}
