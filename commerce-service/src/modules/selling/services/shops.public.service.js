const { findPublicAll, findPublicById } = require('../repositories/shops.public.repository');
const { publicDeliveryInfo } = require('./shopCoverage.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Public ShopService — read-only, field-limited queries for unauthenticated
 * marketplace browsing. No ownership checks, no write operations.
 *
 * Every response carries a `delivery` block (physical location + coverage +
 * servesSelectedZone for the buyer's currently selected zone, when supplied)
 * so location is never ambiguous on a card or detail page.
 */
class PublicShopService {
  /**
   * List shops with allowlisted fields. Applies the same visibility filter
   * (only approved/active shops) as the main service, plus optional zone/city
   * eligibility filters (Rule C).
   */
  async getAllShops(opts = {}) {
    const result = await findPublicAll(opts);
    const zoneId = opts.zoneId ? String(opts.zoneId) : null;
    result.shops = result.shops.map((shop) => ({
      ...shop,
      delivery: publicDeliveryInfo(shop, zoneId),
    }));
    return result;
  }

  /**
   * Get a single shop with allowlisted fields.
   * Returns 404-compatible null for missing/hidden shops.
   * `opts.zoneId` (optional) answers "does it serve the selected zone?".
   */
  async getShopInfo(id, opts = {}) {
    const shop = await findPublicById(id);
    if (!shop) throw new ApiError('Shop not found', 404);
    const zoneId = opts.zoneId ? String(opts.zoneId) : null;
    shop.delivery = publicDeliveryInfo(shop, zoneId);
    return shop;
  }
}

module.exports = new PublicShopService();
