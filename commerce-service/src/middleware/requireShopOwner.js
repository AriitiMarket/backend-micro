/**
 * FIX #5: Shop Ownership Verification Middleware
 * Prevents sellers from modifying other sellers' products/inventory
 */

const shopsService = require('../modules/selling/services/shops.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Middleware: Verify user owns the shop being modified
 * Extracts shopId from: body.shopId > params.shopId > params.id
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
async function requireShopOwner(req, res, next) {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      throw new ApiError('Unauthorized: no user context', 401);
    }

    // Extract shopId from multiple sources (body > params > id)
    const shopId = req.body?.shopId || req.params?.shopId || req.params?.id;
    if (!shopId) {
      throw new ApiError('Shop ID required', 400);
    }

    // Verify user owns this shop
    const shop = await shopsService.getShopById(shopId);
    if (!shop) {
      throw new ApiError('Shop not found', 404);
    }

    if (String(shop.ownerId) !== String(userId)) {
      throw new ApiError('Forbidden: you do not own this shop', 403);
    }

    // Attach verified shop to request for downstream handlers
    req.shop = shop;
    req.shopId = shopId;

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireShopOwner,
};
