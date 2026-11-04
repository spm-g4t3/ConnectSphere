// DecisionOutcome.test.jsx
//
// SCRUM-19 AC10: a decided request names who decided it. The name is read from
// the assignment history, so a reply that arrives for a request this row no
// longer shows must not name, or fail for, the request it now shows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import DecisionOutcome from "../../src/components/DecisionOutcome.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getAssignmentHistory, getAssignmentHistoryForReview } from "../../src/services/eventRequestService";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
}));

const PRIYA = "44444444-4444-4444-8444-444444444444";
const OMAR = "66666666-6666-4666-8666-666666666666";

const first = {
  id: "event-1",
  decision: "rejected",
  decisionNote: "Clashes with exams.",
  decidedBy: PRIYA,
  decidedAt: "2026-01-15T09:00:00+08:00",
};
const second = { ...first, id: "event-2", decidedBy: OMAR };

// Lets the settled request's then, catch and finally all run.
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const historyNaming = (id, name) => [{ newCoordinatorId: id, newCoordinatorName: name }];

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: "someone-else" } });
  vi.mocked(getAssignmentHistory).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockReset();
});

describe("SCRUM19_AC10 a late name reply for a request no longer shown", () => {
  it("SCRUM19_AC10_a_late_name_for_the_previous_request_does_not_replace_the_current_decider", async () => {
    const late = deferred();
    vi.mocked(getAssignmentHistory)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(historyNaming(OMAR, "Omar Okafor"));
    const { rerender } = render(<DecisionOutcome request={first} view="organiser" />);

    rerender(<DecisionOutcome request={second} view="organiser" />);
    expect(getAssignmentHistory).toHaveBeenLastCalledWith("event-2");
    expect(await screen.findByText("Omar Okafor")).toBeInTheDocument();

    late.resolve(historyNaming(PRIYA, "Priya Nair"));
    await flush();

    expect(screen.getByText("Omar Okafor")).toBeInTheDocument();
    expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
  });

  it("SCRUM19_AC10_a_late_failure_for_the_previous_request_shows_no_error", async () => {
    const late = deferred();
    vi.mocked(getAssignmentHistory)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(historyNaming(OMAR, "Omar Okafor"));
    const { rerender } = render(<DecisionOutcome request={first} view="organiser" />);

    rerender(<DecisionOutcome request={second} view="organiser" />);
    expect(await screen.findByText("Omar Okafor")).toBeInTheDocument();

    late.reject(httpError(500));
    await flush();

    expect(screen.queryByText("The decider's name could not be loaded.")).not.toBeInTheDocument();
    expect(screen.getByText("Omar Okafor")).toBeInTheDocument();
  });
});
