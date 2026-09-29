const RequestRestriction = require('../models/RequestRestriction');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class RestrictionRepository {
  create(data) { return RequestRestriction.create(data); }

  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return RequestRestriction.findById(id);
  }

  /**
   * Restrictions that currently bite: ACTIVE rows, and TEMPORARY rows whose
   * `until` has not passed yet (an expired temporary restriction stops
   * applying on its own, without needing a cron job to lift it).
   */
  findActiveForUser(userId) {
    if (!userId) return Promise.resolve([]);
    return RequestRestriction.find({
      userId: String(userId),
      status: 'ACTIVE',
      $or: [{ kind: 'PERMANENT' }, { until: null }, { until: { $gt: new Date() } }],
    }).sort({ createdAt: -1 });
  }

  find({ filter = {}, sort = { createdAt: -1 }, page, limit } = {}) {
    let query = RequestRestriction.find(filter).sort(sort);
    if (page !== undefined && limit !== undefined) {
      const safePage = Math.max(parseInt(page, 10) || 1, 1);
      const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      query = query.skip((safePage - 1) * safeLimit).limit(safeLimit);
      return query;
    }
    return query;
  }

  async findPaginated({ filter = {}, sort = { createdAt: -1 }, page = 1, limit = 20 } = {}) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const [items, total] = await Promise.all([
      RequestRestriction.find(filter).sort(sort).skip((safePage - 1) * safeLimit).limit(safeLimit),
      RequestRestriction.countDocuments(filter),
    ]);
    return { restrictions: items, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 };
  }

  lift(id, { liftedBy, liftReason, at = new Date() }) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return RequestRestriction.findByIdAndUpdate(
      id,
      { status: 'LIFTED', liftedBy: liftedBy || null, liftedAt: at, liftReason: liftReason || '' },
      { new: true }
    );
  }
}

module.exports = new RestrictionRepository();
