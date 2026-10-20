const promotionRepository = require('../repositories/promotions.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const DiscountCalculator = require('../utils/discountCalculator');
const usageTracker = require('./usageTracker.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const isAdmin = (role) => role === 'ADMIN';

/**
 * Publicly visible = listed by the owner, still active, and inside its window.
 *
 * The window is evaluated on read rather than trusted from `status`, so a
 * promotion stops being advertised the moment `endsAt` passes even if nobody
 * updated the document.
 */
function isLive(promotion) {
  if (!promotion) return false;
  if (promotion.showOnPublic !== true) return false;
  if (promotion.status !== 'active') return false;
  const now = Date.now();
  if (promotion.startsAt && new Date(promotion.startsAt).getTime() > now) return false;
  if (promotion.endsAt && new Date(promotion.endsAt).getTime() < now) return false;
  return true;
}

function normalizePercent(value) {
  if (value === undefined || value === null || value === '') return null;
  const percent = Number(value);
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    throw new ApiError('discountPercent must be a number between 0 and 100', 400);
  }
  return percent;
}

function normalizeFixedAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  if (Number.isNaN(amount) || amount < 0) {
    throw new ApiError('fixedAmount must be a non-negative number', 400);
  }
  return amount;
}

function normalizeDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(`${field} must be a valid date`, 400);
  return date;
}

class PromotionsService {
  /**
   * Live, publicly visible promotions. Guests and buyers use this.
   * @param {{ shopId?: string }} options
   */
  async listPublic({ shopId } = {}) {
    const filter = { showOnPublic: true, status: 'active' };
    if (shopId) filter.shopId = shopId;
    const promotions = await promotionRepository.find({ filter });
    return promotions.filter(isLive);
  }

  /** True when `userId` owns the shop. Never throws — used to pick a view. */
  async ownsShop(shopId, userId) {
    if (!shopId || !userId) return false;
    const shops = await shopRepository.find({ filter: { ownerId: userId } });
    return shops.some((shop) => String(shop._id) === String(shopId));
  }

  /**
   * Every promotion of a shop, in any state.
   *
   * Only the shop owner (or an admin) may see paused/unlisted drafts, so the
   * caller must already have been checked with ownsShop().
   */
  listForShop(shopId) {
    return promotionRepository.find({ filter: { shopId } });
  }

  /**
   * A single promotion.
   *
   * A non-live promotion is indistinguishable from a missing one unless the
   * caller owns it or is an admin — otherwise a draft offer could be enumerated.
   */
  async getById(id, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (isLive(promotion)) return promotion;
    if (isAdmin(role)) return promotion;
    if (await this.ownsShop(promotion.shopId, userId)) return promotion;
    throw new ApiError('Promotion not found', 404);
  }

  async create(payload, { userId, role } = {}) {
    const {
      shopId, title, description, startsAt, endsAt, showOnPublic,
      code, discountType, discountPercent, fixedAmount, maxDiscountAmount,
      minPurchaseAmount, eligibleProductIds, eligibleCategoryIds,
      isPlatformWide, firstOrderOnly, combinable,
      totalUsageLimit, perBuyerUsageLimit,
    } = payload || {};

    if (!shopId) throw new ApiError('shopId is required', 400);
    if (!title || String(title).trim().length < 2) {
      throw new ApiError('A promotion title is required (min 2 chars)', 400);
    }

    // Validate promo code if provided
    if (code) {
      const codeValidation = DiscountCalculator.validateCodeFormat(code);
      if (!codeValidation.valid) {
        throw new ApiError(codeValidation.reason, 400);
      }
      const normalizedCode = DiscountCalculator.normalizeCode(code);
      // Check for duplicate code
      const existing = await promotionRepository.find({ filter: { code: normalizedCode } });
      if (existing && existing.length > 0) {
        throw new ApiError('This promo code is already in use', 409);
      }
    }

    // Validate discount configuration
    if (discountType === 'PERCENTAGE' && !discountPercent) {
      throw new ApiError('discountPercent is required for PERCENTAGE discount type', 400);
    }
    if (discountType === 'FIXED_AMOUNT' && !fixedAmount) {
      throw new ApiError('fixedAmount is required for FIXED_AMOUNT discount type', 400);
    }

    const normDiscountPercent = normalizePercent(discountPercent);
    const normFixedAmount = normalizeFixedAmount(fixedAmount);
    const start = normalizeDate(startsAt, 'startsAt') || new Date();
    const end = normalizeDate(endsAt, 'endsAt');
    if (end && end.getTime() < start.getTime()) {
      throw new ApiError('endsAt must be after startsAt', 400);
    }

    // Platform-wide promotions require admin role
    if (isPlatformWide && !isAdmin(role)) {
      throw new ApiError('Only admins can create platform-wide promotions', 403);
    }

    if (!isAdmin(role) && !(await this.ownsShop(shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }

    const shop = await shopRepository.findById(shopId);

    return promotionRepository.create({
      shopId,
      shop: shop ? { _id: String(shop._id), name: shop.name } : undefined,
      title: String(title).trim(),
      description: description ? String(description).trim() : '',
      code: code ? DiscountCalculator.normalizeCode(code) : null,
      discountType: discountType || 'PERCENTAGE',
      discountPercent: normDiscountPercent,
      fixedAmount: normFixedAmount,
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
      minPurchaseAmount: minPurchaseAmount ? Number(minPurchaseAmount) : 0,
      eligibleProductIds: eligibleProductIds || [],
      eligibleCategoryIds: eligibleCategoryIds || [],
      isPlatformWide: isPlatformWide || false,
      firstOrderOnly: firstOrderOnly || false,
      combinable: combinable || false,
      totalUsageLimit: totalUsageLimit ? Number(totalUsageLimit) : null,
      perBuyerUsageLimit: perBuyerUsageLimit ? Number(perBuyerUsageLimit) : null,
      startsAt: start,
      endsAt: end,
      showOnPublic: showOnPublic !== false,
      createdBy: userId || null,
    });
  }

  async update(id, payload, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (!isAdmin(role) && !(await this.ownsShop(promotion.shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }

    const data = {};
    if (payload.title !== undefined) {
      if (!payload.title || String(payload.title).trim().length < 2) {
        throw new ApiError('A promotion title is required (min 2 chars)', 400);
      }
      data.title = String(payload.title).trim();
    }
    if (payload.description !== undefined) data.description = String(payload.description || '').trim();
    if (payload.discountPercent !== undefined) data.discountPercent = normalizePercent(payload.discountPercent);
    if (payload.startsAt !== undefined) data.startsAt = normalizeDate(payload.startsAt, 'startsAt');
    if (payload.endsAt !== undefined) data.endsAt = normalizeDate(payload.endsAt, 'endsAt');
    if (payload.status !== undefined) {
      if (!['active', 'paused'].includes(payload.status)) {
        throw new ApiError("status must be 'active' or 'paused'", 400);
      }
      data.status = payload.status;
    }
    if (payload.showOnPublic !== undefined) data.showOnPublic = payload.showOnPublic !== false;

    if (data.endsAt && data.startsAt && data.endsAt.getTime() < data.startsAt.getTime()) {
      throw new ApiError('endsAt must be after startsAt', 400);
    }

    return promotionRepository.findByIdAndUpdate(id, data);
  }

  async remove(id, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (!isAdmin(role) && !(await this.ownsShop(promotion.shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }
    await promotionRepository.deleteById(id);
    return { message: 'Promotion deleted' };
  }

  /**
   * Validate a promo code against a cart for checkout.
   *
   * @param {string} code - The promo code to validate
   * @param {Array} cartItems - The cart items
   * @param {number} subtotal - The cart subtotal
   * @param {string} buyerId - The buyer user ID (optional for guests)
   * @param {boolean} isFirstOrder - Whether this is the buyer's first order
   * @returns {Promise<Object>} Validation result with discount calculation
   */
  async validateCode(code, cartItems, _subtotal, buyerId = null, isFirstOrder = false) {
    if (!code) {
      throw new ApiError('Promo code is required', 400);
    }

    const normalizedCode = DiscountCalculator.normalizeCode(code);
    const codeValidation = DiscountCalculator.validateCodeFormat(normalizedCode);
    if (!codeValidation.valid) {
      throw new ApiError(codeValidation.reason, 400);
    }

    // Find promotion by code
    const promotion = await promotionRepository.find({
      filter: { code: normalizedCode },
    });
    if (!promotion || promotion.length === 0) {
      throw new ApiError('Invalid promo code', 404);
    }

    const promo = promotion[0];

    // Check if promotion is live
    if (!isLive(promo)) {
      throw new ApiError('This promo code is not currently active', 400);
    }

    // Check eligibility
    const eligibility = DiscountCalculator.checkEligibility(promo, cartItems, buyerId, isFirstOrder);
    if (!eligibility.eligible) {
      throw new ApiError(eligibility.reason, 400);
    }

    // Check usage limits if buyerId is provided
    if (buyerId) {
      const buyerUsage = await usageTracker.checkBuyerUsage(promo._id, buyerId);
      if (!buyerUsage.allowed) {
        throw new ApiError(buyerUsage.reason, 400);
      }
    }

    const totalUsage = await usageTracker.checkTotalUsage(promo._id);
    if (!totalUsage.allowed) {
      throw new ApiError(totalUsage.reason, 400);
    }

    // A shop promotion only discounts that shop's lines. Product/category
    // restrictions also limit the amount eligible for the discount; checking
    // that one line qualifies must not discount the entire basket.
    const eligibleItems = (cartItems || []).filter((item) => {
      const itemShopId = String(item.shopId || item.shop?._id || '');
      if (!promo.isPlatformWide && itemShopId !== String(promo.shopId)) return false;
      if (promo.eligibleProductIds?.length && !promo.eligibleProductIds.includes(String(item.productId || item._id))) return false;
      if (promo.eligibleCategoryIds?.length && !promo.eligibleCategoryIds.includes(String(item.categoryId || ''))) return false;
      return true;
    });
    if (!eligibleItems.length) throw new ApiError('No eligible products in cart', 400);
    const eligibleSubtotal = eligibleItems.reduce((sum, item) => {
      const lineTotal = Number(item.subtotal);
      if (Number.isFinite(lineTotal) && lineTotal >= 0) return sum + lineTotal;
      const price = Number(item.price ?? item.discountPrice ?? 0);
      const quantity = Number(item.quantity ?? item.qty ?? 1);
      return sum + (Number.isFinite(price) && Number.isFinite(quantity) ? price * quantity : 0);
    }, 0);

    // Calculate from server-priced eligible lines, not the caller's full-cart
    // subtotal. The subtotal argument remains for older consumers.
    const discountResult = DiscountCalculator.calculateDiscount(promo, eligibleSubtotal);

    return {
      valid: true,
      promotion: {
        id: promo._id,
        title: promo.title,
        code: promo.code,
        discountType: promo.discountType,
        discountPercent: promo.discountPercent,
        fixedAmount: promo.fixedAmount,
        maxDiscountAmount: promo.maxDiscountAmount,
        minPurchaseAmount: promo.minPurchaseAmount,
        isPlatformWide: promo.isPlatformWide,
        shopId: promo.shopId,
      },
      discountAmount: discountResult.discountAmount,
      isFreeDelivery: discountResult.isFreeDelivery || false,
      eligibleProducts: promo.eligibleProductIds || [],
      eligibleCategories: promo.eligibleCategoryIds || [],
      eligibleSubtotal,
    };
  }

  /**
   * Get usage statistics for a promotion.
   *
   * @param {string} promotionId - The promotion ID
   * @param {Object} context - { userId, role }
   * @returns {Promise<Object>} Usage statistics
   */
  async getUsageStats(promotionId, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) throw new ApiError('Promotion not found', 404);

    // Only owner or admin can view stats
    if (!isAdmin(role) && !(await this.ownsShop(promotion.shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }

    return usageTracker.getUsageStats(promotionId);
  }
}

module.exports = new PromotionsService();
module.exports.isLive = isLive;
module.exports.ApiError = ApiError;
module.exports.DiscountCalculator = DiscountCalculator;
module.exports.usageTracker = usageTracker;
