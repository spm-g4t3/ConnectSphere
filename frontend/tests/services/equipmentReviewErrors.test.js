// equipmentReviewErrors.test.js
//
// SCRUM-296, for SCRUM-290. What the review screen says when the server refuses.

import { describe, it, expect } from "vitest";
import { isStaleRefusal, reviewErrorMessage } from "../../src/services/equipmentReviewErrors";

const fail = (status, data) => ({ response: { status, data } });

describe("reviewErrorMessage", () => {
  it("SCRUM290_AC1_errors_400_joins_each_detail", () => {
    const message = reviewErrorMessage(
      fail(400, { details: [{ field: "note", message: "is required" }, { field: "lines", message: "Projector needs a note" }] }),
    );
    expect(message).toBe("Note: is required. Projector needs a note");
  });

  it("SCRUM290_AC1_errors_400_without_details_uses_a_fixed_sentence", () => {
    expect(reviewErrorMessage(fail(400, {}))).toMatch(/not accepted/);
  });

  it("SCRUM290_AC1_errors_403_and_409_show_the_server_sentence", () => {
    expect(reviewErrorMessage(fail(409, { error: "Someone else took this over." }))).toBe("Someone else took this over.");
    expect(reviewErrorMessage(fail(403, { error: "You are not the reviewer." }))).toBe("You are not the reviewer.");
  });

  it("SCRUM290_AC1_errors_403_and_409_fall_back_when_the_body_is_empty", () => {
    expect(reviewErrorMessage(fail(409, {}))).toMatch(/changed since you opened it/);
    expect(reviewErrorMessage(fail(403, undefined))).toMatch(/reviewing this request/);
  });

  it("SCRUM290_AC1_errors_404_is_a_fixed_sentence", () => {
    expect(reviewErrorMessage(fail(404, { error: "Event request not found" }))).toMatch(/no longer exists/);
  });

  it("SCRUM290_AC1_errors_500_never_shows_the_server_text", () => {
    const message = reviewErrorMessage(fail(500, { error: "duplicate key value violates" }));
    expect(message).toBe("Something went wrong. Try again.");
    expect(reviewErrorMessage(new Error("Network Error"))).toBe("Something went wrong. Try again.");
  });

  it("SCRUM290_AC1_errors_only_403_404_409_are_stale_refusals", () => {
    expect([400, 403, 404, 409, 500].map((status) => isStaleRefusal(fail(status)))).toEqual([false, true, true, true, false]);
  });
});
