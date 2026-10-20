const promotionRepository = require('../repositories/promotions.repository');

class UsageTrackerService {
  /**
   * Check if a buyer has exceeded their per-buyer usage limit for a promotion.
   *
   * @param {string} promotionId - The promotion ID
   * @param {string} buyerId - The buyer user ID
   * @returns {Promise<Object>} { allowed, usageCount, limit, reason }
   */
  async checkBuyerUsage(promotionId, buyerId) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) {
      return { allowed: false, usageCount: 0, limit: null, reason: 'Promotion not found' };
    }

    // No per-buyer limit means unlimited
    if (!promotion.perBuyerUsageLimit || promotion.perBuyerUsageLimit <= 0) {
      return { allowed: true, usageCount: 0, limit: null, reason: null };
    }

    // Count how many times this buyer has used the promotion
    const usageCount = promotion.usageHistory
      ? promotion.usageHistory.filter(entry => String(entry.buyerId) === String(buyerId)).length
      : 0;

    if (usageCount >= promotion.perBuyerUsageLimit) {
      return {
        allowed: false,
        usageCount,
        limit: promotion.perBuyerUsageLimit,
        reason: `You have used this promotion ${usageCount} times (limit: ${promotion.perBuyerUsageLimit})`,
      };
    }

    return {
      allowed: true,
      usageCount,
      limit: promotion.perBuyerUsageLimit,
      reason: null,
    };
  }

  /**
   * Check if a promotion has exceeded its total usage limit.
   *
   * @param {string} promotionId - The promotion ID
   * @returns {Promise<Object>} { allowed, usedCount, limit, reason }
   */
  async checkTotalUsage(promotionId) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) {
      return { allowed: false, usedCount: 0, limit: null, reason: 'Promotion not found' };
    }

    // No total limit means unlimited
    if (!promotion.totalUsageLimit || promotion.totalUsageLimit <= 0) {
      return { allowed: true, usedCount: promotion.usedCount || 0, limit: null, reason: null };
    }

    const usedCount = promotion.usedCount || 0;

    if (usedCount >= promotion.totalUsageLimit) {
      return {
        allowed: false,
        usedCount,
        limit: promotion.totalUsageLimit,
        reason: 'This promotion has been fully redeemed',
      };
    }

    return {
      allowed: true,
      usedCount,
      limit: promotion.totalUsageLimit,
      reason: null,
    };
  }

  /**
   * Record a promotion usage atomically.
   * Increments the total usage count and adds an entry to usage history.
   *
   * @param {string} promotionId - The promotion ID
   * @param {string} buyerId - The buyer user ID
   * @param {string} orderId - The order ID
   * @param {number} discountAmount - The discount amount applied
   * @returns {Promise<Object>} Updated promotion document
   */
  async recordUsage(promotionId, buyerId, orderId, discountAmount) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) {
      throw new Error('Promotion not found');
    }

    // A retry for the same order is idempotent. The repository update enforces
    // total and per-buyer caps in the same atomic write as the usage record.
    const existingUse = (promotion.usageHistory || []).find(
      (entry) => String(entry.orderId) === String(orderId)
    );
    if (existingUse) return promotion;

    const updated = await promotionRepository.recordUsageAtomic(
      promotionId,
      buyerId,
      orderId,
      discountAmount,
      promotion
    );
    if (!updated) {
      const latest = await promotionRepository.findById(promotionId);
      if (!latest) throw new Error('Promotion not found');
      if ((latest.usageHistory || []).some((entry) => String(entry.orderId) === String(orderId))) return latest;
      const buyerUsage = buyerId
        ? (latest.usageHistory || []).filter((entry) => String(entry.buyerId) === String(buyerId)).length
        : 0;
      if (latest.totalUsageLimit > 0 && latest.usedCount >= latest.totalUsageLimit) {
        throw new Error('Promotion has reached its total usage limit');
      }
      if (buyerId && latest.perBuyerUsageLimit > 0 && buyerUsage >= latest.perBuyerUsageLimit) {
        throw new Error('Buyer has reached their usage limit for this promotion');
      }
      throw new Error('Promotion usage could not be recorded');
    }

    // Auto-update status to exhausted if limit reached
    if (updated.totalUsageLimit && updated.usedCount >= updated.totalUsageLimit) {
      await promotionRepository.findByIdAndUpdate(promotionId, {
        status: 'exhausted',
      });
    }

    return updated;
  }

  /**
   * Get usage statistics for a promotion.
   *
   * @param {string} promotionId - The promotion ID
   * @returns {Promise<Object>} Usage statistics
   */
  async getUsageStats(promotionId) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) {
      throw new Error('Promotion not found');
    }

    const totalUsed = promotion.usedCount || 0;
    const totalLimit = promotion.totalUsageLimit;
    const remaining = totalLimit ? Math.max(0, totalLimit - totalUsed) : null;
    const usagePercentage = totalLimit ? (totalUsed / totalLimit) * 100 : null;

    // Count unique buyers
    const uniqueBuyers = promotion.usageHistory
      ? new Set(promotion.usageHistory.map(entry => entry.buyerId)).size
      : 0;

    return {
      totalUsed,
      totalLimit,
      remaining,
      usagePercentage,
      uniqueBuyers,
      recentUsage: promotion.usageHistory
        ? promotion.usageHistory.slice(-10).reverse()
        : [],
    };
  }

  /**
   * Rollback a promotion usage (e.g., for cancelled orders).
   *
   * @param {string} promotionId - The promotion ID
   * @param {string} orderId - The order ID to remove from history
   * @returns {Promise<Object>} Updated promotion document
   */
  async rollbackUsage(promotionId, orderId) {
    const promotion = await promotionRepository.findById(promotionId);
    if (!promotion) {
      throw new Error('Promotion not found');
    }

    const updated = await promotionRepository.rollbackUsageAtomic(promotionId, orderId);
    if (!updated) throw new Error('Usage entry not found for this order');

    // Restore status from exhausted if applicable
    if (promotion.status === 'exhausted') {
      const newStatus = updated.usedCount < (updated.totalUsageLimit || Infinity) ? 'active' : 'exhausted';
      if (newStatus === 'active') {
        await promotionRepository.findByIdAndUpdate(promotionId, { status: 'active' });
      }
    }

    return updated;
  }
}

module.exports = new UsageTrackerService();
