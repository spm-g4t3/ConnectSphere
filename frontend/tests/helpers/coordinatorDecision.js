// coordinatorDecision.js
//
// The event screen's review decision is one radio per outcome and a submit
// button named after the choice. These pick the outcome, then submit it.

import { screen } from "@testing-library/react";

// The submit button's name for each choice, which is also the old button's name.
const RADIO_FOR_SUBMIT = {
  "Approve request": "Approve",
  "Reject request": "Reject",
  "Return for amendment": "Return for amendment",
};

/** Chooses the outcome whose submit button is `submitName`, without submitting. */
export async function chooseDecision(user, submitName) {
  await user.click(await screen.findByRole("radio", { name: RADIO_FOR_SUBMIT[submitName] }));
}

/** Chooses the outcome and presses its submit button, e.g. decide(user, "Approve request"). */
export async function decide(user, submitName) {
  await chooseDecision(user, submitName);
  await user.click(screen.getByRole("button", { name: submitName }));
}
