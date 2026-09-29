const StockMovement = require('../models/StockMovements');

class StockMovementRepository {
  create(data) { return StockMovement.create(data); }
  findByProduct(productId, limit = 50) {
    return StockMovement.find({ productId }).sort({ createdAt: -1 }).limit(limit);
  }
  findByShop(shopId, limit = 100) {
    return StockMovement.find({ shopId }).sort({ createdAt: -1 }).limit(limit);
  }
  /**
   * Drop the ledger rows of a product that is being hard-deleted (only reached
   * after the order-history guard, so no explained movement is lost).
   */
  deleteByProduct(productId) {
    return StockMovement.deleteMany({ productId: String(productId) });
  }
  /**
   * Drop the ledger rows of an order that is being rolled back (a checkout that
   * failed before it committed), so no movement references a deleted order.
   */
  deleteByOrder(orderId) {
    if (!orderId) return Promise.resolve({ deletedCount: 0 });
    return StockMovement.deleteMany({ orderId: String(orderId) });
  }
  /**
   * Idempotency marker for payment confirmation: has this order already had
   * these units deducted for this product? (movement + orderId + type key)
   */
  existsConfirmedForOrder(orderId, productId) {
    if (!orderId) return Promise.resolve(false);
    return StockMovement.exists({
      type: 'order_confirmed',
      orderId: String(orderId),
      productId: String(productId),
    });
  }
}

module.exports = new StockMovementRepository();
