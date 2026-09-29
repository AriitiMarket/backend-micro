const Shop = require('../models/Shops');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class ShopRepository {
  create(data) { return Shop.create(data); }

  // Invalid ids resolve to null (clean 404) rather than throwing CastError.
  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Shop.findById(id);
  }

  findByIdLean(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Shop.findById(id).lean();
  }

  findByEmail(email) { return Shop.findOne({ email }); }

  /**
   * Case-insensitive exact lookup — used by the seller self-heal (a shop may
   * have been stored with different casing than the identity email).
   */
  findByEmailInsensitive(email) {
    const escaped = String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Shop.findOne({ email: { $regex: new RegExp(`^${escaped}$`, 'i') } });
  }
  findByIdAndUpdate(id, data, opts = {}) { return Shop.findByIdAndUpdate(id, data, { new: true, ...opts }); }
  updateOneById(id, data) { return Shop.findByIdAndUpdate(id, data, { new: true, runValidators: true }); }
  find({ filter = {}, sort = {} } = {}) { return Shop.find(filter).sort(sort); }
  deleteById(id) { return Shop.findByIdAndDelete(id); }

  // --- Admin / analytics reads -------------------------------------------

  count(filter = {}) {
    return Shop.countDocuments(filter);
  }

  findAll(filter = {}, opts = {}) {
    const { skip = 0, limit = 50, sort = { createdAt: -1 } } = opts;
    return Shop.find(filter).sort(sort).skip(skip).limit(limit).lean();
  }

  /** [{ _id: <fieldValue>, count }] — grouped counts for hierarchy roll-ups. */
  countByField(field, filter = {}) {
    return Shop.aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
  }

  aggregate(pipeline = []) {
    return Shop.aggregate(pipeline);
  }

  /**
   * Distinct non-null values of one field for a filter.
   *
   * Used to turn a hierarchy scope into its owner/application sets with an
   * indexed query. The previous approach loaded up to 5,000 shop documents and
   * mapped them in memory, so a large scope silently stopped narrowing past that
   * cap.
   */
  distinct(field, filter = {}) {
    const query = Object.keys(filter).length
      ? { $and: [filter, { [field]: { $ne: null } }] }
      : { [field]: { $ne: null } };
    return Shop.distinct(field, query);
  }

  /**
   * Minimal projection used to attribute orders to a location
   * (order.sellerId -> shop.ownerId -> shop.locationId) without loading whole
   * shop documents.
   */
  listOwnerLocationPairs() {
    return Shop.aggregate([
      { $match: { locationId: { $ne: null }, ownerId: { $ne: null } } },
      { $project: { _id: 0, ownerId: 1, locationId: 1 } },
    ]);
  }
}

module.exports = new ShopRepository();
