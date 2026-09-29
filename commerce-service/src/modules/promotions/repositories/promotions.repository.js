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

  findByIdAndUpdate(id, data) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Promotion.findByIdAndUpdate(
      id,
      { ...data, updatedAt: new Date() },
      { new: true, runValidators: true }
    );
  }

  deleteById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Promotion.findByIdAndDelete(id);
  }
}

module.exports = new PromotionRepository();
