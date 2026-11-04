// textLimits.js
//
// The server caps every free-text reason and note at 1000 code points (the
// booking, flagged-booking, release and equipment checks agree), so the forms
// share one number.

export const SERVER_TEXT_MAX_LENGTH = 1000;
