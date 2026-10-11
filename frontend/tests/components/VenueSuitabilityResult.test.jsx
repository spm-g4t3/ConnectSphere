// VenueSuitabilityResult.test.jsx
//
// SCRUM-191 (SCRUM-188 AC2). The read-only view of one suitability result:
// the verdict, all six criteria met or not with their detail, and the values
// that were checked, with labels from venueLookups.
//
// Timezone-proof: the checked period shows in Singapore time on every device,
// so the expected text is a Singapore literal.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import VenueSuitabilityResult from "../../src/components/VenueSuitabilityResult.jsx";

const CRITERIA = [
  { criterion: "Capacity", met: true, detail: "Capacity 200 ≥ expected attendance 80" },
  { criterion: "Operating hours", met: true, detail: "Open 08:00–22:00 on Wednesday" },
  { criterion: "Layout", met: true, detail: "Theatre is offered" },
  { criterion: "Accessibility", met: true, detail: "All requested features are provided" },
  { criterion: "Facilities", met: true, detail: "All requested facilities are provided" },
  { criterion: "Availability", met: true, detail: "No booking, hold or block overlaps the event" },
];

const CHECKED = {
  startsAt: "2026-11-11T10:00:00+08:00",
  endsAt: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 80,
  layout: "theatre",
  accessibility: ["step_free_entrance", "hearing_loop"],
  facilities: ["projector", "wifi"],
};

const SUITABLE = { suitable: true, criteria: CRITERIA, checked: CHECKED };

const UNSUITABLE = {
  suitable: false,
  criteria: CRITERIA.map((c) =>
    c.criterion === "Capacity"
      ? { ...c, met: false, detail: "Capacity 80 < expected attendance 150" }
      : c.criterion === "Availability"
        ? {
            ...c,
            met: false,
            detail: "Booked for Gala Dinner 09:15–12:45 including setup 45 min and turnaround 30 min",
            conflicts: [{ kind: "booking", id: "b9", eventName: "Gala Dinner" }],
          }
        : c,
  ),
  checked: CHECKED,
};

const criteriaItems = () =>
  within(screen.getByRole("list", { name: "Criteria" })).getAllByRole("listitem");

/** The <dd> for a term in "Checked against". */
function checkedValue(term) {
  return screen.getByText(term, { selector: "dt" }).nextElementSibling;
}

describe("SCRUM-191 the verdict (SCRUM188_AC2)", () => {
  it("SCRUM188_AC2_a_suitable_venue_says_suitable_as_a_status", () => {
    render(<VenueSuitabilityResult result={SUITABLE} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Suitable$/);
  });

  it("SCRUM188_AC2_an_unsuitable_venue_says_not_suitable", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Not suitable$/);
  });
});

describe("SCRUM-191 every criterion (SCRUM188_AC2)", () => {
  it("SCRUM188_AC2_all_six_criteria_show_in_order_with_their_detail", () => {
    render(<VenueSuitabilityResult result={SUITABLE} />);

    const items = criteriaItems();
    expect(items).toHaveLength(6);
    CRITERIA.forEach((criterion, i) => {
      expect(items[i]).toHaveTextContent("Met");
      expect(items[i]).toHaveTextContent(criterion.criterion);
      expect(items[i]).toHaveTextContent(criterion.detail);
    });
  });

  it("SCRUM188_AC2_unmet_criteria_say_not_met_and_met_ones_still_show", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} />);

    const items = criteriaItems();
    expect(items).toHaveLength(6);
    const byName = (name) => items.find((item) => item.textContent.includes(name));
    expect(within(byName("Capacity")).getByText("Not met")).toBeInTheDocument();
    expect(byName("Capacity")).toHaveTextContent("Capacity 80 < expected attendance 150");
    expect(within(byName("Layout")).getByText("Met")).toBeInTheDocument();
  });

  it("SCRUM188_AC2_unmet_availability_shows_the_servers_detail_and_no_extra_table", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} />);

    const availability = criteriaItems()[5];
    expect(within(availability).getByText("Not met")).toBeInTheDocument();
    expect(availability).toHaveTextContent(/Gala Dinner 09:15–12:45 including setup 45 min and turnaround 30 min/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("SCRUM-191 what was checked", () => {
  it("SCRUM188_AC2_shows_the_period_in_singapore_time_and_the_attendance", () => {
    render(<VenueSuitabilityResult result={SUITABLE} />);

    expect(checkedValue("When")).toHaveTextContent("2026-11-11 10:00 – 12:00 (Singapore time)");
    expect(checkedValue("Expected attendance")).toHaveTextContent("80");
  });

  it("SCRUM188_AC2_a_period_over_two_singapore_dates_names_both", () => {
    render(
      <VenueSuitabilityResult
        result={{ ...SUITABLE, checked: { ...CHECKED, endsAt: "2026-11-12T01:00:00+08:00" } }}
      />,
    );
    expect(checkedValue("When")).toHaveTextContent("2026-11-11 10:00 – 2026-11-12 01:00 (Singapore time)");
  });

  it("SCRUM188_AC2_codes_show_as_venueLookups_labels", () => {
    render(<VenueSuitabilityResult result={SUITABLE} />);

    expect(checkedValue("Layout")).toHaveTextContent("Theatre");
    expect(checkedValue("Accessibility features")).toHaveTextContent("Step-free entrance, Hearing loop");
    expect(checkedValue("Facilities")).toHaveTextContent("Projector, Wi-Fi");
  });

  it("SCRUM188_AC2_a_code_the_lookup_copy_does_not_know_shows_as_the_raw_code", () => {
    render(
      <VenueSuitabilityResult
        result={{
          ...SUITABLE,
          checked: { ...CHECKED, layout: "cabaret", accessibility: ["braille_signage"], facilities: ["wifi", "stage"] },
        }}
      />,
    );

    expect(checkedValue("Layout")).toHaveTextContent("cabaret");
    expect(checkedValue("Accessibility features")).toHaveTextContent("braille_signage");
    expect(checkedValue("Facilities")).toHaveTextContent("Wi-Fi, stage");
  });

  it("SCRUM188_AC2_nothing_requested_says_none_requested", () => {
    render(
      <VenueSuitabilityResult
        result={{ ...SUITABLE, checked: { ...CHECKED, layout: null, accessibility: [], facilities: [] } }}
      />,
    );

    expect(checkedValue("Layout")).toHaveTextContent("None requested");
    expect(checkedValue("Accessibility features")).toHaveTextContent("None requested");
    expect(checkedValue("Facilities")).toHaveTextContent("None requested");
  });
});

describe("SCRUM-188 AC7 overridden criteria", () => {
  it("SCRUM188_AC7_an_overridden_unmet_criterion_says_overridden_by_coordinator", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} overridden={["Capacity"]} />);

    const items = criteriaItems();
    expect(within(items[0]).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
    expect(items[0]).toHaveClass("venue-suitability__criterion--overridden");
    // Availability is unmet but not overridden: plain "Not met".
    expect(within(items[5]).getByText("Not met")).toBeInTheDocument();
    expect(items[5]).not.toHaveClass("venue-suitability__criterion--overridden");
  });

  it("SCRUM188_AC7_a_met_criterion_in_the_overridden_list_still_says_met", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} overridden={["Layout"]} />);

    expect(within(criteriaItems()[2]).getByText("Met")).toBeInTheDocument();
    expect(screen.queryByText(/overridden by coordinator/)).not.toBeInTheDocument();
  });

  it("SCRUM188_AC7_without_the_prop_the_output_is_unchanged", () => {
    const { container: without } = render(<VenueSuitabilityResult result={UNSUITABLE} />);
    const before = without.innerHTML;
    const { container: empty } = render(<VenueSuitabilityResult result={UNSUITABLE} overridden={[]} />);
    expect(empty.innerHTML).toBe(before);
    expect(before).not.toContain("overridden");
  });
});

// SCRUM-188 review fix F4 (AC2): criteria that carry their codes read as
// venueLookups labels; older stored results without them keep their detail.
describe("SCRUM-188 AC2 criterion codes read as labels", () => {
  function withCriterion(name, fields) {
    return {
      ...UNSUITABLE,
      criteria: CRITERIA.map((c) => (c.criterion === name ? { ...c, ...fields } : c)),
    };
  }
  const itemFor = (name) => criteriaItems().find((item) => item.textContent.includes(name));

  it("SCRUM188_AC2_a_met_layout_with_codes_reads_its_label_offered", () => {
    render(
      <VenueSuitabilityResult
        result={withCriterion("Layout", { met: true, detail: "Layout theatre offered", layout: "theatre", offers: ["theatre", "u_shape"] })}
      />,
    );
    expect(itemFor("Layout")).toHaveTextContent("Layout Theatre offered");
    expect(itemFor("Layout")).not.toHaveTextContent("theatre offered");
  });

  it("SCRUM188_AC2_an_unmet_layout_names_its_label_and_the_labels_on_offer", () => {
    render(
      <VenueSuitabilityResult
        result={withCriterion("Layout", {
          met: false,
          detail: "Layout banquet not offered (offers: classroom, u_shape)",
          layout: "banquet",
          offers: ["classroom", "u_shape"],
        })}
      />,
    );
    expect(itemFor("Layout")).toHaveTextContent("Layout Banquet not offered (offers: Classroom, U-Shape)");
    expect(itemFor("Layout")).not.toHaveTextContent("u_shape");
  });

  it("SCRUM188_AC2_an_unmet_layout_at_a_venue_offering_none_says_none", () => {
    render(
      <VenueSuitabilityResult
        result={withCriterion("Layout", { met: false, detail: "x", layout: "banquet", offers: [] })}
      />,
    );
    expect(itemFor("Layout")).toHaveTextContent("Layout Banquet not offered (offers: none)");
  });

  it("SCRUM188_AC2_no_layout_requested_keeps_the_detail", () => {
    render(
      <VenueSuitabilityResult
        result={withCriterion("Layout", { met: true, detail: "No layout requested", layout: null, offers: ["theatre"] })}
      />,
    );
    expect(itemFor("Layout")).toHaveTextContent("No layout requested");
  });

  it("SCRUM188_AC2_missing_accessibility_and_facilities_read_as_labels", () => {
    const result = {
      ...UNSUITABLE,
      criteria: CRITERIA.map((c) => {
        if (c.criterion === "Accessibility") {
          return { ...c, met: false, detail: "Missing: hearing_loop", missing: ["hearing_loop"], requested: ["hearing_loop", "lift_access"] };
        }
        if (c.criterion === "Facilities") {
          return { ...c, met: false, detail: "Missing: projector, wifi", missing: ["projector", "wifi"], requested: ["projector", "wifi"] };
        }
        return c;
      }),
    };
    render(<VenueSuitabilityResult result={result} />);

    expect(itemFor("Accessibility")).toHaveTextContent("Missing: Hearing loop");
    expect(itemFor("Accessibility")).not.toHaveTextContent("hearing_loop");
    expect(itemFor("Facilities")).toHaveTextContent("Missing: Projector, Wi-Fi");
  });

  it("SCRUM188_AC2_nothing_missing_keeps_the_detail", () => {
    render(
      <VenueSuitabilityResult
        result={withCriterion("Facilities", { met: true, missing: [], requested: ["wifi"] })}
      />,
    );
    expect(itemFor("Facilities")).toHaveTextContent("All requested facilities are provided");
  });

  it("SCRUM188_AC2_a_structured_code_the_lookup_copy_does_not_know_shows_as_itself", () => {
    const result = {
      ...UNSUITABLE,
      criteria: CRITERIA.map((c) => {
        if (c.criterion === "Layout") return { ...c, met: false, layout: "cabaret", offers: ["theatre", "stage_pit"] };
        if (c.criterion === "Facilities") return { ...c, met: false, missing: ["stage"], requested: ["stage"] };
        return c;
      }),
    };
    render(<VenueSuitabilityResult result={result} />);

    expect(itemFor("Layout")).toHaveTextContent("Layout cabaret not offered (offers: Theatre, stage_pit)");
    expect(itemFor("Facilities")).toHaveTextContent("Missing: stage");
  });

});

// F-AC5-01: the screen never defaults to or recomputes "Suitable".
describe("SCRUM-188 AC5 the verdict is the server's", () => {
  it.each([
    ["missing", { criteria: CRITERIA, checked: CHECKED }],
    ["the string true", { suitable: "true", criteria: CRITERIA, checked: CHECKED }],
    ["false with every criterion met", { suitable: false, criteria: CRITERIA, checked: CHECKED }],
  ])("SCRUM188_AC5_only_a_boolean_true_reads_suitable (%s)", (_label, result) => {
    render(<VenueSuitabilityResult result={result} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Not suitable$/);
  });
});

// SCRUM-188 review fix F8 (AC1): the verdict names the venue for a screen
// reader; it is visually hidden, the heading above already names it.
describe("SCRUM-188 AC1 the verdict names its venue", () => {
  it("SCRUM188_AC1_with_a_subject_the_status_reads_the_venue_and_verdict", () => {
    render(<VenueSuitabilityResult result={UNSUITABLE} subject="Hall A" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^Hall A: Not suitable$/);
    expect(within(status).getByText("Hall A:")).toHaveClass("visually-hidden");
  });
});
