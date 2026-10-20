const publicShopService = require('../services/shops.public.service');
const { ok } = require('../../../shared/utils/response');

/**
 * Public Shop Controller — handles unauthenticated marketplace browsing.
 * Returns only allowlisted fields; no private data is ever sent.
 */

async function getPublicAllShops(req, res, next) {
  try {
    const result = await publicShopService.getAllShops({
      search: req.query.search || req.query.q,
      category: req.query.category,
      sort: req.query.sort || '-createdAt',
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      // Location-aware discovery: the buyer's selected city/zone.
      zoneId: req.query.zoneId || undefined,
      cityId: req.query.cityId || undefined,
      regionId: req.query.regionId || undefined,
    });
    return ok(res, { shops: result.shops, count: result.count, total: result.total, page: result.page, limit: result.limit });
  } catch (err) {
    return next(err);
  }
}

async function getPublicShopById(req, res, next) {
  try {
    const shop = await publicShopService.getShopInfo(req.params.id, {
      zoneId: req.query.zoneId || undefined,
    });
    return ok(res, { shop });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getPublicAllShops, getPublicShopById };
