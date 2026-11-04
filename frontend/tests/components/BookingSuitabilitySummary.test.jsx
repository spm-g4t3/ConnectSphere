// BookingSuitabilitySummary.test.jsx
//
// SCRUM-188 AC7. The suitability result attached to a booking request, as
// Venue Staff see it: the verdict when requested, the criteria the
// coordinator overrode, the full check behind a collapsed <details>, and a
// plain line when no result was recorded.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import BookingSuitabilitySummary from "../../src/components/BookingSuitabilitySummary.jsx";

const CHECKED = {
  startsAt: "2026-11-11T10:00:00+08:00",
  endsAt: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 150,
  layout: "theatre",
  accessibility: [],
  facilities: [],
};

const MET = [
  { criterion: "Capacity", met: true, detail: "Capacity 200 ≥ expected attendance 150" },
  { criterion: "Operating hours", met: true, detail: "Open 08:00–22:00 on Wednesday" },
  { criterion: "Layout", met: true, detail: "Theatre is offered" },
  { criterion: "Accessibility", met: true, detail: "All requested features are provided" },
  { criterion: "Facilities", met: true, detail: "All requested facilities are provided" },
  { criterion: "Availability", met: true, detail: "No booking, hold or block overlaps the event" },
];

const SUITABLE = { suitable: true, criteria: MET, checked: CHECKED };

const UNSUITABLE = {
  suitable: false,
  criteria: MET.map((c) =>
    c.criterion === "Capacity"
      ? { ...c, met: false, detail: "Capacity 80 < expected attendance 150" }
      : c.criterion === "Availability"
        ? { ...c, met: false, detail: "Booked for Gala Dinner 09:15–12:45" }
        : c,
  ),
  checked: CHECKED,
};

const criteriaItems = () =>
  within(screen.getByRole("list", { name: "Criteria" })).getAllByRole("listitem");
const itemFor = (name) => criteriaItems().find((item) => item.textContent.includes(name));

describe("SCRUM-188 AC7 the suitability result on a booking request", () => {
  it("SCRUM188_AC7_a_suitable_request_says_suitable_with_the_check_collapsed", () => {
    const { container } = render(
      <BookingSuitabilitySummary suitability={SUITABLE} suitabilityOverridden={false} overriddenCriteria={[]} />,
    );

    expect(screen.getByText(/Suitability when requested:/)).toHaveTextContent(
      "Suitability when requested: Suitable",
    );
    expect(screen.queryByText(/Requested despite not meeting/)).not.toBeInTheDocument();

    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Show the full check").tagName).toBe("SUMMARY");
    expect(within(details).getAllByRole("listitem")).toHaveLength(6);
  });

  it("SCRUM188_AC7_a_not_suitable_request_without_override_has_no_override_line", () => {
    render(
      <BookingSuitabilitySummary suitability={UNSUITABLE} suitabilityOverridden={false} overriddenCriteria={[]} />,
    );

    expect(screen.getByText(/Suitability when requested:/)).toHaveTextContent(
      "Suitability when requested: Not suitable",
    );
    expect(screen.queryByText(/Requested despite not meeting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/overridden by coordinator/)).not.toBeInTheDocument();
    expect(within(itemFor("Capacity")).getByText("Not met")).toBeInTheDocument();
  });

  it("SCRUM188_AC7_an_overridden_request_names_the_overridden_criteria_and_marks_their_rows", () => {
    render(
      <BookingSuitabilitySummary
        suitability={UNSUITABLE}
        suitabilityOverridden
        overriddenCriteria={["Capacity", "Availability"]}
      />,
    );

    expect(screen.getByText("Requested despite not meeting: Capacity, Availability")).toBeInTheDocument();
    expect(within(itemFor("Capacity")).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
    expect(within(itemFor("Availability")).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
    expect(within(itemFor("Layout")).getByText("Met")).toBeInTheDocument();
  });

  it("SCRUM188_AC7_overridden_flag_with_no_criteria_shows_no_override_line", () => {
    render(
      <BookingSuitabilitySummary suitability={UNSUITABLE} suitabilityOverridden overriddenCriteria={[]} />,
    );
    expect(screen.queryByText(/Requested despite not meeting/)).not.toBeInTheDocument();
  });

  it("SCRUM188_AC7_no_recorded_result_says_so_and_shows_no_check", () => {
    const { container } = render(
      <BookingSuitabilitySummary suitability={null} suitabilityOverridden={false} overriddenCriteria={[]} />,
    );

    expect(screen.getByText("No suitability result was recorded for this request.")).toBeInTheDocument();
    expect(screen.queryByText(/Suitability when requested/)).not.toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
  });
});
