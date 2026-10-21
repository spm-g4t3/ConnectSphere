/**
 * The acting user is the signed-in one, and the request body never gets a say:
 * a client must not be able to name whoever it likes as the editor in the change history.
 *
 * @param {import('express').Request} req  after requireAuth
 * @returns {string}
 */
export function actingUser(req) {
  return req.user.id;
}
