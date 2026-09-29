const SellerApplication = require('../models/SellerApplications');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

// Data-access layer for SellerApplication documents ("businesses" in the admin
// console: Seller/Business -> Shops).
module.exports = {
  create(data) {
    return SellerApplication.create(data);
  },

  find(filter = {}, opts = {}) {
    const { skip = 0, limit = 0, sort = { createdAt: -1 } } = opts;
    let query = SellerApplication.find(filter).sort(sort);
    if (skip) query = query.skip(skip);
    if (limit) query = query.limit(limit);
    return query.lean();
  },

  findAll(filter = {}, opts = {}) {
    const { skip = 0, limit = 50, sort = { createdAt: -1 } } = opts;
    return SellerApplication.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();
  },

  count(filter = {}) {
    return SellerApplication.countDocuments(filter);
  },

  /** [{ _id: <fieldValue>, count }] — grouped counts for hierarchy roll-ups. */
  countByField(field, filter = {}) {
    return SellerApplication.aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
  },

  aggregate(pipeline = []) {
    return SellerApplication.aggregate(pipeline);
  },

  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return SellerApplication.findById(id).lean();
  },

  findByOwner(ownerId) {
    return SellerApplication.findOne({
      $or: [{ ownerId }, { userId: ownerId }],
    }).sort({ createdAt: -1 }).lean();
  },

  findOne(filter) {
    return SellerApplication.findOne(filter).lean();
  },

  updateById(id, update) {
    return SellerApplication.findByIdAndUpdate(
      id,
      { ...update, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).lean();
  },

  updateByOwner(ownerId, update) {
    return SellerApplication.findOneAndUpdate(
      { ownerId },
      { ...update, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).lean();
  },

  deleteById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return SellerApplication.findByIdAndDelete(id).lean();
  },

  deleteByOwner(ownerId) {
    return SellerApplication.deleteOne({ ownerId });
  },
};