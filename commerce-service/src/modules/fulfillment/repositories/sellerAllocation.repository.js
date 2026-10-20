const SellerAllocation = require('../models/SellerAllocation');

class SellerAllocationRepository {
  create(data) { return SellerAllocation.create(data); }
  findById(id) { return SellerAllocation.findById(id); }
  findByOrder(orderId) {
    return SellerAllocation.find({ orderId }).sort({ createdAt: -1 }).lean();
  }
  findByOrderGroup(orderGroupId) {
    return SellerAllocation.find({ orderGroupId }).sort({ createdAt: -1 }).lean();
  }
  findBySeller(sellerId, filter = {}) {
    return SellerAllocation.find({ sellerId, ...filter }).sort({ createdAt: -1 }).lean();
  }
  findOne(orderId, sellerId) {
    return SellerAllocation.findOne({ orderId, sellerId }).lean();
  }
  findAll(filter = {}, opts = {}) {
    const { skip = 0, limit = 50, sort = { createdAt: -1 } } = opts;
    return SellerAllocation.find(filter).sort(sort).skip(skip).limit(limit).lean();
  }
  count(filter = {}) { return SellerAllocation.countDocuments(filter); }
  updateById(id, data) {
    return SellerAllocation.findByIdAndUpdate(id, { ...data, updatedAt: new Date() }, { new: true });
  }
  /** Idempotent snapshot keyed on (orderId, sellerId) — creates once and
   * preserves the original rate and amounts on retries after settings change.
   * orderId/sellerId are immutable keys (part of the unique index) so they are
   * never $set on an existing document — only inserted on create. */
  async upsert(orderId, sellerId, data) {
    const { orderId: _oid, sellerId: _sid, ...rest } = data;
    return SellerAllocation.findOneAndUpdate(
      { orderId, sellerId },
      // Mongoose timestamps writes updatedAt itself, so don't include that path
      // in $setOnInsert or MongoDB rejects the conflicting update operators.
      { $setOnInsert: { ...rest, orderId, sellerId, createdAt: new Date() } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
  }
  aggregate(pipeline = []) { return SellerAllocation.aggregate(pipeline); }
}

module.exports = new SellerAllocationRepository();
