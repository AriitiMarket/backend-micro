const subscriptionsService = require('../services/subscriptions.service');
const { ok, created } = require('../../../shared/utils/response');
const { isAdmin } = require('../../../shared/utils/roles');

// A subscription belongs to one store, and `storeId` doubles as the seller's
// identity id (create falls back to `req.user.id`). Ownership is therefore
// checked against the caller: a seller may only read/write their own
// subscription, an admin may read any. Previously these handlers were behind
// authenticate-only routes, so any authenticated account could read and rewrite
// anyone's subscription.
function assertOwnStore(storeId, user) {
  if (isAdmin(user && user.role)) return;
  if (!user || String(storeId) !== String(user.id)) {
    const err = new Error('Forbidden: you can only access your own subscription');
    err.statusCode = 403;
    err.code = 'RESOURCE_NOT_OWNED';
    throw err;
  }
}

async function create(req, res, next) {
  try {
    const storeId = req.body.storeId || (req.user && req.user.id);
    assertOwnStore(storeId, req.user);
    const data = await subscriptionsService.createSubscription({ ...req.body, storeId });
    created(res, data);
  } catch (err) { next(err); }
}

async function getByStore(req, res, next) {
  try {
    const storeId = req.params.storeId || (req.user && req.user.id);
    assertOwnStore(storeId, req.user);
    const data = await subscriptionsService.getSubscriptionByStore(storeId);
    ok(res, data);
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const existing = await subscriptionsService.getSubscription(req.params.id);
    if (!existing) {
      const err = new Error('Subscription not found');
      err.statusCode = 404;
      throw err;
    }
    assertOwnStore(existing.storeId, req.user);
    const data = await subscriptionsService.updateSubscription(req.params.id, req.body);
    ok(res, data);
  } catch (err) { next(err); }
}

module.exports = { create, getByStore, update };
