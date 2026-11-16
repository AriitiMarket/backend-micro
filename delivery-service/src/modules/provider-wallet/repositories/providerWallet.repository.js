'use strict';

const ProviderWallet = require('../models/ProviderWallet');

class ProviderWalletRepository {
  async getOrCreate(providerId, currency = 'ETB') {
    return ProviderWallet.findOneAndUpdate(
      { providerId },
      { $setOnInsert: { providerId, currency } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  async findById(id) {
    return ProviderWallet.findById(id).lean();
  }

  async findByProviderId(providerId) {
    return ProviderWallet.findOne({ providerId }).lean();
  }

  async find(filter = {}, options = {}) {
    let query = ProviderWallet.find(filter);
    if (options.populate) query = query.populate(options.populate);
    if (options.sort) query = query.sort(options.sort);
    if (options.limit) query = query.limit(options.limit);
    if (options.lean !== false) query = query.lean();
    return query;
  }

  /**
   * Atomically reserve an amount from availableBalance to lockedBalance.
   * Guarantees availableBalance >= amount to prevent overdrafts.
   */
  async atomicReservePayout(walletId, amount) {
    return ProviderWallet.findOneAndUpdate(
      { _id: walletId, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount, lockedBalance: amount } },
      { new: true }
    );
  }

  /**
   * Roll back a reserved payout in case payout creation fails.
   */
  async releasePayoutReserve(walletId, amount) {
    return ProviderWallet.updateOne(
      { _id: walletId },
      { $inc: { availableBalance: amount, lockedBalance: -amount } }
    );
  }

  /**
   * Settle an approved payout: deduct from lockedBalance and add to withdrawnBalance.
   */
  async settlePayout(providerId, amount) {
    return ProviderWallet.updateOne(
      { providerId },
      { $inc: { lockedBalance: -amount, withdrawnBalance: amount } }
    );
  }

  /**
   * Refund a rejected payout: deduct from lockedBalance and return to availableBalance.
   */
  async refundPayout(providerId, amount) {
    return ProviderWallet.updateOne(
      { providerId },
      { $inc: { lockedBalance: -amount, availableBalance: amount } }
    );
  }

  /**
   * Credit earnings to pendingBalance or availableBalance.
   */
  async creditBalance(walletId, bucket, amount) {
    return ProviderWallet.updateOne(
      { _id: walletId },
      { $inc: { [bucket]: amount } }
    );
  }

  /**
   * Move matured earnings from pendingBalance to availableBalance.
   */
  async releaseMatured(providerId, amount) {
    return ProviderWallet.updateOne(
      { providerId },
      { $inc: { pendingBalance: -amount, availableBalance: amount } }
    );
  }
}

module.exports = new ProviderWalletRepository();
module.exports.ProviderWalletRepository = ProviderWalletRepository;
