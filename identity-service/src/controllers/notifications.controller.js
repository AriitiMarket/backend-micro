const { ok } = require('../utils/response');

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
