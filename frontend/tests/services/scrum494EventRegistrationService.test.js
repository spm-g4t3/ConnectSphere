// scrum494EventRegistrationService.test.js
//
// SCRUM-494: reading and saving an event's registration settings. apiClient is
// mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), put: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.put).mockReset();
});

describe("SCRUM494 registration settings service", () => {
  it("SCRUM494_AC6_the_current_settings_are_read_from_the_events_settings", async () => {
    const settings = { registrationEnabled: true, capacity: 50 };
    vi.mocked(apiClient.get).mockResolvedValue({ data: settings });

    await expect(getRegistrationSettings(EVENT_ID)).resolves.toBe(settings);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/registration/events/${EVENT_ID}/settings`);
  });

  it("SCRUM494_AC2_saving_puts_the_whole_settings_object", async () => {
    const settings = { registrationEnabled: true, capacity: 50, opensAt: "2026-12-01T09:00:00+08:00" };
    vi.mocked(apiClient.put).mockResolvedValue({ data: settings });

    await expect(saveRegistrationSettings(EVENT_ID, settings)).resolves.toBe(settings);
    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith(`/registration/events/${EVENT_ID}/settings`, settings);
  });
});
