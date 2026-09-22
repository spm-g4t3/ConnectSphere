/**
 * Role authorisation middleware.
 *
 * Answers "may this caller do this", where requireAuth answered "who is this".
 * The two are separate because they fail differently: a missing token is 401
 * and the caller can fix it by signing in, while the wrong role is 403 and no
 * amount of signing in will help.
 *
 * SCRUM-15 AC2 is what forces this: "an *authorised* change to a venue's
 * details". Writes to the venue catalogue belong to Venue Staff, per the story
 * statement, while reads stay open to any authenticated user because the
 * customer briefing has Event Coordinators searching for venues.
 */

import { roleLabel } from '../domain/userRole.js';


/**
 * Build middleware allowing only the listed roles.
 *
 * Runs after requireAuth and reads req.user.role, which is why it takes no
 * options: there is no seam to inject, because it makes no network call and
 * reads nothing but what the middleware before it established.
 *
 * @param {...string} allowed  roles from domain/userRole.js ROLE
 * @returns {(req, res, next) => void}
 */
export function createRequireRole(...allowed) {
  if (allowed.length === 0) {
    // A gate that allows nothing is always a mistake at the call site, and one
    // that would show up as every request 403ing in production rather than as
    // an error here.
    throw new Error('createRequireRole needs at least one role');
  }

  return function requireRole(req, res, next) {
    // Not 403. A route reaching here without req.user means requireAuth was
    // never mounted in front of it -- a wiring bug, not an unauthorised
    // caller. Answering 403 would make that bug look like correct behaviour
    // and hide it until someone wondered why nobody could use the endpoint.
    if (!req.user) {
      console.error('requireRole ran without requireAuth in front of it');
      return res.status(500).json({ error: 'Unexpected server error' });
    }

    if (allowed.includes(req.user.role)) {
      return next();
    }

    // Names the role that *would* work rather than the one the caller has:
    // telling someone "you are an Event Organiser" is not actionable, whereas
    // "this is restricted to Venue Staff" tells them who to ask.
    return res.status(403).json({
      error: `This action is restricted to ${allowed.map(roleLabel).join(' or ')}`,
    });
  };
}

export default createRequireRole;
