const Request = require('../models/Requests');
const { OPEN_REQUEST_STATUSES } = require('../models/Requests');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class RequestRepository {
  create(data) { return Request.create(data); }

  // Invalid ids resolve to null (clean 404) rather than throwing CastError.
  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Request.findById(id);
  }

  find({ filter = {}, sort = { createdAt: -1 }, page, limit } = {}) {
    let query = Request.find(filter).sort(sort);
    if (page !== undefined && limit !== undefined) {
      const safePage = Math.max(parseInt(page, 10) || 1, 1);
      const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      query = query.skip((safePage - 1) * safeLimit).limit(safeLimit);
      return query;
    }
    return query;
  }

  async countDocuments(filter = {}) {
    return Request.countDocuments(filter);
  }

  /** Paginated list with total for API paging metadata. */
  async findPaginated({ filter = {}, sort = { createdAt: -1 }, page = 1, limit = 20 } = {}) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const [items, total] = await Promise.all([
      Request.find(filter).sort(sort).skip((safePage - 1) * safeLimit).limit(safeLimit),
      Request.countDocuments(filter),
    ]);
    return {
      requests: items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  findByIdAndUpdate(id, data) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Request.findByIdAndUpdate(
      id,
      { ...data, updatedAt: new Date() },
      { new: true, runValidators: true }
    );
  }

  claimConversion(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Request.findOneAndUpdate(
      { _id: id, status: 'AGREED', orderId: null },
      { $set: { status: 'CONVERTING', conversionStartedAt: new Date(), updatedAt: new Date() } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Append one timeline entry. `$slice` keeps the array bounded (newest 300)
   * so an old, chatty negotiation can never grow a document without limit.
   */
  pushActivity(id, entry) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Request.findByIdAndUpdate(
      id,
      { $push: { activity: { $each: [entry], $slice: -300 } }, $set: { updatedAt: new Date() } },
      { new: true, runValidators: true }
    );
  }

  /**
   * Update with explicit operators ($push/$set/$unset…). Keeps operator
   * updates and plain-field updates apart, so callers never mix the two in
   * one document. `queryFilter` narrows the match (needed for positional
   * operators like `reports.$.status`).
   */
  updateWithOperators(id, operators = {}, queryFilter = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    const { $set = {}, ...rest } = operators;
    return Request.findOneAndUpdate(
      { _id: id, ...queryFilter },
      { ...rest, $set: { ...$set, updatedAt: new Date() } },
      { new: true, runValidators: true }
    );
  }

  /**
   * Open requests whose `expiresAt` deadline has passed. Bounded so a sweep
   * can never emit an unbounded burst of audit entries.
   */
  findOverdueIds(now = new Date(), limit = 500) {
    return Request.find(
      { expiresAt: { $ne: null, $lt: now }, status: { $in: OPEN_REQUEST_STATUSES } },
      { _id: 1 }
    ).limit(limit).lean();
  }

  /** Flip the given (still open) requests to EXPIRED. */
  expireByIds(ids, now = new Date()) {
    if (!ids || !ids.length) return Promise.resolve({ matchedCount: 0 });
    return Request.updateMany(
      { _id: { $in: ids }, status: { $in: OPEN_REQUEST_STATUSES } },
      { $set: { status: 'EXPIRED', updatedAt: now } }
    );
  }

  /** Statuses of today, grouped — powers the admin conversion dashboard. */
  countByStatus() {
    return Request.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  }

  /** Moderation counters for the admin workspace (reported/suspended). */
  countModeration() {
    return Promise.all([
      Request.countDocuments({ 'reports.0': { $exists: true } }),
      Request.countDocuments({ 'reports.status': 'OPEN' }),
      Request.countDocuments({ suspended: true }),
    ]).then(([reported, openReports, suspended]) => ({ reported, openReports, suspended }));
  }
}

module.exports = new RequestRepository();
