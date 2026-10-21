// renderApp.js
//
// Renders the real App at a URL as a given role. The importing test must mock
// ../../src/auth/AuthContext with authContextMock() from ./authMock.js. Plain .js
// with createElement, because the lint rule for .jsx allows only component exports.

import { createElement } from "react";
import { vi } from "vitest";
import { render } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { authValue } from "./authMock.js";

export { ALL_ROLES } from "./authMock.js";

/** Signs `role` in for the next render; an empty role is a signed-out visitor. */
export function mockAuthUser(role, user) {
  vi.mocked(useAuth).mockReturnValue(authValue(role, user));
}

/** App owns a BrowserRouter, so the start URL goes through the History API. */
export function renderAppAt(path, role, user) {
  mockAuthUser(role, user);
  window.history.pushState({}, "", path);
  return render(createElement(App));
}
