const promotionsService = require('../services/promotions.service');
const { ok, created } = require('../../../shared/utils/response');

/**
 * The gateway injects x-user-id / x-user-role from a VERIFIED token, and these
 * read routes carry no authenticate middleware (guests must be able to browse
 * offers), so the headers are read directly. An absent token simply means
 * "anonymous", which can only ever see public data.
 */
function caller(req) {
  return {
    userId: req.headers['x-user-id'] || (req.user && req.user.id) || null,
    role: req.headers['x-user-role'] || (req.user && req.user.role) || null,
  };
}

/** Public: live, publicly listed promotions. Used by guests and buyers. */
async function listPromotions(req, res, next) {
  try {
    const promotions = await promotionsService.listPublic({ shopId: req.query.shopId });
    return ok(res, { promotions, count: promotions.length });
  } catch (err) { return next(err); }
}

/**
 * Promotions of one shop.
 *
 * An owner (or an admin) manages paused and unlisted drafts, so they receive
 * every promotion of the shop; everybody else receives only the live public
 * ones. `canManage` lets the UI tell the two apart.
 */
async function listShopPromotions(req, res, next) {
  try {
    const { shopId } = req.params;
    const { userId, role } = caller(req);
    const canManage = role === 'ADMIN' || (await promotionsService.ownsShop(shopId, userId));

    const promotions = canManage
      ? await promotionsService.listForShop(shopId)
      : await promotionsService.listPublic({ shopId });

    return ok(res, { promotions, count: promotions.length, canManage });
  } catch (err) { return next(err); }
}

async function getPromotion(req, res, next) {
  try {
    const promotion = await promotionsService.getById(req.params.id, caller(req));
    return ok(res, { promotion });
  } catch (err) { return next(err); }
}

async function createPromotion(req, res, next) {
  try {
    const promotion = await promotionsService.create(req.body, caller(req));
    return created(res, { promotion }, 'Promotion created');
  } catch (err) { return next(err); }
}

async function updatePromotion(req, res, next) {
  try {
    const promotion = await promotionsService.update(req.params.id, req.body, caller(req));
    return ok(res, { promotion }, 'Promotion updated');
  } catch (err) { return next(err); }
}

async function deletePromotion(req, res, next) {
  try {
    const result = await promotionsService.remove(req.params.id, caller(req));
    return ok(res, result);
  } catch (err) { return next(err); }
}

module.exports = {
  listPromotions,
  listShopPromotions,
  getPromotion,
  createPromotion,
  updatePromotion,
  deletePromotion,
};
