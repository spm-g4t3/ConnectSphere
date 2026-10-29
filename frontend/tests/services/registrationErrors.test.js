import { describe, it, expect } from "vitest";
import { registrationErrorMessage } from "../../src/services/registrationErrors";

describe("SCRUM43 registration failure messages", () => {
  it.each([
    ["ALREADY_REGISTERED", "You are already registered for this event."],
    ["EVENT_FULL", "Sorry, this event filled up before your registration went through. It is now full."],
    ["REGISTRATION_NOT_OPEN", "Registration has not opened yet."],
    ["REGISTRATION_CLOSED", "Registration has closed for this event."],
    ["EVENT_NOT_CONFIRMED", "Registration is only available for Confirmed events."],
    ["REGISTRATION_DISABLED", "Registration is disabled for this event."],
    ["EVENT_STARTED", "Registration is closed because the event has started."],
    ["REGISTRATION_DATES_MISSING", "Registration dates have not been configured for this event."],
  ])("SCRUM43_AC4_maps_the_backend_conflict_code_%s", (code, message) => {
    expect(registrationErrorMessage({ response: { status: 409, data: { code } } })).toBe(message);
  });

  it.each([
    [403, "Only Attendees can register for events."],
    [503, "Event registration is temporarily unavailable. Please try again later."],
  ])("SCRUM43_AC4_explains_authorisation_failure_%s", (status, message) => {
    expect(registrationErrorMessage({ response: { status } })).toBe(message);
  });

  it.each([400, 404, 409])("SCRUM43_AC4_preserves_a_safe_server_message_for_%s", (status) => {
    expect(registrationErrorMessage({ response: { status, data: { code: "unknown", error: "Event not found" } } })).toBe("Event not found");
  });

  it("SCRUM43_AC4_explains_a_network_failure", () => {
    expect(registrationErrorMessage({ code: "ERR_NETWORK" })).toBe("Could not reach the server. Check your connection and try again.");
  });

  it.each([
    undefined, null, new Error("Unexpected error"),
    { response: { status: 409 } },
    { response: { status: 409, data: { error: "   " } } },
    { response: { status: 409, data: { error: 123, code: "constructor" } } },
    { response: { status: 500, data: { error: "Private database details", code: "EVENT_FULL" } } },
  ])("SCRUM43_AC4_uses_existing_fallbacks_without_leaking_unexpected_details_%j", (error) => {
    expect(registrationErrorMessage(error)).toBeNull();
  });
});
