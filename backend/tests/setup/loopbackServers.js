/**
 * Test setup: supertest connects to its server in the family it listens on.
 *
 * Why. supertest's request(app) starts a server with app.listen(0) -- no host,
 * so Node binds the dual-stack wildcard '::' -- and then sends the request to
 * http://127.0.0.1:<port> (node_modules/supertest/lib/test.js, serverAddress).
 * The listener's port comes from the IPv6 side and the request travels on the
 * IPv4 side. With several test workers doing this at once, macOS can give an
 * IPv6 listener in one worker a port that is still in use on the IPv4 side in
 * another, and the request then reaches ANOTHER worker's app or never gets an
 * answer. Under `npm run test:coverage` that showed up as a random route test
 * answering 401 or 404 instead of 403 (another test file's app) or timing out
 * after 5000ms, a different test each run, on the untouched main branch too.
 *
 * Evidence, from a standalone repro with no Vitest and no app code (8
 * processes, each repeatedly listen(0) then GET, 12,000 requests a round):
 *   listen(0), GET 127.0.0.1  -> 1 to 5 wrong-server answers or hangs a round
 *   listen(0), GET [::1]      -> none in 3 rounds
 *
 * What it does. serverAddress is replaced with one that asks the server which
 * address it is bound to and connects to the loopback of that family: '[::1]'
 * for an IPv6 listener, '127.0.0.1' for an IPv4 one (Node falls back to IPv4
 * where IPv6 is unavailable). It still starts the server exactly as supertest
 * does -- listen(0), synchronously -- so nothing else changes. A server that is
 * already listening is used as it is, as before.
 *
 * Tests only: this file is a Vitest setupFile. src/ is untouched.
 */

import tls from 'node:tls';
import supertest from 'supertest';

const { Test } = supertest;

Test.prototype.serverAddress = function serverAddress(app, path) {
  if (!app.address()) this._server = app.listen(0);

  const { port, family } = app.address();
  const host = family === 'IPv6' || family === 6 ? '[::1]' : '127.0.0.1';
  const protocol = app instanceof tls.Server ? 'https' : 'http';
  return `${protocol}://${host}:${port}${path}`;
};
