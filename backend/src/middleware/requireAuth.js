/**
 * Authentication middleware.
 *
 * SCRUM-42, a subtask of SCRUM-14 (Track Event Request Status).
 *
 * Establishes *who is calling*, and nothing else. It verifies the bearer token
 * the frontend already sends and puts the resulting identity on req.user, so a
 * route can scope a query to the caller without asking the caller who they are.
 *
 * Why this exists now, in a sub-task about reading a status: GET
 * /api/event-requests has no id in its path, so the only thing that can answer
 * "whose requests?" is the token. The alternative -- an organiserId in the
 * query string or body -- is a client asserting its own identity against a
 * table whose row level security is deny-all (001_event_requests.sql) on the
 * explicit understanding that the API authorises instead. That is not a stub;
 * it is a working way to read every event request in the system.
 *
 * Deliberately NOT done here:
 *
 *  - No role lookup. profiles.role is read at login (src/routes/auth.js) and
 *    role gating is a separate concern with its own stories. This middleware
 *    answers "who", not "what may they do".
 *  - No ownership check. Whether this user may see a particular request is a
 *    question about that request, so it lives in the service alongside the
 *    query, where a second caller cannot forget it.
 */

const BEARER = 'Bearer ';


/**
 * Verify a token against Supabase and return the user it names.
 *
 * The dynamic import is load-bearing, not a stylistic echo of
 * eventRequestService.resolveClient. src/config/supabaseClient.js throws at
 * import time when SUPABASE_URL or SUPABASE_SECRET_KEY is missing, and CI runs
 * the suite with no .env on purpose. A static import here would make this
 * module -- and every route that mounts it -- fail to even collect in CI.
 * Deferring it keeps production behaviour identical: ESM caches the module, so
 * the import costs one resolution on the first verified request and nothing
 * afterwards.
 *
 * getUser(token) is passed an explicit JWT, so unlike signInWithPassword it
 * does not leave the client authenticated as that user for the rest of the
 * process -- the failure mode src/config/supabaseClient.js warns about at
 * length. It is a stateless verification call, and check-event-request-routes.js
 * proves that against a real server rather than taking it on trust.
 *
 * @param {string} token
 * @returns {Promise<object|null>} the Supabase user, or null if it was refused
 */
async function defaultVerifyToken(token) {
  const { supabaseAdmin } = await import('../config/supabaseClient.js');

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  // An error here means Supabase considered the token and refused it -- expired,
  // signed out, or never valid. It is the caller's problem, not a fault, so it
  // is answered as null rather than thrown.
  if (error || !data?.user) return null;

  return data.user;
}


/**
 * Build the middleware, optionally over an injected verifier.
 *
 * A factory rather than a bare function so tests can supply a verifier instead
 * of a network call, which is the same seam the service layer uses for its
 * client. The default export is the instance routes actually mount.
 *
 * @param {object} [options]
 * @param {(token: string) => Promise<object|null>} [options.verifyToken]
 * @returns {(req, res, next) => Promise<void>}
 */
export function createRequireAuth({ verifyToken = defaultVerifyToken } = {}) {
  return async function requireAuth(req, res, next) {
    const header = req.headers?.authorization ?? '';

    // Answered locally, without asking Supabase. A round trip per anonymous
    // request would make an unauthenticated endpoint an amplifier for whoever
    // pointed traffic at it.
    if (!header.startsWith(BEARER)) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = header.slice(BEARER.length).trim();

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const user = await verifyToken(token);

      // Worded differently from the missing-header case on purpose: one says
      // sign in, the other says sign in *again*. The frontend clears its stored
      // session on any 401 (frontend/src/services/apiClient.js), so the message
      // is the only thing telling the two apart in a network tab.
      if (!user) {
        return res.status(401).json({ error: 'Your session is no longer valid' });
      }

      // Only the two fields routes are promised. Copying the whole Supabase
      // user would put app_metadata and user_metadata within reach, and
      // user_metadata is client-writable -- an invitation to authorise on a
      // value the caller controls.
      req.user = { id: user.id, email: user.email };

      return next();
    } catch (err) {
      // Supabase being unreachable is not the caller being unauthenticated.
      // A 401 here would tell a signed-in Organiser to log in again and, worse,
      // would clear their session client-side over what may be a blip.
      console.error('Unexpected error verifying a token:', err);
      return res.status(500).json({ error: 'Unexpected server error' });
    }
  };
}


/**
 * The instance routes mount.
 *
 * Responds directly rather than calling next(err): there is no app-level error
 * handler, so Express 5's default would answer an HTML 500 to a JSON client.
 * When one is added this becomes next(new UnauthorizedError(...)) in one line,
 * and src/errors.js already carries that type.
 */
export const requireAuth = createRequireAuth();

export default requireAuth;
