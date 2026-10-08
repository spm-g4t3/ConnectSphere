// VenueSafetyFacts.test.jsx
//
// SCRUM-493 sub-task 3. The shared, read-only rendering of one venue's safety
// facts (emergency access and known restrictions). VenueDetail uses it now;
// SCRUM-490's Safety Officer review will mount one per booked venue with
// <VenueSafetyFacts {...venue} venueName={venue.name} />. Presentational only,
// so nothing is mocked.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import VenueSafetyFacts from "../../src/components/VenueSafetyFacts.jsx";

const MUTED = "venue-safety-facts__not-recorded";

/** The <dd> that follows the <dt> with this label, inside `scope`. */
function valueOf(label, scope = screen) {
  const dt = scope.getByText(label, { selector: "dt" });
  const dd = dt.nextElementSibling;
  expect(dd?.tagName).toBe("DD");
  return dd;
}

describe("VenueSafetyFacts", () => {
  it("SCRUM493_AC3_shows_both_labels_and_values_with_line_breaks_kept", () => {
    render(
      <VenueSafetyFacts
        emergencyAccess={"Exit A via the east stairwell\nAssembly point: car park B"}
        knownRestrictions={"No open flames\nNo rigging from the ceiling"}
      />,
    );

    expect(screen.getByText("Emergency access", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Known restrictions", { selector: "dt" })).toBeInTheDocument();
    expect(valueOf("Emergency access").textContent).toBe(
      "Exit A via the east stairwell\nAssembly point: car park B",
    );
    expect(valueOf("Known restrictions").textContent).toBe(
      "No open flames\nNo rigging from the ceiling",
    );
    expect(valueOf("Emergency access")).not.toHaveClass(MUTED);
    expect(valueOf("Known restrictions")).not.toHaveClass(MUTED);
  });

  it("SCRUM493_AC3_is_read_only_with_no_controls_or_editable_elements", () => {
    const { container } = render(
      <VenueSafetyFacts
        emergencyAccess="Exit A"
        knownRestrictions="No open flames"
        venueName="Hall A"
      />,
    );

    for (const role of ["textbox", "button", "link", "checkbox", "combobox"]) {
      expect(screen.queryAllByRole(role)).toHaveLength(0);
    }
    expect(container.querySelectorAll("[contenteditable], input, textarea, select")).toHaveLength(0);
  });

  describe.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   \n\t "],
    ["invisible-only", " \u200B\u2060\uFEFF\u00AD \u2800\u3164 "],
  ])("SCRUM493_AC2 when a fact is %s", (_case, empty) => {
    it(`SCRUM493_AC2_emergency_access_${_case}_reads_not_recorded_muted_while_restrictions_shows`, () => {
      render(<VenueSafetyFacts emergencyAccess={empty} knownRestrictions="No open flames" />);

      expect(valueOf("Emergency access")).toHaveTextContent("Not recorded");
      expect(valueOf("Emergency access")).toHaveClass(MUTED);
      expect(valueOf("Known restrictions").textContent).toBe("No open flames");
      expect(valueOf("Known restrictions")).not.toHaveClass(MUTED);
    });

    it(`SCRUM493_AC2_known_restrictions_${_case}_reads_not_recorded_muted_while_access_shows`, () => {
      render(<VenueSafetyFacts emergencyAccess="Exit A" knownRestrictions={empty} />);

      expect(valueOf("Known restrictions")).toHaveTextContent("Not recorded");
      expect(valueOf("Known restrictions")).toHaveClass(MUTED);
      expect(valueOf("Emergency access").textContent).toBe("Exit A");
      expect(valueOf("Emergency access")).not.toHaveClass(MUTED);
    });

    it(`SCRUM493_AC2_both_${_case}_read_not_recorded_muted`, () => {
      render(<VenueSafetyFacts emergencyAccess={empty} knownRestrictions={empty} />);

      for (const label of ["Emergency access", "Known restrictions"]) {
        expect(valueOf(label).textContent).toBe("Not recorded");
        expect(valueOf(label)).toHaveClass(MUTED);
      }
    });
  });

  it("SCRUM493_AC2_both_props_omitted_read_not_recorded_muted", () => {
    render(<VenueSafetyFacts />);

    for (const label of ["Emergency access", "Known restrictions"]) {
      expect(valueOf(label).textContent).toBe("Not recorded");
      expect(valueOf(label)).toHaveClass(MUTED);
    }
  });

  it("SCRUM493_AC2_entered_text_reading_not_recorded_is_not_muted", () => {
    render(<VenueSafetyFacts emergencyAccess="Not recorded" knownRestrictions={null} />);

    expect(valueOf("Emergency access").textContent).toBe("Not recorded");
    expect(valueOf("Emergency access")).not.toHaveClass(MUTED);
    expect(valueOf("Known restrictions")).toHaveClass(MUTED);
  });

  describe("venueName and headingLevel", () => {
    it("SCRUM493_AC3_venue_name_renders_an_h4_by_default_and_names_the_section", () => {
      render(<VenueSafetyFacts emergencyAccess="Exit A" venueName="Hall A" />);

      const heading = screen.getByRole("heading", { name: "Hall A" });
      expect(heading.tagName).toBe("H4");
      expect(heading).toHaveClass("venue-safety-facts__heading");

      const region = screen.getByRole("region", { name: "Hall A" });
      expect(region).toContainElement(heading);
      expect(region).toHaveAttribute("aria-labelledby", heading.id);
      expect(within(region).getByText("Emergency access", { selector: "dt" })).toBeInTheDocument();
    });

    it.each([
      [2, "H2"],
      [6, "H6"],
      ["3", "H3"],
      [1, "H2"],
      [0, "H2"],
      [-5, "H2"],
      [7, "H6"],
      [99, "H6"],
      [4.6, "H5"],
      ["abc", "H4"],
      [NaN, "H4"],
      [Infinity, "H4"],
      [null, "H2"],
    ])("SCRUM493_AC3_heading_level_%s_renders_%s", (level, tag) => {
      render(<VenueSafetyFacts venueName="Hall A" headingLevel={level} />);

      const heading = screen.getByRole("heading", { name: "Hall A" });
      expect(heading.tagName).toBe(tag);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["blank", "   "],
    ])("SCRUM493_AC3_no_heading_and_generic_name_when_venue_name_is_%s", (_case, venueName) => {
      const { container } = render(<VenueSafetyFacts emergencyAccess="Exit A" venueName={venueName} />);

      expect(screen.queryAllByRole("heading")).toHaveLength(0);
      // No name, so no region: a plain container (VenueDetail's own
      // "Safety information" section names it there).
      expect(screen.queryAllByRole("region")).toHaveLength(0);
      const root = container.firstElementChild;
      expect(root.tagName).toBe("DIV");
      expect(root).toHaveClass("venue-safety-facts");
      expect(root).not.toHaveAttribute("aria-label");
      expect(root).not.toHaveAttribute("aria-labelledby");
      expect(within(root).getByText("Emergency access", { selector: "dt" })).toBeInTheDocument();
    });
  });

  // Review fix: named by the visible heading (aria-labelledby), not a
  // separate aria-label, and no region at all without a name.
  it("SCRUM493_AC3_region_accessible_name_is_its_heading_via_aria_labelledby", () => {
    render(<VenueSafetyFacts emergencyAccess="Exit A" venueName="Hall A" />);

    const region = screen.getByRole("region");
    const heading = within(region).getByRole("heading", { name: "Hall A" });
    expect(heading.id).not.toBe("");
    expect(region).toHaveAttribute("aria-labelledby", heading.id);
    expect(document.getElementById(region.getAttribute("aria-labelledby"))).toBe(heading);
    expect(region).not.toHaveAttribute("aria-label");
    expect(region).toHaveAccessibleName("Hall A");
  });

  it("SCRUM493_AC3_two_named_instances_get_distinct_heading_ids", () => {
    render(
      <>
        <VenueSafetyFacts venueName="Hall A" />
        <VenueSafetyFacts venueName="Room 101" />
      </>,
    );

    const [a, b] = screen.getAllByRole("region");
    expect(a.getAttribute("aria-labelledby")).not.toBe(b.getAttribute("aria-labelledby"));
    expect(a).toHaveAccessibleName("Hall A");
    expect(b).toHaveAccessibleName("Room 101");
  });

  it("SCRUM493_AC3_without_a_venue_name_there_is_no_region_role", () => {
    const { container } = render(<VenueSafetyFacts emergencyAccess="Exit A" />);

    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelector("[aria-labelledby], [aria-label], [role]")).toBeNull();
  });

  it("SCRUM493_AC3_several_booked_venues_render_independently", () => {
    render(
      <>
        <VenueSafetyFacts
          venueName="Hall A"
          emergencyAccess={"Exit A\nAssembly: car park B"}
          knownRestrictions={null}
        />
        <VenueSafetyFacts
          venueName="Room 101"
          emergencyAccess=""
          knownRestrictions="No amplified sound after 10pm"
        />
        <VenueSafetyFacts venueName="Atrium" />
      </>,
    );

    expect(screen.getAllByRole("region")).toHaveLength(3);

    const hall = screen.getByRole("region", { name: "Hall A" });
    expect(valueOf("Emergency access", within(hall)).textContent).toBe("Exit A\nAssembly: car park B");
    expect(valueOf("Emergency access", within(hall))).not.toHaveClass(MUTED);
    expect(valueOf("Known restrictions", within(hall))).toHaveClass(MUTED);
    expect(within(hall).getByRole("heading").textContent).toBe("Hall A");

    const room = screen.getByRole("region", { name: "Room 101" });
    expect(valueOf("Emergency access", within(room))).toHaveClass(MUTED);
    expect(valueOf("Known restrictions", within(room)).textContent).toBe(
      "No amplified sound after 10pm",
    );
    expect(valueOf("Known restrictions", within(room))).not.toHaveClass(MUTED);
    expect(within(room).getByRole("heading").textContent).toBe("Room 101");

    const atrium = screen.getByRole("region", { name: "Atrium" });
    for (const label of ["Emergency access", "Known restrictions"]) {
      expect(valueOf(label, within(atrium))).toHaveClass(MUTED);
    }
  });

  it("SCRUM493_AC3_accepts_props_spread_from_a_full_venue_object", () => {
    // The shape getVenueDetails returns; SCRUM-490 will spread it straight in.
    const venue = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      name: "Hall A",
      location: "Level 2",
      capacity: 120,
      setupMinutes: 30,
      turnaroundMinutes: 15,
      emergencyAccess: "Exit A via the east stairwell",
      knownRestrictions: "No open flames",
      createdAt: "2026-09-01T09:00:00+08:00",
      updatedAt: "2026-09-02T09:00:00+08:00",
    };

    const { container } = render(<VenueSafetyFacts {...venue} venueName={venue.name} />);

    const region = screen.getByRole("region", { name: "Hall A" });
    expect(valueOf("Emergency access", within(region)).textContent).toBe(
      "Exit A via the east stairwell",
    );
    expect(valueOf("Known restrictions", within(region)).textContent).toBe("No open flames");
    // Unrelated venue fields are not rendered or forwarded onto the DOM.
    expect(container.textContent).not.toContain("Level 2");
    expect(container.textContent).not.toContain("120");
    expect(region).not.toHaveAttribute("id");
    expect(region).not.toHaveAttribute("name");
  });
});
