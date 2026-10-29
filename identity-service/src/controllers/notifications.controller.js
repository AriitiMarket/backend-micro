// Notifications controller for user notifications.
const { ok } = require('../utils/response');

/**
 * List paginated notifications for the authenticated user.
 * 
 * @param {import('express').Request} req - Express request with query pagination { page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listNotifications(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    return ok(res, {
      notifications: [],
      total: 0,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      totalPages: 0,
    });
  } catch (err) { return next(err); }
}

module.exports = { listNotifications };
