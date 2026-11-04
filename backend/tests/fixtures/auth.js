// Stand-ins for requireAuth, injected into the routers so a route test picks
// who is signed in without a real session.

import { expect } from 'vitest';
import request from 'supertest';

/** Stands in for no session, answering as the real middleware does. */
export const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/**
 * Builds a file's `signedInAs(role, id = defaultId)`: a verified session with
 * one role, setting req.user in the shape requireAuth gives it.
 */
export function signedInFor(defaultId, email = 'someone@example.com') {
  return (role, id = defaultId) => (req, _res, next) => {
    req.user = { id, email, role };
    next();
  };
}

/**
 * The flow tests' requireAuth: the `x-test-as` header names a key of `users`
 * ({ id, role }), and an unknown or missing name is a 401.
 */
export function headerAuth(users) {
  return (req, res, next) => {
    const user = users[req.get('x-test-as')];
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: user.id, email: `${req.get('x-test-as')}@example.com`, role: user.role };
    return next();
  };
}

/**
 * Builds a flow's `as(who, build)`: sends the request as `who` and checks no
 * assertion failed inside the mocked client while it ran.
 */
export function actingAs(app, failures) {
  return async (who, build) => {
    const res = await build(request(app)).set('x-test-as', who);
    expect(failures).toEqual([]);
    return res;
  };
}
