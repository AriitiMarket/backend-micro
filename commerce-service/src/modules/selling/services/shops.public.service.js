const { findPublicAll, findPublicById } = require('../repositories/shops.public.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Public ShopService — read-only, field-limited queries for unauthenticated
 * marketplace browsing. No ownership checks, no write operations.
 */
class PublicShopService {
  /**
   * List shops with allowlisted fields. Applies the same visibility filter
   * (only approved/active shops) as the main service.
   */
  async getAllShops(opts = {}) {
    return findPublicAll(opts);
  }

  /**
   * Get a single shop with allowlisted fields.
   * Returns 404-compatible null for missing/hidden shops.
   */
  async getShopInfo(id) {
    const shop = await findPublicById(id);
    if (!shop) throw new ApiError('Shop not found', 404);
    return shop;
  }
}

module.exports = new PublicShopService();
