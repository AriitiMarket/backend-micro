const SellerWallet = require('../models/SellerWallet');
const WalletTransaction = require('../models/WalletTransaction');

class WalletRepository {
  /**
   * Get or create seller wallet
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getOrCreateWallet(sellerId) {
    try {
      return await SellerWallet.findOneAndUpdate(
        { sellerId },
        {
          $setOnInsert: {
            sellerId,
            availableBalance: 0,
            pendingBalance: 0,
            totalEarned: 0,
            totalCommissionDeducted: 0,
            currency: 'ETB',
            status: 'ACTIVE',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    } catch (error) {
      // A concurrent first read may win the unique sellerId insert.
      if (error?.code !== 11000) throw error;
      return SellerWallet.findOne({ sellerId }).lean();
    }
  }

  /**
   * Get wallet by seller ID
   * @param {string} sellerId
   * @returns {Promise<Object|null>}
   */
  async getWalletBySellerId(sellerId) {
    return SellerWallet.findOne({ sellerId }).lean();
  }

  /**
   * Get wallet by wallet ID
   * @param {string} walletId
   * @returns {Promise<Object|null>}
   */
  async getWalletById(walletId) {
    return SellerWallet.findById(walletId).lean();
  }

  /**
   * Update wallet balances (ONLY through service layer)
   * @param {string} walletId
   * @param {Object} updates - { availableBalance, pendingBalance, etc. }
   * @returns {Promise<Object>}
   */
  async updateWalletBalances(walletId, updates) {
    return SellerWallet.findByIdAndUpdate(
      walletId,
      { $set: updates, updatedAt: new Date() },
      { new: true }
    ).lean();
  }

  /**
   * Update wallet last activity timestamps
   * @param {string} walletId
   * @param {Object} timestamps - { lastTransactionAt, lastSettlementAt, etc. }
   * @returns {Promise<Object>}
   */
  async updateWalletTimestamps(walletId, timestamps) {
    return SellerWallet.findByIdAndUpdate(
      walletId,
      { $set: timestamps },
      { new: true }
    ).lean();
  }

  /**
   * Suspend or close wallet
   * @param {string} walletId
   * @param {string} status - 'SUSPENDED' or 'CLOSED'
   * @param {string} reason
   * @returns {Promise<Object>}
   */
  async updateWalletStatus(walletId, status, reason = '') {
    return SellerWallet.findByIdAndUpdate(
      walletId,
      {
        $set: {
          status,
          notes: reason,
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Add wallet transaction to ledger (IMMUTABLE)
   * @param {Object} transactionData
   * @returns {Promise<Object>}
   */
  async createTransaction(transactionData) {
    return WalletTransaction.create(transactionData);
  }

  /**
   * Get wallet transaction history
   * @param {string} sellerId
   * @param {Object} options - { limit, offset, startDate, endDate }
   * @returns {Promise<Array>}
   */
  async getTransactionHistory(sellerId, options = {}) {
    const { limit = 50, offset = 0, startDate, endDate } = options;

    const filter = { sellerId };
    if (startDate || endDate) {
      filter.transactionAt = {};
      if (startDate) filter.transactionAt.$gte = new Date(startDate);
      if (endDate) filter.transactionAt.$lte = new Date(endDate);
    }

    return WalletTransaction.find(filter)
      .sort({ transactionAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Get transaction count for pagination
   * @param {string} sellerId
   * @param {Object} filters
   * @returns {Promise<number>}
   */
  async getTransactionCount(sellerId, filters = {}) {
    const query = { sellerId, ...filters };
    return WalletTransaction.countDocuments(query);
  }

  /**
   * Get transactions by order
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getTransactionsByOrder(orderId) {
    return WalletTransaction.find({ orderId })
      .sort({ transactionAt: -1 })
      .lean();
  }

  /**
   * Get transactions by type
   * @param {string} sellerId
   * @param {string} transactionType
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async getTransactionsByType(sellerId, transactionType, options = {}) {
    const { limit = 50, offset = 0 } = options;

    return WalletTransaction.find({
      sellerId,
      transactionType
    })
      .sort({ transactionAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Get pending transactions
   * @param {string} sellerId
   * @returns {Promise<Array>}
   */
  async getPendingTransactions(sellerId) {
    return WalletTransaction.find({
      sellerId,
      status: 'PENDING'
    })
      .sort({ transactionAt: -1 })
      .lean();
  }

  /**
   * Verify transaction integrity (for audit)
   * @param {string} transactionId
   * @returns {Promise<Object|null>}
   */
  async getTransaction(transactionId) {
    return WalletTransaction.findById(transactionId).lean();
  }

  /**
   * Get all wallets (admin query)
   * @param {Object} filters
   * @param {Object} options - { limit, offset, sort }
   * @returns {Promise<Array>}
   */
  async getAllWallets(filters = {}, options = {}) {
    const { limit = 50, offset = 0, sort = { createdAt: -1 } } = options;

    return SellerWallet.find(filters)
      .sort(sort)
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Get wallet count for admin dashboard
   * @param {Object} filters
   * @returns {Promise<number>}
   */
  async getWalletCount(filters = {}) {
    return SellerWallet.countDocuments(filters);
  }

  /**
   * Get platform-wide financial summary
   * @returns {Promise<Object>}
   */
  async getPlatformFinancialSummary() {
    const wallets = await SellerWallet.aggregate([
      {
        $group: {
          _id: null,
          totalAvailableBalance: { $sum: '$availableBalance' },
          totalPendingBalance: { $sum: '$pendingBalance' },
          totalEarned: { $sum: '$totalEarned' },
          totalCommissionDeducted: { $sum: '$totalCommissionDeducted' },
          totalRefunded: { $sum: '$totalRefunded' },
          totalPaidOut: { $sum: '$totalPaidOut' },
          activeWallets: {
            $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] }
          },
          suspendedWallets: {
            $sum: { $cond: [{ $eq: ['$status', 'SUSPENDED'] }, 1, 0] }
          }
        }
      }
    ]);

    return wallets.length > 0 ? wallets[0] : {
      totalAvailableBalance: 0,
      totalPendingBalance: 0,
      totalEarned: 0,
      totalCommissionDeducted: 0,
      totalRefunded: 0,
      totalPaidOut: 0,
      activeWallets: 0,
      suspendedWallets: 0
    };
  }

  /**
   * Get seller wallet summary (what seller sees)
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getSellerWalletSummary(sellerId) {
    const wallet = await this.getWalletBySellerId(sellerId);
    if (!wallet) return null;

    const recentTransactions = await WalletTransaction.find({ sellerId })
      .sort({ transactionAt: -1 })
      .limit(10)
      .lean();

    const pendingTransactions = await WalletTransaction.find({
      sellerId,
      status: 'PENDING'
    }).lean();

    return {
      wallet,
      recentTransactions,
      pendingCount: pendingTransactions.length
    };
  }
}

module.exports = new WalletRepository();
