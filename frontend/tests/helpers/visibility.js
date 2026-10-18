// visibility.js
//
// Overrides jsdom's document.visibilityState so a test can hide or show the tab.
// Call `delete document.visibilityState` afterwards to restore jsdom's own getter.

export function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
