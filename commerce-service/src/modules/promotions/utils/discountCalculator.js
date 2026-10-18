/**
 * Discount Calculator - centralizes promotion discount calculation logic.
 *
 * Handles percentage, fixed-amount, and free delivery discounts with caps,
 * minimum purchase requirements, and eligibility validation.
 */

class DiscountCalculator {
  /**
   * Calculate the discount amount for a given promotion and cart subtotal.
   *
   * @param {Object} promotion - The promotion document
   * @param {number} subtotal - The cart subtotal before discount
   * @returns {Object} { discountAmount, applicable, reason }
   */
  static calculateDiscount(promotion, subtotal) {
    if (!promotion) {
      return { discountAmount: 0, applicable: false, reason: 'Promotion not found' };
    }

    // Check minimum purchase amount
    if (promotion.minPurchaseAmount && subtotal < promotion.minPurchaseAmount) {
      return {
        discountAmount: 0,
        applicable: false,
        reason: `Minimum purchase amount of ${promotion.minPurchaseAmount} not met`,
      };
    }

    let discountAmount = 0;

    switch (promotion.discountType) {
      case 'PERCENTAGE':
        if (!promotion.discountPercent || promotion.discountPercent <= 0) {
          return { discountAmount: 0, applicable: false, reason: 'Invalid discount percentage' };
        }
        discountAmount = (subtotal * promotion.discountPercent) / 100;
        // Apply max discount cap if set
        if (promotion.maxDiscountAmount && discountAmount > promotion.maxDiscountAmount) {
          discountAmount = promotion.maxDiscountAmount;
        }
        break;

      case 'FIXED_AMOUNT':
        if (!promotion.fixedAmount || promotion.fixedAmount <= 0) {
          return { discountAmount: 0, applicable: false, reason: 'Invalid fixed amount' };
        }
        discountAmount = promotion.fixedAmount;
        // Fixed amount cannot exceed subtotal
        if (discountAmount > subtotal) {
          discountAmount = subtotal;
        }
        break;

      case 'FREE_DELIVERY':
        // Free delivery is handled separately in order service
        // This calculator returns the delivery fee amount as the discount
        // The caller will need to provide the delivery fee
        return {
          discountAmount: 0,
          applicable: true,
          reason: 'Free delivery - handled in order service',
          isFreeDelivery: true,
        };

      default:
        return { discountAmount: 0, applicable: false, reason: 'Unknown discount type' };
    }

    // Round to 2 decimal places
    discountAmount = Math.round(discountAmount * 100) / 100;

    return {
      discountAmount,
      applicable: true,
      reason: null,
    };
  }

  /**
   * Check if a promotion is eligible for a given cart.
   *
   * @param {Object} promotion - The promotion document
   * @param {Array} cartItems - Array of cart items
   * @param {String} buyerId - Buyer user ID (for first-order check)
   * @param {boolean} isFirstOrder - Whether this is the buyer's first order
   * @returns {Object} { eligible, reason }
   */
  static checkEligibility(promotion, cartItems, buyerId, isFirstOrder = false) {
    if (!promotion) {
      return { eligible: false, reason: 'Promotion not found' };
    }

    // Check if promotion is active
    if (promotion.status !== 'active') {
      return { eligible: false, reason: `Promotion is ${promotion.status.toLowerCase()}` };
    }

    // Check first-order-only restriction
    if (promotion.firstOrderOnly && !isFirstOrder) {
      return { eligible: false, reason: 'This promotion is only for first-time customers' };
    }

    // Check product eligibility if specified
    if (promotion.eligibleProductIds && promotion.eligibleProductIds.length > 0) {
      const hasEligibleProduct = cartItems.some(item =>
        promotion.eligibleProductIds.includes(String(item.productId || item._id))
      );
      if (!hasEligibleProduct) {
        return { eligible: false, reason: 'No eligible products in cart' };
      }
    }

    // Check category eligibility if specified
    if (promotion.eligibleCategoryIds && promotion.eligibleCategoryIds.length > 0) {
      const hasEligibleCategory = cartItems.some(item =>
        promotion.eligibleCategoryIds.includes(String(item.categoryId))
      );
      if (!hasEligibleCategory) {
        return { eligible: false, reason: 'No eligible categories in cart' };
      }
    }

    return { eligible: true, reason: null };
  }

  /**
   * Calculate discount for a multi-seller cart.
   * Returns per-shop discount amounts respecting shop boundaries.
   *
   * @param {Object} promotion - The promotion document
   * @param {Object} shopGroups - Cart grouped by shop { shopId: { items, subtotal } }
   * @returns {Object} { shopDiscounts, totalDiscount }
   */
  static calculateMultiSellerDiscount(promotion, shopGroups) {
    const shopDiscounts = {};
    let totalDiscount = 0;

    for (const [shopId, group] of Object.entries(shopGroups)) {
      // Platform-wide promotions apply to all shops
      // Shop-owned promotions only apply to their own shop
      if (!promotion.isPlatformWide && String(promotion.shopId) !== String(shopId)) {
        continue;
      }

      const result = this.calculateDiscount(promotion, group.subtotal);
      if (result.applicable) {
        shopDiscounts[shopId] = result.discountAmount;
        totalDiscount += result.discountAmount;
      }
    }

    return { shopDiscounts, totalDiscount };
  }

  /**
   * Normalize a promo code for storage and lookup.
   * Converts to uppercase and removes whitespace.
   *
   * @param {string} code - The raw promo code
   * @returns {string} Normalized code
   */
  static normalizeCode(code) {
    if (!code) return null;
    return String(code).trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
   * Validate promo code format.
   * Codes should be alphanumeric, 4-20 characters.
   *
   * @param {string} code - The promo code to validate
   * @returns {Object} { valid, reason }
   */
  static validateCodeFormat(code) {
    if (!code || typeof code !== 'string') {
      return { valid: false, reason: 'Code is required' };
    }

    const normalized = this.normalizeCode(code);
    if (normalized.length < 4) {
      return { valid: false, reason: 'Code must be at least 4 characters' };
    }
    if (normalized.length > 20) {
      return { valid: false, reason: 'Code must be no more than 20 characters' };
    }
    if (!/^[A-Z0-9]+$/.test(normalized)) {
      return { valid: false, reason: 'Code must contain only letters and numbers' };
    }

    return { valid: true, reason: null };
  }
}

module.exports = DiscountCalculator;
