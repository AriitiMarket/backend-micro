const Promotion = require('../models/Promotions');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class PromotionRepository {
  create(data) { return Promotion.create(data); }

  // Invalid ids resolve to null (clean 404) rather than throwing CastError.
  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Promotion.findById(id);
  }

  find({ filter = {}, sort = { createdAt: -1 } } = {}) {
    return Promotion.find(filter).sort(sort);
  }

  findByIdAndUpdate(id, data, options = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    const isOperatorUpdate = Object.keys(data || {}).some((key) => key.startsWith('$'));
    const update = isOperatorUpdate
      ? { ...data, $set: { ...(data.$set || {}), updatedAt: new Date() } }
      : { $set: { ...data, updatedAt: new Date() } };
    return Promotion.findByIdAndUpdate(
      id,
      update,
      { new: true, runValidators: true, ...options }
    );
  }

  /** Atomically enforces both redemption limits while recording one order. */
  recordUsageAtomic(promotionId, buyerId, orderId, discountAmount, limits = {}) {
    const filter = {
      _id: promotionId,
      'usageHistory.orderId': { $ne: String(orderId) },
    };
    const conditions = [];

    if (Number(limits.totalUsageLimit) > 0) {
      conditions.push({ $lt: [{ $ifNull: ['$usedCount', 0] }, '$totalUsageLimit'] });
    }
    if (buyerId && Number(limits.perBuyerUsageLimit) > 0) {
      conditions.push({
        $lt: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ['$usageHistory', []] },
                as: 'usage',
                cond: { $eq: ['$$usage.buyerId', String(buyerId)] },
              },
            },
          },
          '$perBuyerUsageLimit',
        ],
      });
    }
    if (conditions.length) filter.$expr = { $and: conditions };

    return Promotion.findOneAndUpdate(
      filter,
      {
        $inc: { usedCount: 1 },
        $push: {
          usageHistory: {
            buyerId: buyerId ? String(buyerId) : null,
            orderId: String(orderId),
            usedAt: new Date(),
            discountAmount,
          },
        },
        $set: { updatedAt: new Date() },
      },
      { new: true, runValidators: true }
    );
  }

  /** Atomic/idempotent rollback for an order cancellation. */
  rollbackUsageAtomic(promotionId, orderId) {
    return Promotion.findOneAndUpdate(
      { _id: promotionId, 'usageHistory.orderId': String(orderId) },
      {
        $inc: { usedCount: -1 },
        $pull: { usageHistory: { orderId: String(orderId) } },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );
  }

  deleteById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Promotion.findByIdAndDelete(id);
  }
}

module.exports = new PromotionRepository();
