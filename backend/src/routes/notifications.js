/**
 * Notification routes.
 *
 * SCRUM-128, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC3: an Event Coordinator is notified when a block overrides one of their
 * bookings. The database writes the notifications (014); these routes let the
 * signed-in user read theirs and mark one as read. Thin wrappers around
 * src/services/notificationService.js.
 *
 * Deliberately NOT here:
 *
 *  - No role gate. Every route is scoped to req.user.id, and routes/
 *    eventRequests.js sets the rule this follows: a gate is earned only when a
 *    route returns rows no ownership check could scope. An inbox is the
 *    clearest case of ownership there is, and a gate would add nothing but a
 *    way for a Coordinator whose role changes to lose what they were sent.
 *  - No route to create or delete a notification. They are written by the
 *    database in the same transaction as the event they describe, which is
 *    what makes "flagged" and "notified" impossible to separate.
 */

import express from 'express';

import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
} from '../services/notificationService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createErrorMiddleware } from '../http/handleError.js';


/** Answers whatever a handler throws or rejects with; see src/http/handleError.js (SCRUM-127). */
const errorMiddleware = createErrorMiddleware('notifications route');


/**
 * Build the router, optionally over injected middleware.
 *
 * A factory for the same reason routes/venues.js is one: the tests drive real
 * Express routing with a fake authenticator, while production supplies none.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @returns {import('express').Router}
 */
export function createNotificationRouter({ requireAuth = defaultRequireAuth } = {}) {
  const router = express.Router();

  // On the whole router: every route reads req.user.id to know whose inbox it
  // is, so a route reachable without it would not know what to return.
  router.use(requireAuth);

  /**
   * The caller's notifications, newest first, read and unread.
   *
   * A bare array, like GET /api/event-requests, because the dashboard card
   * maps over it directly. None is 200 [] -- an empty inbox is not missing.
   *
   * Statuses: 200, 401 from requireAuth, 500 for anything untyped.
   */
  router.get('/', async (req, res) => {
    const notifications = await listNotifications(req.user.id);
    res.status(200).json(notifications);
  });

  /**
   * How many of the caller's notifications are unread (SCRUM-172, AC4).
   *
   * An object rather than a bare number, so fields can be added later without
   * breaking callers. None unread is 200 { unreadCount: 0 }.
   *
   * Statuses: 200, 401 from requireAuth, 500 for anything untyped.
   */
  router.get('/unread-count', async (req, res) => {
    const unreadCount = await countUnreadNotifications(req.user.id);
    res.status(200).json({ unreadCount });
  });

  /**
   * Mark one notification as read.
   *
   * PATCH because it changes one field of an existing record, and /read in the
   * path rather than a body of { readAt }, so a client cannot choose the
   * timestamp or un-read a notification. Idempotent: an already-read one comes
   * back 200 with its original readAt.
   *
   * Statuses: 200 with the notification, 400 for a malformed id, 401 from
   * requireAuth, 404 for a notification that is missing or not the caller's
   * (the same answer for both), 500 for anything untyped.
   */
  router.patch('/:id/read', async (req, res) => {
    const notification = await markNotificationRead(req.params.id, req.user.id);
    res.status(200).json(notification);
  });

  router.use(errorMiddleware);
  return router;
}


/** The instance src/app.js mounts. */
export default createNotificationRouter();
