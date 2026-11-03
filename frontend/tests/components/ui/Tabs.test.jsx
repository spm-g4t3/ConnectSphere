import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Tabs from "../../../src/components/ui/Tabs.jsx";

/** Counts its own clicks, so a test can tell whether its panel kept its state. */
function Counter({ name }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)}>
      {`${name} clicked ${count}`}
    </button>
  );
}

const TABS = [
  { id: "one", label: "One", content: <Counter name="One" /> },
  { id: "two", label: "Two", content: <Counter name="Two" /> },
  { id: "three", label: "Three", content: <Counter name="Three" /> },
];

function renderTabs(props = {}) {
  const user = userEvent.setup();
  render(<Tabs label="Sections" tabs={TABS} {...props} />);
  return user;
}

const tab = (name) => screen.getByRole("tab", { name });
const selectedTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true");

describe("SCRUM586_AC7 Tabs by keyboard", () => {
  it("SCRUM586_AC7_the_tab_list_is_named_and_starts_on_the_default", () => {
    renderTabs({ defaultSelected: "two" });

    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    expect(selectedTab()).toBe(tab("Two"));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Two clicked 0");
  });

  it("SCRUM586_AC7_only_the_selected_tab_is_in_the_tab_order", async () => {
    const user = renderTabs();

    expect(tab("One")).toHaveAttribute("tabindex", "0");
    expect(tab("Two")).toHaveAttribute("tabindex", "-1");
    expect(tab("Three")).toHaveAttribute("tabindex", "-1");

    await user.click(tab("Three"));
    expect(tab("One")).toHaveAttribute("tabindex", "-1");
    expect(tab("Three")).toHaveAttribute("tabindex", "0");

    // Tab leaves the tab list for the open panel, not the next tab.
    tab("Three").focus();
    await user.tab();
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("SCRUM586_AC7_arrow_keys_move_focus_and_select", async () => {
    const user = renderTabs();
    tab("One").focus();

    await user.keyboard("{ArrowRight}");
    expect(tab("Two")).toHaveFocus();
    expect(selectedTab()).toBe(tab("Two"));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Two clicked 0");

    await user.keyboard("{ArrowLeft}");
    expect(tab("One")).toHaveFocus();
    expect(selectedTab()).toBe(tab("One"));
  });

  it("SCRUM586_AC7_arrow_keys_wrap_at_both_ends", async () => {
    const user = renderTabs();
    tab("One").focus();

    await user.keyboard("{ArrowLeft}");
    expect(tab("Three")).toHaveFocus();
    expect(selectedTab()).toBe(tab("Three"));

    await user.keyboard("{ArrowRight}");
    expect(tab("One")).toHaveFocus();
    expect(selectedTab()).toBe(tab("One"));
  });

  it("SCRUM586_AC7_home_and_end_jump_to_the_first_and_last_tab", async () => {
    const user = renderTabs({ defaultSelected: "two" });
    tab("Two").focus();

    await user.keyboard("{End}");
    expect(tab("Three")).toHaveFocus();
    expect(selectedTab()).toBe(tab("Three"));

    await user.keyboard("{Home}");
    expect(tab("One")).toHaveFocus();
    expect(selectedTab()).toBe(tab("One"));
  });

  it("SCRUM586_AC7_other_keys_change_nothing", async () => {
    const user = renderTabs();
    tab("One").focus();

    await user.keyboard("{ArrowDown}a");
    expect(tab("One")).toHaveFocus();
    expect(selectedTab()).toBe(tab("One"));
  });

  it("SCRUM586_AC7_each_panel_is_labelled_by_its_tab_and_reachable_by_tab_key", () => {
    renderTabs();

    for (const t of screen.getAllByRole("tab")) {
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", t.id);
      expect(panel).toHaveAttribute("tabindex", "0");
    }
    expect(screen.getByRole("tabpanel", { name: "One" })).toBeInTheDocument();
  });

  it("SCRUM586_AC7_hidden_panels_stay_mounted_and_keep_their_state", async () => {
    const user = renderTabs();
    await user.click(screen.getByRole("button", { name: "One clicked 0" }));

    await user.click(tab("Two"));
    // Still in the document, only hidden.
    const first = screen.getByRole("button", { name: "One clicked 1", hidden: true });
    expect(first.closest("[role=tabpanel]")).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "One clicked 1" })).not.toBeInTheDocument();

    await user.click(tab("One"));
    expect(screen.getByRole("button", { name: "One clicked 1" })).toBeVisible();
  });

  it("SCRUM586_AC7_controlled_it_shows_the_parents_choice_and_reports_each_pick", async () => {
    function Parent() {
      const [selected, setSelected] = useState("three");
      return (
        <>
          <Tabs label="Sections" tabs={TABS} selected={selected} onSelect={setSelected} />
          <output>{selected}</output>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Parent />);

    expect(selectedTab()).toBe(tab("Three"));
    tab("Three").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("status")).toHaveTextContent("one");
    expect(tab("One")).toHaveFocus();
  });

  it("SCRUM586_AC7_a_choice_no_longer_offered_shows_the_first_tab", () => {
    render(<Tabs label="Sections" tabs={TABS} selected="gone" onSelect={() => {}} />);

    expect(selectedTab()).toBe(tab("One"));
    expect(tab("One")).toHaveAttribute("tabindex", "0");
  });
});
