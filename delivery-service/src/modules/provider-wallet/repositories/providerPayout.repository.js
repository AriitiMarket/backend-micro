'use strict';

const ProviderPayout = require('../models/ProviderPayout');

class ProviderPayoutRepository {
  async create(data) {
    return ProviderPayout.create(data);
  }

  async findById(id) {
    return ProviderPayout.findById(id);
  }

  async findByIdLean(id) {
    return ProviderPayout.findById(id).lean();
  }

  async find(filter = {}, options = {}) {
    let query = ProviderPayout.find(filter);
    if (options.populate) query = query.populate(options.populate);
    if (options.sort) query = query.sort(options.sort);
    if (options.limit) query = query.limit(options.limit);
    if (options.lean !== false) query = query.lean();
    return query;
  }

  async deleteOne(filter) {
    return ProviderPayout.deleteOne(filter);
  }

  /**
   * Atomically transition payout status from a specific current status (e.g. 'pending')
   * to avoid race conditions when multiple reviews happen simultaneously.
   */
  async atomicTransitionStatus(id, fromStatus, updateData) {
    return ProviderPayout.findOneAndUpdate(
      { _id: id, status: fromStatus },
      { $set: updateData },
      { new: true }
    );
  }
}

module.exports = new ProviderPayoutRepository();
module.exports.ProviderPayoutRepository = ProviderPayoutRepository;
