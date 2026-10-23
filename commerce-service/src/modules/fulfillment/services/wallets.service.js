const mongoose = require('mongoose');
const walletsRepository = require('../repositories/wallets.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * WALLET SERVICE
 * 
 * Manages seller wallet balances and transaction history.
 * 
 * Rules:
 * 1. Wallet balances updated ONLY here (never directly in model)
 * 2. All updates create immutable WalletTransaction ledger entries
 * 3. No negative balances or overpayments allowed
 * 4. All monetary operations use session transactions for atomicity
 * 5. Role-based access enforced at controller layer
 */
class WalletService {
  /**
   * Get or create wallet for seller
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getOrCreateWallet(sellerId) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    const wallet = await walletsRepository.getOrCreateWallet(sellerId);
    if (!wallet) throw new ApiError('Failed to create wallet', 500);
    return wallet;
  }

  /**
   * Get seller wallet with recent activity
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getSellerWallet(sellerId) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    const wallet = await this.getOrCreateWallet(sellerId);
    return wallet;
  }

  /**
   * Get wallet summary for seller dashboard
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getWalletDashboard(sellerId) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    // A seller can open the dashboard before their first paid order. Create
    // the zero-balance wallet on first read so the dashboard has a useful
    // empty state instead of returning a misleading 404.
    await this.getOrCreateWallet(sellerId);
    const summary = await walletsRepository.getSellerWalletSummary(sellerId);
    if (!summary) throw new ApiError('Wallet not found', 404);
    return summary;
  }

  /**
   * Get wallet transaction history
   * @param {string} sellerId
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async getTransactionHistory(sellerId, options = {}) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    const { limit = 50, offset = 0, startDate, endDate } = options;

    if (limit > 100) throw new ApiError('Limit cannot exceed 100', 400);
    if (offset < 0) throw new ApiError('Offset must be >= 0', 400);

    return walletsRepository.getTransactionHistory(sellerId, {
      limit: Math.max(1, Math.min(limit, 100)),
      offset: Math.max(0, offset),
      startDate,
      endDate
    });
  }

  /**
   * Credit seller wallet from order allocation (called after payment confirmed)
   * 
   * @param {string} orderId
   * @param {string} sellerId
   * @param {Object} allocationData - { grossSubtotal, platformCommission, netPayable }
   * @param {Object} context - { actor, reason }
   * @returns {Promise<Object>}
   */
  async creditFromAllocation(orderId, sellerId, allocationData, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!orderId || !sellerId) throw new ApiError('Order and Seller IDs required', 400);

      // Ensure wallet exists
      const wallet = await walletsRepository.getOrCreateWallet(sellerId);
      if (!wallet) throw new ApiError('Cannot create wallet', 500);

      const grossSubtotal = Number(allocationData.grossSubtotal || 0);
      const platformCommission = Number(allocationData.platformCommission || 0);
      const netPayable = Number(allocationData.netPayable || 0);

      if (grossSubtotal <= 0 || netPayable <= 0) {
        throw new ApiError('Invalid allocation amounts', 400);
      }

      // Find existing transaction to prevent double-crediting.
      //
      // The guard is scoped to (orderId, sellerId), NOT to the order alone: one
      // buyer order can contain items from several sellers, and EACH of them
      // gets its own allocation and its own wallet credit. Scoping it to the
      // order made the FIRST seller's credit look like a duplicate to the
      // SECOND seller, so every seller after the first was silently left
      // unpaid (the caller swallows the 409, so the failure was invisible).
      const existing = await walletsRepository.getTransactionsByOrder(orderId);
      if (existing && existing.some(t => (
        t.transactionType === 'ORDER_ALLOCATION'
        && String(t.sellerId) === String(sellerId)
      ))) {
        throw new ApiError('Allocation already credited to wallet', 409);
      }

      // Get current balances before transaction
      const currentWallet = await walletsRepository.getWalletById(wallet._id);
      const balanceBefore = currentWallet.availableBalance + currentWallet.pendingBalance;

      // Credit to PENDING (will be released after settlement window)
      const newPendingBalance = currentWallet.pendingBalance + netPayable;

      // Update wallet
      const updated = await walletsRepository.updateWalletBalances(wallet._id, {
        pendingBalance: newPendingBalance,
        totalEarned: currentWallet.totalEarned + grossSubtotal,
        totalCommissionDeducted: currentWallet.totalCommissionDeducted + platformCommission,
        lastTransactionAt: new Date()
      });

      // Log transaction (immutable)
      await walletsRepository.createTransaction({
        sellerId: sellerId,
        walletId: wallet._id,
        transactionType: 'ORDER_ALLOCATION',
        amount: netPayable,
        currency: 'ETB',
        direction: 'CREDIT',
        status: 'COMPLETED',
        balanceBeforeTransaction: currentWallet.availableBalance,
        balanceAfterTransaction: currentWallet.availableBalance, // not moved to available yet
        pendingBeforeTransaction: currentWallet.pendingBalance,
        pendingAfterTransaction: newPendingBalance,
        orderId: orderId,
        reason: `Order allocation - gross ${grossSubtotal}, commission ${platformCommission}`,
        actor: context.actor ? context.actor : undefined,
        actorType: context.actorType || 'SYSTEM',
        metadata: allocationData,
        transactionAt: new Date()
      });

      await session.commitTransaction();

      return {
        wallet: updated,
        transaction: {
          type: 'ORDER_ALLOCATION',
          amount: netPayable,
          pendingNow: newPendingBalance
        }
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Release pending balance to available (after settlement window)
   * Called by settlement job or admin
   * 
   * @param {string} walletId
   * @param {number} amount - Amount to release (or null for all pending)
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async releasePendingBalance(walletId, amount = null, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await walletsRepository.getWalletById(walletId);
      if (!wallet) throw new ApiError('Wallet not found', 404);

      const releaseAmount = amount || wallet.pendingBalance;
      if (releaseAmount <= 0) throw new ApiError('Release amount must be positive', 400);
      if (releaseAmount > wallet.pendingBalance) {
        throw new ApiError('Release amount exceeds pending balance', 400);
      }

      const newPendingBalance = wallet.pendingBalance - releaseAmount;
      const newAvailableBalance = wallet.availableBalance + releaseAmount;

      const updated = await walletsRepository.updateWalletBalances(walletId, {
        pendingBalance: newPendingBalance,
        availableBalance: newAvailableBalance,
        lastSettlementAt: new Date(),
        lastTransactionAt: new Date()
      });

      // Log transaction
      await walletsRepository.createTransaction({
        walletId: walletId,
        sellerId: wallet.sellerId,
        transactionType: 'PENDING_RELEASE',
        amount: releaseAmount,
        currency: 'ETB',
        direction: 'CREDIT',
        status: 'COMPLETED',
        pendingBeforeTransaction: wallet.pendingBalance,
        pendingAfterTransaction: newPendingBalance,
        balanceBeforeTransaction: wallet.availableBalance,
        balanceAfterTransaction: newAvailableBalance,
        reason: context.reason || 'Settlement window complete',
        actor: context.actor ? context.actor : undefined,
        actorType: context.actorType || 'SYSTEM',
        transactionAt: new Date()
      });

      await session.commitTransaction();

      return {
        wallet: updated,
        released: releaseAmount,
        newAvailable: newAvailableBalance
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Deduct from wallet for refund (reverses allocation credit)
   * @param {string} walletId
   * @param {number} amount
   * @param {string} orderId
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async creditRefund(walletId, amount, orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await walletsRepository.getWalletById(walletId);
      if (!wallet) throw new ApiError('Wallet not found', 404);

      amount = Number(amount || 0);
      if (amount <= 0) throw new ApiError('Refund amount must be positive', 400);

      // Refund applies to pending first, then available
      let pendingDeduction = Math.min(amount, wallet.pendingBalance);
      let availableDeduction = amount - pendingDeduction;

      if (availableDeduction > wallet.availableBalance) {
        throw new ApiError('Insufficient available balance for refund', 400);
      }

      const newPendingBalance = wallet.pendingBalance - pendingDeduction;
      const newAvailableBalance = wallet.availableBalance - availableDeduction;

      const updated = await walletsRepository.updateWalletBalances(walletId, {
        pendingBalance: newPendingBalance,
        availableBalance: newAvailableBalance,
        totalRefunded: wallet.totalRefunded + amount,
        lastTransactionAt: new Date()
      });

      // Log transaction
      await walletsRepository.createTransaction({
        walletId: walletId,
        sellerId: wallet.sellerId,
        transactionType: 'REFUND_CREDITED',
        amount: amount,
        currency: 'ETB',
        direction: 'DEBIT',
        status: 'COMPLETED',
        pendingBeforeTransaction: wallet.pendingBalance,
        pendingAfterTransaction: newPendingBalance,
        balanceBeforeTransaction: wallet.availableBalance,
        balanceAfterTransaction: newAvailableBalance,
        orderId: orderId,
        reason: context.reason || 'Refund to buyer',
        actor: context.actor ? context.actor : undefined,
        actorType: context.actorType || 'SYSTEM',
        transactionAt: new Date()
      });

      await session.commitTransaction();

      return {
        wallet: updated,
        refundedAmount: amount
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Manual adjustment (admin only)
   * @param {string} walletId
   * @param {number} amount - Positive or negative
   * @param {string} reason
   * @param {Object} context - { actor (required for admin) }
   * @returns {Promise<Object>}
   */
  async createAdjustment(walletId, amount, reason, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!context.actor) throw new ApiError('Admin actor required for adjustment', 403);

      const wallet = await walletsRepository.getWalletById(walletId);
      if (!wallet) throw new ApiError('Wallet not found', 404);

      amount = Number(amount || 0);
      if (amount === 0) throw new ApiError('Adjustment amount cannot be zero', 400);

      const isCredit = amount > 0;
      const absAmount = Math.abs(amount);

      // Debits come from available balance only
      if (!isCredit && absAmount > wallet.availableBalance) {
        throw new ApiError('Insufficient available balance for debit', 400);
      }

      const newAvailableBalance = wallet.availableBalance + amount;
      const updated = await walletsRepository.updateWalletBalances(walletId, {
        availableBalance: newAvailableBalance,
        totalAdjusted: wallet.totalAdjusted + amount,
        lastTransactionAt: new Date()
      });

      // Log transaction
      await walletsRepository.createTransaction({
        walletId: walletId,
        sellerId: wallet.sellerId,
        transactionType: 'ADJUSTMENT',
        amount: absAmount,
        currency: 'ETB',
        direction: isCredit ? 'CREDIT' : 'DEBIT',
        status: 'COMPLETED',
        balanceBeforeTransaction: wallet.availableBalance,
        balanceAfterTransaction: newAvailableBalance,
        reason: reason,
        actor: context.actor,
        actorType: 'ADMIN',
        transactionAt: new Date()
      });

      await session.commitTransaction();

      return { wallet: updated, adjustment: amount };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Admin: Get platform financial summary
   * @returns {Promise<Object>}
   */
  async getPlatformFinancialSummary() {
    return walletsRepository.getPlatformFinancialSummary();
  }

  /**
   * Admin: Get all wallets with filtering
   * @param {Object} filters
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async getAllWallets(filters = {}, options = {}) {
    return walletsRepository.getAllWallets(filters, options);
  }

  /**
   * Admin: Suspend wallet
   * @param {string} walletId
   * @param {string} reason
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async suspendWallet(walletId, reason, context = {}) {
    if (!context.actor) throw new ApiError('Admin required', 403);
    const wallet = await walletsRepository.updateWalletStatus(walletId, 'SUSPENDED', reason);
    if (!wallet) throw new ApiError('Wallet not found', 404);
    return wallet;
  }

  /**
   * Admin: Reactivate suspended wallet
   * @param {string} walletId
   * @param {string} reason
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async reactivateWallet(walletId, reason, context = {}) {
    if (!context.actor) throw new ApiError('Admin required', 403);
    const wallet = await walletsRepository.updateWalletStatus(walletId, 'ACTIVE', reason);
    if (!wallet) throw new ApiError('Wallet not found', 404);
    return wallet;
  }

  /**
   * Admin: Export wallet data
   * @param {Object} options - { status, startDate, endDate, format }
   * @returns {Promise<string|Array>}
   */
  async exportWalletData(options = {}) {
    const { status, startDate, endDate, format = 'csv' } = options;

    const wallets = await walletsRepository.getAllWallets(
      { status, startDate, endDate },
      { limit: 10000 }
    );

    if (format === 'csv') {
      const headers = ['Wallet ID', 'Seller ID', 'Available Balance', 'Pending Balance', 'Total Balance', 'Status', 'Currency', 'Created At', 'Last Transaction At'];
      const rows = wallets.map(w => [
        w._id,
        w.sellerId,
        w.availableBalance,
        w.pendingBalance,
        w.availableBalance + w.pendingBalance,
        w.status,
        w.currency || 'ETB',
        w.createdAt ? new Date(w.createdAt).toISOString() : '',
        w.lastTransactionAt ? new Date(w.lastTransactionAt).toISOString() : ''
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
      return csv;
    }

    return wallets;
  }
}

module.exports = new WalletService();
