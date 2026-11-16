'use strict';

const ProviderWalletTransaction = require('../models/ProviderWalletTransaction');

class ProviderWalletTransactionRepository {
  async create(data) {
    return ProviderWalletTransaction.create(data);
  }

  async find(filter = {}, options = {}) {
    let query = ProviderWalletTransaction.find(filter);
    if (options.select) query = query.select(options.select);
    if (options.sort) query = query.sort(options.sort);
    if (options.limit) query = query.limit(options.limit);
    if (options.lean !== false) query = query.lean();
    return query;
  }

  async findMatured(providerId, asOfDate) {
    return ProviderWalletTransaction.find({
      providerId,
      type: 'delivery_earning',
      status: 'pending',
      availableAt: { $lte: asOfDate },
    }).select('_id amount');
  }

  /**
   * Transition transaction status atomically from 'pending' to 'available'.
   */
  async atomicUpdateStatus(id, fromStatus, toStatus) {
    return ProviderWalletTransaction.updateOne(
      { _id: id, status: fromStatus },
      { $set: { status: toStatus } }
    );
  }
}

module.exports = new ProviderWalletTransactionRepository();
module.exports.ProviderWalletTransactionRepository = ProviderWalletTransactionRepository;
