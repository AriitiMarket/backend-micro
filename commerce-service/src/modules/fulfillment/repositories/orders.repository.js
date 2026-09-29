const Order = require('../models/Orders');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');

class OrderRepository {
  create(data) { return Order.create(data); }

  // An id from the UI is not guaranteed to be an ObjectId; return null so the
  // caller can answer 404 instead of a CastError-driven 500.
  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Order.findById(id);
  }

  findByRequestId(requestId) {
    if (!requestId) return Promise.resolve(null);
    return Order.findOne({ requestId: String(requestId) });
  }

  findByIdLean(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Order.findById(id).lean();
  }
  findByUser(userId) { return Order.find({ buyerId: userId }).sort({ createdAt: -1 }); }
  findBySeller(sellerId) { return Order.find({ sellerId }).sort({ createdAt: -1 }); }

  /**
   * Orders for a seller addressed by EITHER id shape:
   *   - the seller's identity user id (top-level `sellerId`), or
   *   - one of their shop ids (the embedded per-seller shipment snapshot).
   * The business UI calls with the shop id; analytics/seeds use the identity id.
   */
  findBySellerOrShop(id) {
    const key = String(id);
    return Order.find({
      $or: [{ sellerId: key }, { 'sellerShipments.shopId': key }],
    }).sort({ createdAt: -1 });
  }
  updateStatus(id, status) {
    return Order.findByIdAndUpdate(id, { status, updatedAt: new Date() }, { new: true });
  }
  findByIdAndUpdate(id, data, opts) {
    const set = data && typeof data === 'object' && !Array.isArray(data) && !Object.keys(data).some((k) => k.startsWith('$'))
      ? { ...data, updatedAt: new Date() }
      : data;
    return Order.findByIdAndUpdate(id, set, { new: true, ...opts });
  }

  /**
   * Delete an order row. Used by the checkout compensation path: when a
   * reservation fails mid-checkout the half-built order must be removed, not
   * left behind in `Processing` (the failure path called a method that did not
   * exist, so every such failure returned 500 and leaked both the row and the
   * units it had already reserved).
   */
  deleteById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Order.findByIdAndDelete(id);
  }

  /**
   * Targeted field update — the delivery-status sync writes `status`,
   * `deliveredAt`, `deliveryId`, … without touching the rest of the document.
   */
  updateFields(id, fields = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Order.findByIdAndUpdate(id, { $set: { ...fields, updatedAt: new Date() } }, { new: true });
  }

  /**
   * Atomic payment-confirmation claim: flips PENDING→CONFIRMED for exactly one
   * caller. Returns null when the order is already confirmed or has left the
   * pre-acceptance states (cancelled, delivered, shipped, refund flow), so
   * concurrent confirmations can never deduct inventory twice and a refund or
   * delivered order can never jump backwards to Confirmed.
   */
  claimPaymentConfirmation(orderId) {
    if (!isValidObjectId(orderId)) return Promise.resolve(null);
    return Order.findOneAndUpdate(
      {
        _id: orderId,
        paymentStatus: { $ne: 'CONFIRMED' },
        // Whitelist: only Processing/Confirmed (canonical + legacy spellings).
        status: {
          $in: [
            ORDER_STATUSES.PROCESSING, 'PENDING', 'NEW', 'ORDERED',
            ORDER_STATUSES.CONFIRMED, 'CONFIRMED', 'ACCEPTED',
          ],
        },
      },
      { $set: { paymentStatus: 'CONFIRMED', status: ORDER_STATUSES.CONFIRMED, updatedAt: new Date() } },
      { new: true }
    );
  }

  claimCODSettlement(orderId, now = new Date()) {
    if (!isValidObjectId(orderId)) return Promise.resolve(null);
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
    return Order.findOneAndUpdate({
      _id: orderId,
      'paymentInfo.method': { $in: ['COD', null] },
      $or: [
        { paymentStatus: 'PENDING' },
        { paymentStatus: 'SETTLING', paymentSettlementStartedAt: { $lt: staleBefore } },
      ],
    }, {
      $set: { paymentStatus: 'SETTLING', paymentSettlementStartedAt: now, updatedAt: now },
    }, { new: true });
  }

  releaseCODSettlement(orderId) {
    if (!isValidObjectId(orderId)) return Promise.resolve(null);
    return Order.findOneAndUpdate(
      { _id: orderId, paymentStatus: 'SETTLING' },
      { $set: { paymentStatus: 'PENDING', paymentSettlementStartedAt: null, updatedAt: new Date() } },
      { new: true },
    );
  }

  /**
   * Atomic cancel claim: flips a cancellable order (canonical + legacy
   * spellings) to Cancelled exactly once. Returns the PRE-update document so
   * the caller can see the paymentStatus that was current at claim time, or
   * null when the order is no longer cancellable (lost race / illegal state).
   */
  claimCancellation(orderId) {
    if (!isValidObjectId(orderId)) return Promise.resolve(null);
    return Order.findOneAndUpdate(
      {
        _id: orderId,
        status: {
          $in: [
            ORDER_STATUSES.PROCESSING, 'PENDING', 'NEW', 'ORDERED',
            ORDER_STATUSES.CONFIRMED, 'CONFIRMED', 'ACCEPTED',
          ],
        },
      },
      { $set: { status: ORDER_STATUSES.CANCELLED, cancelledAt: new Date(), updatedAt: new Date() } },
      { new: false }
    );
  }

  /** Rolls a failed claim back so the client can retry after a deduct error. */
  rollbackPaymentConfirmation(orderId, paymentStatus, status) {
    if (!isValidObjectId(orderId)) return Promise.resolve(null);
    return Order.findByIdAndUpdate(
      orderId,
      {
        $set: {
          paymentStatus: paymentStatus || 'PENDING',
          // Canonical value — the old 'PENDING' fallback was not a status the
          // state machine recognises, so a rolled-back order could never be
          // accepted by its seller.
          status: normalizeStatus(status) || ORDER_STATUSES.PROCESSING,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );
  }

  /**
   * Verified purchase: does this customer have a non-cancelled order that
   * contains this product? (cart lines store the product id as `_id`.)
   */
  existsOwnedOrder(buyerId, productId) {
    if (!buyerId || !isValidObjectId(productId)) return Promise.resolve(false);
    return Order.exists({
      buyerId: String(buyerId),
      'cart._id': String(productId),
      // Exclude BOTH spellings — legacy rows used 'CANCELLED', canonical is
      // 'Cancelled'; filtering only the former let cancelled orders still
      // count as verified purchases (review gating).
      status: { $nin: ['CANCELLED', ORDER_STATUSES.CANCELLED] },
    });
  }

  /**
   * Does THIS customer own THIS order AND does that order contain the product?
   * Used by review submission so an arbitrary `orderId` in the body cannot flip
   * `isReviewed` on someone else's cart line.
   */
  ownsOrderContaining(orderId, buyerId, productId) {
    if (!buyerId || !isValidObjectId(orderId) || !isValidObjectId(productId)) {
      return Promise.resolve(false);
    }
    return Order.exists({
      _id: orderId,
      buyerId: String(buyerId),
      'cart._id': String(productId),
    });
  }

  /**
   * How many orders reference this product (any line, any status).
   *
   * Orders keep the priced line items verbatim, so a hard-deleted product would
   * leave order history, buyer receipts and seller revenue figures pointing at
   * a row that no longer exists.
   */
  countByProduct(productId) {
    if (!isValidObjectId(productId)) return Promise.resolve(0);
    return Order.countDocuments({ 'cart._id': String(productId) });
  }

  // --- Admin / analytics reads -------------------------------------------
  // Aggregated in the database (never by loading rows into memory).

  count(filter = {}) {
    return Order.countDocuments(filter);
  }

  findAll(filter = {}, opts = {}) {
    const { skip = 0, limit = 50, sort = { createdAt: -1 } } = opts;
    return Order.find(filter).sort(sort).skip(skip).limit(limit).lean();
  }

  aggregate(pipeline = []) {
    return Order.aggregate(pipeline);
  }

  /** [{ _id: <fieldValue>, count }] — grouped counts used for hierarchy roll-ups. */
  countByField(field, filter = {}) {
    return Order.aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
  }

  /** Seller ids with at least one order matching the filter. */
  async distinctSellers(filter = {}) {
    const values = await Order.distinct('sellerId', filter);
    return values.filter(Boolean);
  }
}

module.exports = new OrderRepository();
