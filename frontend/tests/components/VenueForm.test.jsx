// VenueForm.test.jsx
//
// SCRUM-186. The turnaround select on the venue form: what it offers, what it
// prefills, and what create and edit send. The venue service is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueForm from "../../src/components/VenueForm.jsx";
import { createVenue, getVenueDetails, updateVenue } from "../../src/services/venueService";

vi.mock("../../src/services/venueService", () => ({
  createVenue: vi.fn(),
  getVenueDetails: vi.fn(),
  updateVenue: vi.fn(),
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

// Hours in the server's "HH:MM:SS" shape so a name-only edit does not re-send
// them.
function savedVenue(overrides = {}) {
  return {
    id: VENUE_ID,
    name: "Hall A",
    location: "Level 2",
    maxCapacity: 100,
    layouts: ["theatre"],
    accessibility: [],
    facilities: ["wifi"],
    hours: [{ day_of_week: 1, opens_at: "09:00:00", closes_at: "18:00:00" }],
    turnaroundMinutes: 90,
    ...overrides,
  };
}

function turnaroundSelect() {
  return screen.getByLabelText("Turnaround between events");
}

function selectedLabel(select) {
  return select.options[select.selectedIndex].textContent;
}

beforeEach(() => {
  vi.mocked(createVenue).mockReset();
  vi.mocked(getVenueDetails).mockReset();
  vi.mocked(updateVenue).mockReset();
  vi.mocked(createVenue).mockResolvedValue({ id: VENUE_ID });
  vi.mocked(updateVenue).mockResolvedValue({ id: VENUE_ID });
});

describe("SCRUM186 VenueForm turnaround on create", () => {
  it("SCRUM186_create_offers_seven_options_with_none_selected", () => {
    render(<VenueForm />);

    const select = turnaroundSelect();
    expect(select.tagName).toBe("SELECT");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "None",
      "15 minutes",
      "30 minutes",
      "45 minutes",
      "1 hour",
      "1 hour 30 minutes",
      "2 hours",
    ]);
    expect(options.map((o) => o.value)).toEqual(["0", "15", "30", "45", "60", "90", "120"]);
    expect(select).toHaveValue("0");
    expect(selectedLabel(select)).toBe("None");
  });

  it("SCRUM186_the_help_text_describes_the_select", () => {
    render(<VenueForm />);

    // SCRUM-137 reworded this when setup got its own field: turnaround is now
    // only the reset after an event, not "set-up and clear-down".
    expect(turnaroundSelect()).toHaveAccessibleDescription(
      "Time Venue Staff need to reset the room after an event ends.",
    );
  });

  it("SCRUM186_create_sends_the_chosen_turnaround_as_a_number", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<VenueForm onSaved={onSaved} />);

    await user.selectOptions(turnaroundSelect(), "1 hour");
    expect(turnaroundSelect()).toHaveValue("60");
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(createVenue).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(createVenue).mock.calls[0][0];
    expect(payload.turnaroundMinutes).toBe(60);
    expect(typeof payload.turnaroundMinutes).toBe("number");
    expect(onSaved).toHaveBeenCalledWith({ id: VENUE_ID });
  });

  it("SCRUM186_create_untouched_sends_zero", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(createVenue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createVenue).mock.calls[0][0].turnaroundMinutes).toBe(0);
  });

  it("SCRUM186_server_400_turnaround_detail_is_displayed", async () => {
    const user = userEvent.setup();
    vi.mocked(createVenue).mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: "Validation failed",
          details: [
            {
              field: "turnaroundMinutes",
              message: "must be one of 0, 15, 30, 45, 60, 90, 120",
            },
          ],
        },
      },
    });
    render(<VenueForm />);

    await user.click(screen.getByRole("button", { name: "Create venue" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This venue can't be saved yet:");
    expect(
      within(alert).getByText("turnaroundMinutes: must be one of 0, 15, 30, 45, 60, 90, 120"),
    ).toBeInTheDocument();
  });
});

describe("SCRUM186 VenueForm turnaround on edit", () => {
  it("SCRUM186_edit_prefills_the_saved_turnaround", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    render(<VenueForm venueId={VENUE_ID} />);

    await screen.findByRole("heading", { name: "Edit venue" });
    expect(getVenueDetails).toHaveBeenCalledWith(VENUE_ID);
    const select = turnaroundSelect();
    expect(select).toHaveValue("90");
    expect(selectedLabel(select)).toBe("1 hour 30 minutes");
    expect(within(select).getAllByRole("option")).toHaveLength(7);
  });

  it("SCRUM186_edit_changing_only_turnaround_sends_only_turnaround", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(turnaroundSelect(), "2 hours");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { turnaroundMinutes: 120 });
  });

  it("SCRUM186_edit_setting_turnaround_back_to_none_sends_zero", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(turnaroundSelect(), "None");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { turnaroundMinutes: 0 });
  });

  it("SCRUM186_edit_changing_only_name_sends_no_turnaround", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Hall B");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { name: "Hall B" });
  });

  it("SCRUM186_edit_changing_turnaround_and_back_is_nothing_changed", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(turnaroundSelect(), "15 minutes");
    await user.selectOptions(turnaroundSelect(), "1 hour 30 minutes");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing has changed, so there is nothing to save.",
    );
    expect(updateVenue).not.toHaveBeenCalled();
  });

  it("SCRUM186_edit_saved_unlisted_value_is_shown_and_untouched_save_sends_nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 75 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const select = turnaroundSelect();
    expect(within(select).getAllByRole("option")).toHaveLength(8);
    expect(select).toHaveValue("75");
    expect(selectedLabel(select)).toBe("1 hour 15 minutes (not in this form's list)");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing has changed");
    expect(updateVenue).not.toHaveBeenCalled();
  });

  it("SCRUM186_edit_unlisted_value_keeps_its_option_after_choosing_a_listed_one", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 75 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(turnaroundSelect(), "1 hour");
    expect(within(turnaroundSelect()).getAllByRole("option")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { turnaroundMinutes: 60 });
  });

  it("SCRUM186_edit_field_missing_from_server_shows_none_and_name_save_sends_no_turnaround", async () => {
    const user = userEvent.setup();
    const venue = savedVenue();
    delete venue.turnaroundMinutes;
    vi.mocked(getVenueDetails).mockResolvedValue(venue);
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const select = turnaroundSelect();
    expect(select).toHaveValue("0");
    expect(selectedLabel(select)).toBe("None");
    expect(within(select).getAllByRole("option")).toHaveLength(7);

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Hall B");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(updateVenue).mock.calls[0][1];
    expect(payload).toEqual({ name: "Hall B" });
    expect(payload).not.toHaveProperty("turnaroundMinutes");
  });

  it("SCRUM186_edit_saved_zero_prefills_none", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 0 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    expect(turnaroundSelect()).toHaveValue("0");
    expect(selectedLabel(turnaroundSelect())).toBe("None");
  });

  it("SCRUM186_edit_server_400_turnaround_detail_is_displayed", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ turnaroundMinutes: 90 }));
    vi.mocked(updateVenue).mockRejectedValue({
      response: {
        status: 400,
        data: {
          details: [{ field: "turnaroundMinutes", message: "must be one of the allowed values" }],
        },
      },
    });
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(turnaroundSelect(), "2 hours");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("turnaroundMinutes: must be one of the allowed values"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SCRUM-137 (SCRUM-20): the setup time before an event, a select of its own
// beside turnaround.
// ---------------------------------------------------------------------------
function setupSelect() {
  return screen.getByLabelText("Setup before events");
}

describe("SCRUM20_SCRUM137 VenueForm setup on create", () => {
  it("SCRUM20_SCRUM137_create_offers_seven_options_with_none_selected", () => {
    render(<VenueForm />);

    const select = setupSelect();
    expect(select.tagName).toBe("SELECT");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "None",
      "15 minutes",
      "30 minutes",
      "45 minutes",
      "1 hour",
      "1 hour 30 minutes",
      "2 hours",
    ]);
    expect(options.map((o) => o.value)).toEqual(["0", "15", "30", "45", "60", "90", "120"]);
    expect(select).toHaveValue("0");
    expect(selectedLabel(select)).toBe("None");
  });

  it("SCRUM20_SCRUM137_setup_is_a_different_control_from_turnaround_and_comes_first", () => {
    render(<VenueForm />);

    const setup = setupSelect();
    const turnaround = turnaroundSelect();
    expect(setup).not.toBe(turnaround);
    // Before the event, then after it.
    expect(
      setup.compareDocumentPosition(turnaround) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("SCRUM20_SCRUM137_the_help_text_describes_the_select", () => {
    render(<VenueForm />);

    const select = setupSelect();
    const helpId = select.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId)).toHaveTextContent(
      "Time Venue Staff need to prepare the room before an event starts.",
    );
    expect(select).toHaveAccessibleDescription(
      "Time Venue Staff need to prepare the room before an event starts.",
    );
    // Its own help, not turnaround's.
    expect(helpId).not.toBe(turnaroundSelect().getAttribute("aria-describedby"));
  });

  it("SCRUM20_SCRUM137_create_sends_the_chosen_setup_as_a_number", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<VenueForm onSaved={onSaved} />);

    await user.selectOptions(setupSelect(), "30 minutes");
    expect(setupSelect()).toHaveValue("30");
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(createVenue).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(createVenue).mock.calls[0][0];
    expect(payload.setupMinutes).toBe(30);
    expect(typeof payload.setupMinutes).toBe("number");
    // Choosing setup leaves turnaround at its own default.
    expect(payload.turnaroundMinutes).toBe(0);
    expect(onSaved).toHaveBeenCalledWith({ id: VENUE_ID });
  });

  it("SCRUM20_SCRUM137_create_sends_setup_and_turnaround_independently", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    await user.selectOptions(setupSelect(), "15 minutes");
    await user.selectOptions(turnaroundSelect(), "2 hours");
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    const payload = vi.mocked(createVenue).mock.calls[0][0];
    expect(payload.setupMinutes).toBe(15);
    expect(payload.turnaroundMinutes).toBe(120);
  });

  it("SCRUM20_SCRUM137_create_untouched_sends_zero", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(createVenue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createVenue).mock.calls[0][0].setupMinutes).toBe(0);
  });

  it("SCRUM20_SCRUM137_the_select_is_disabled_while_saving", async () => {
    const user = userEvent.setup();
    let finish;
    vi.mocked(createVenue).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<VenueForm />);

    expect(setupSelect()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(setupSelect()).toBeDisabled();
    finish({ id: VENUE_ID });
    await vi.waitFor(() => expect(setupSelect()).toBeEnabled());
  });

  it("SCRUM20_SCRUM137_server_400_setup_detail_is_displayed", async () => {
    const user = userEvent.setup();
    vi.mocked(createVenue).mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: "Validation failed",
          details: [
            { field: "setupMinutes", message: "must be one of 0, 15, 30, 45, 60, 90, 120 minutes" },
          ],
        },
      },
    });
    render(<VenueForm />);

    await user.click(screen.getByRole("button", { name: "Create venue" }));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("setupMinutes: must be one of 0, 15, 30, 45, 60, 90, 120 minutes"),
    ).toBeInTheDocument();
  });
});

describe("SCRUM20_SCRUM137 VenueForm setup on edit", () => {
  it("SCRUM20_SCRUM137_edit_prefills_the_saved_setup", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 45 }));
    render(<VenueForm venueId={VENUE_ID} />);

    await screen.findByRole("heading", { name: "Edit venue" });
    const select = setupSelect();
    expect(select).toHaveValue("45");
    expect(selectedLabel(select)).toBe("45 minutes");
    expect(within(select).getAllByRole("option")).toHaveLength(7);
    // Turnaround still prefills from its own field.
    expect(turnaroundSelect()).toHaveValue("90");
  });

  it("SCRUM20_SCRUM137_edit_saved_zero_prefills_none", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 0 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    expect(setupSelect()).toHaveValue("0");
    expect(selectedLabel(setupSelect())).toBe("None");
  });

  it("SCRUM20_SCRUM137_edit_changing_only_setup_sends_only_setup", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 0 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "1 hour");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { setupMinutes: 60 });
  });

  it("SCRUM20_SCRUM137_edit_setting_setup_back_to_none_sends_zero", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 30 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "None");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { setupMinutes: 0 });
  });

  it("SCRUM20_SCRUM137_edit_changing_only_name_sends_no_setup", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 30 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Hall B");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { name: "Hall B" });
  });

  it("SCRUM20_SCRUM137_edit_changing_setup_and_back_is_nothing_changed", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 30 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "2 hours");
    await user.selectOptions(setupSelect(), "30 minutes");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing has changed, so there is nothing to save.",
    );
    expect(updateVenue).not.toHaveBeenCalled();
  });

  it("SCRUM20_SCRUM137_edit_changing_setup_and_turnaround_sends_both", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 0 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "15 minutes");
    await user.selectOptions(turnaroundSelect(), "None");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, {
      setupMinutes: 15,
      turnaroundMinutes: 0,
    });
  });

  it("SCRUM20_SCRUM137_edit_saved_unlisted_value_is_shown_and_untouched_save_sends_nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 20 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const select = setupSelect();
    expect(within(select).getAllByRole("option")).toHaveLength(8);
    expect(select).toHaveValue("20");
    expect(selectedLabel(select)).toBe("20 minutes (not in this form's list)");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing has changed");
    expect(updateVenue).not.toHaveBeenCalled();
  });

  it("SCRUM20_SCRUM137_edit_unlisted_value_keeps_its_option_after_choosing_a_listed_one", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 20 }));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "15 minutes");
    expect(within(setupSelect()).getAllByRole("option")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { setupMinutes: 15 });
  });

  it("SCRUM20_SCRUM137_edit_field_missing_from_server_shows_none_and_name_save_sends_no_setup", async () => {
    // A backend from before 023 omits setupMinutes. savedVenue() has none.
    const user = userEvent.setup();
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue());
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    const select = setupSelect();
    expect(select).toHaveValue("0");
    expect(selectedLabel(select)).toBe("None");
    expect(within(select).getAllByRole("option")).toHaveLength(7);

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Hall B");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = vi.mocked(updateVenue).mock.calls[0][1];
    expect(payload).toEqual({ name: "Hall B" });
    expect(payload).not.toHaveProperty("setupMinutes");
  });

  it("SCRUM20_SCRUM137_edit_the_select_is_disabled_while_saving", async () => {
    const user = userEvent.setup();
    let finish;
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue({ setupMinutes: 0 }));
    vi.mocked(updateVenue).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });

    await user.selectOptions(setupSelect(), "30 minutes");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(setupSelect()).toBeDisabled();
    finish({ id: VENUE_ID });
    await vi.waitFor(() => expect(setupSelect()).toBeEnabled());
  });
});

// SCRUM-493. Emergency access and known restrictions: two optional textareas
// with a code-point counter. Create leaves empty boxes out; edit sends only a
// changed field, and null to clear a recorded one.
describe("SCRUM493 VenueForm safety facts", () => {
  const emergencyBox = () => screen.getByRole("textbox", { name: "Emergency access" });
  const restrictionsBox = () => screen.getByRole("textbox", { name: "Known restrictions" });

  /** The help line (and so the counter) the textarea is described by. */
  function helpLineFor(textarea) {
    const id = textarea.getAttribute("aria-describedby");
    return document.getElementById(id);
  }

  async function renderEdit(overrides = {}) {
    vi.mocked(getVenueDetails).mockResolvedValue(savedVenue(overrides));
    render(<VenueForm venueId={VENUE_ID} />);
    await screen.findByRole("heading", { name: "Edit venue" });
  }

  it("SCRUM493_AC1_create_sends_trimmed_text_for_both_fields", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    await user.type(emergencyBox(), "  Exit A via the east stairwell  ");
    await user.type(restrictionsBox(), " No open flames ");
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    expect(createVenue).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(createVenue).mock.calls[0][0];
    expect(payload.emergencyAccess).toBe("Exit A via the east stairwell");
    expect(payload.knownRestrictions).toBe("No open flames");
  });

  it("SCRUM493_AC1_create_leaves_out_empty_and_whitespace_boxes", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    await user.type(restrictionsBox(), "   ");
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    const payload = vi.mocked(createVenue).mock.calls[0][0];
    expect(payload.emergencyAccess).toBeUndefined();
    expect(payload.knownRestrictions).toBeUndefined();
    // Gone from the wire, not sent as "".
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("emergencyAccess");
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("knownRestrictions");
  });

  it("SCRUM493_AC1_edit_prefills_both_fields", async () => {
    await renderEdit({
      emergencyAccess: "Exit A\nExit B",
      knownRestrictions: "No confetti",
    });

    expect(emergencyBox()).toHaveValue("Exit A\nExit B");
    expect(restrictionsBox()).toHaveValue("No confetti");
  });

  it("SCRUM493_AC1_edit_prefills_empty_from_null_and_from_an_older_payload", async () => {
    await renderEdit({ emergencyAccess: null });
    expect(emergencyBox()).toHaveValue("");
    // savedVenue() has no knownRestrictions key at all.
    expect(restrictionsBox()).toHaveValue("");
  });

  it("SCRUM493_AC4_changing_only_emergency_access_sends_only_that_field", async () => {
    const user = userEvent.setup();
    await renderEdit({ emergencyAccess: "Exit A", knownRestrictions: "No confetti" });

    await user.clear(emergencyBox());
    await user.type(emergencyBox(), "  Exit B via the car park  ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, {
      emergencyAccess: "Exit B via the car park",
    });
  });

  it("SCRUM493_AC4_clearing_a_recorded_field_sends_null", async () => {
    const user = userEvent.setup();
    await renderEdit({ emergencyAccess: "Exit A", knownRestrictions: "No confetti" });

    await user.clear(restrictionsBox());
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenue).toHaveBeenCalledTimes(1);
    expect(updateVenue).toHaveBeenCalledWith(VENUE_ID, { knownRestrictions: null });
  });

  it("SCRUM493_AC4_whitespace_in_an_unrecorded_field_is_nothing_changed", async () => {
    const user = userEvent.setup();
    await renderEdit({ emergencyAccess: null, knownRestrictions: null });

    await user.type(emergencyBox(), "   ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing has changed, so there is nothing to save.",
    );
    expect(updateVenue).not.toHaveBeenCalled();
  });

  it("SCRUM493_AC1_the_counter_counts_code_points", async () => {
    const user = userEvent.setup();
    render(<VenueForm />);

    const counter = () => helpLineFor(emergencyBox()).querySelector(".venue-form__counter");
    expect(counter()).toHaveTextContent("0/2000");

    await user.type(emergencyBox(), "Exit 🚪");
    expect(emergencyBox().value.length).toBe(7);
    expect(counter()).toHaveTextContent("6/2000");
    expect(counter()).not.toHaveClass("venue-form__counter--over");
  });

  it("SCRUM493_AC1_the_counter_turns_over_only_above_2000", () => {
    render(<VenueForm />);
    const counter = () => helpLineFor(restrictionsBox()).querySelector(".venue-form__counter");

    // 2,000 emoji: 4,000 UTF-16 units but exactly at the limit in code points.
    fireEvent.change(restrictionsBox(), { target: { value: "🚪".repeat(2000) } });
    expect(counter()).toHaveTextContent("2000/2000");
    expect(counter()).not.toHaveClass("venue-form__counter--over");

    fireEvent.change(restrictionsBox(), { target: { value: "a".repeat(2001) } });
    expect(counter()).toHaveTextContent("2001/2000");
    expect(counter()).toHaveClass("venue-form__counter", "venue-form__counter--over");
  });

  it("SCRUM493_AC1_server_400_emergency_access_detail_is_listed", async () => {
    const user = userEvent.setup();
    vi.mocked(createVenue).mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: "Validation failed",
          details: [{ field: "emergencyAccess", message: "must be 2000 characters or fewer" }],
        },
      },
    });
    render(<VenueForm />);

    fireEvent.change(emergencyBox(), { target: { value: "a".repeat(2001) } });
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This venue can't be saved yet:");
    expect(
      within(alert).getByText("emergencyAccess: must be 2000 characters or fewer"),
    ).toBeInTheDocument();
  });

  it("SCRUM493_AC1_each_textarea_is_described_by_its_help_line", () => {
    render(<VenueForm />);

    const emergency = emergencyBox();
    const restrictions = restrictionsBox();
    expect(emergency.tagName).toBe("TEXTAREA");
    expect(restrictions.tagName).toBe("TEXTAREA");
    expect(emergency.getAttribute("aria-describedby")).not.toBe(
      restrictions.getAttribute("aria-describedby"),
    );

    const emergencyHelp = helpLineFor(emergency);
    expect(emergencyHelp).toHaveClass("venue-form__help");
    expect(emergencyHelp).toHaveTextContent("Exits, routes and assembly points.");
    expect(emergency).toHaveAccessibleDescription("Exits, routes and assembly points. 0/2000");

    const restrictionsHelp = helpLineFor(restrictions);
    expect(restrictionsHelp).toHaveTextContent(
      "Anything that limits how the venue can be used, such as limits on equipment, noise or structures.",
    );
  });
});
