const walletsService = require('../services/wallets.service');
const walletsRepository = require('../repositories/wallets.repository');
const { isSeller, isAdmin } = require('../../../shared/utils/roles');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * WALLET CONTROLLER
 * 
 * Handles HTTP requests for wallet operations.
 * 
 * Authorization:
 * - Sellers access only own wallet
 * - Admins access all wallets and admin endpoints
 * - Role checks enforced here before calling service
 */
class WalletController {
  /**
   * GET /api/wallets/:sellerId
   * Get seller wallet with current balances
   */
  async getWallet(req, res) {
    try {
      const { sellerId } = req.params;
      const { id: actorId } = req.user || {};

      // Authorization: seller accesses own wallet, admin accesses any
      if (isSeller(req.user) && String(actorId) !== String(sellerId)) {
        return res.status(403).json({
          error: 'You can only access your own wallet',
          code: 'WALLET_ACCESS_DENIED'
        });
      }

      if (!isAdmin(req.user) && !isSeller(req.user)) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      const wallet = await walletsService.getSellerWallet(sellerId);

      return res.status(200).json({
        success: true,
        data: {
          id: wallet._id,
          sellerId: wallet.sellerId,
          availableBalance: wallet.availableBalance,
          pendingBalance: wallet.pendingBalance,
          totalBalance: wallet.availableBalance + wallet.pendingBalance,
          totalEarned: wallet.totalEarned,
          totalCommissionDeducted: wallet.totalCommissionDeducted,
          totalRefunded: wallet.totalRefunded,
          totalAdjusted: wallet.totalAdjusted,
          totalPaidOut: wallet.totalPaidOut,
          currency: wallet.currency,
          status: wallet.status,
          lastTransactionAt: wallet.lastTransactionAt,
          lastSettlementAt: wallet.lastSettlementAt,
          lastPayoutAt: wallet.lastPayoutAt
        }
      });
    } catch (err) {
      console.error('getWallet error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch wallet',
        code: 'WALLET_FETCH_ERROR'
      });
    }
  }

  /**
   * GET /api/wallets/:sellerId/dashboard
   * Get wallet summary for dashboard (recent transactions, pending count)
   */
  async getWalletDashboard(req, res) {
    try {
      const { sellerId } = req.params;
      const { id: actorId } = req.user || {};

      // Authorization
      if (isSeller(req.user) && String(actorId) !== String(sellerId)) {
        return res.status(403).json({
          error: 'You can only access your own wallet',
          code: 'WALLET_ACCESS_DENIED'
        });
      }

      const dashboard = await walletsService.getWalletDashboard(sellerId);

      return res.status(200).json({
        success: true,
        data: {
          wallet: {
            availableBalance: dashboard.wallet.availableBalance,
            pendingBalance: dashboard.wallet.pendingBalance,
            totalBalance: dashboard.wallet.availableBalance + dashboard.wallet.pendingBalance,
            totalEarned: dashboard.wallet.totalEarned,
            totalCommissionDeducted: dashboard.wallet.totalCommissionDeducted,
            currency: dashboard.wallet.currency,
            status: dashboard.wallet.status
          },
          recentTransactions: dashboard.recentTransactions.map(t => ({
            id: t._id,
            type: t.transactionType,
            amount: t.amount,
            direction: t.direction,
            status: t.status,
            reason: t.reason,
            timestamp: t.transactionAt
          })),
          pendingTransactionCount: dashboard.pendingCount
        }
      });
    } catch (err) {
      console.error('getWalletDashboard error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch dashboard',
        code: 'DASHBOARD_FETCH_ERROR'
      });
    }
  }

  /**
   * GET /api/wallets/:sellerId/transactions
   * Get wallet transaction history with pagination
   * Query params: limit (default 50, max 100), offset (default 0), startDate, endDate
   */
  async getTransactionHistory(req, res) {
    try {
      const { sellerId } = req.params;
      const { limit = 50, offset = 0, startDate, endDate } = req.query;
      const { id: actorId } = req.user || {};

      // Authorization
      if (isSeller(req.user) && String(actorId) !== String(sellerId)) {
        return res.status(403).json({
          error: 'You can only access your own transaction history',
          code: 'TRANSACTION_ACCESS_DENIED'
        });
      }

      const transactions = await walletsService.getTransactionHistory(sellerId, {
        limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
        offset: Math.max(0, parseInt(offset) || 0),
        startDate,
        endDate
      });

      return res.status(200).json({
        success: true,
        data: transactions.map(t => ({
          id: t._id,
          type: t.transactionType,
          amount: t.amount,
          direction: t.direction,
          currency: t.currency,
          status: t.status,
          reason: t.reason,
          balanceAfter: t.balanceAfterTransaction,
          pendingAfter: t.pendingAfterTransaction,
          relatedOrderId: t.orderId,
          relatedPayoutId: t.payoutRequestId,
          timestamp: t.transactionAt
        })),
        pagination: {
          limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
          offset: Math.max(0, parseInt(offset) || 0),
          hasMore: transactions.length === Math.min(Math.max(1, parseInt(limit) || 50), 100)
        }
      });
    } catch (err) {
      console.error('getTransactionHistory error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch transaction history',
        code: 'TRANSACTION_HISTORY_ERROR'
      });
    }
  }

  /**
   * GET /api/wallets/:sellerId/transaction/:transactionId
   * Get specific transaction detail
   */
  async getTransaction(req, res) {
    try {
      const { sellerId, transactionId } = req.params;
      const { id: actorId } = req.user || {};

      // Authorization
      if (isSeller(req.user) && String(actorId) !== String(sellerId)) {
        return res.status(403).json({
          error: 'You can only access your own transactions',
          code: 'TRANSACTION_ACCESS_DENIED'
        });
      }

      const transactions = await walletsService.getTransactionHistory(sellerId, {
        limit: 1000
      });

      const transaction = transactions.find(t => String(t._id) === String(transactionId));
      if (!transaction) {
        return res.status(404).json({
          error: 'Transaction not found',
          code: 'TRANSACTION_NOT_FOUND'
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          id: transaction._id,
          type: transaction.transactionType,
          amount: transaction.amount,
          direction: transaction.direction,
          currency: transaction.currency,
          status: transaction.status,
          reason: transaction.reason,
          actor: transaction.actor,
          actorType: transaction.actorType,
          balanceBeforeTransaction: transaction.balanceBeforeTransaction,
          balanceAfterTransaction: transaction.balanceAfterTransaction,
          pendingBeforeTransaction: transaction.pendingBeforeTransaction,
          pendingAfterTransaction: transaction.pendingAfterTransaction,
          relatedOrderId: transaction.orderId,
          relatedAllocationId: transaction.allocationId,
          relatedPaymentId: transaction.paymentId,
          relatedPayoutId: transaction.payoutRequestId,
          timestamp: transaction.transactionAt,
          metadata: transaction.metadata
        }
      });
    } catch (err) {
      console.error('getTransaction error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch transaction',
        code: 'TRANSACTION_FETCH_ERROR'
      });
    }
  }

  /**
   * ADMIN: GET /api/admin/wallets
   * Get all seller wallets with filtering
   * Query: limit, offset, status (ACTIVE/SUSPENDED/CLOSED), search
   */
  async getAllWallets(req, res) {
    try {
      const { id: actorId } = req.user || {};

      // Authorization: admin only
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ACCESS_DENIED'
        });
      }

      const { limit = 50, offset = 0, status } = req.query;

      const filters = {};
      if (status && ['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(status)) {
        filters.status = status;
      }

      const wallets = await walletsService.getAllWallets(filters, {
        limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
        offset: Math.max(0, parseInt(offset) || 0)
      });

      return res.status(200).json({
        success: true,
        data: wallets.map(w => ({
          id: w._id,
          sellerId: w.sellerId,
          availableBalance: w.availableBalance,
          pendingBalance: w.pendingBalance,
          totalBalance: w.availableBalance + w.pendingBalance,
          totalEarned: w.totalEarned,
          totalCommissionDeducted: w.totalCommissionDeducted,
          totalRefunded: w.totalRefunded,
          totalPaidOut: w.totalPaidOut,
          currency: w.currency,
          status: w.status,
          lastTransactionAt: w.lastTransactionAt,
          lastPayoutAt: w.lastPayoutAt
        })),
        pagination: {
          limit: Math.min(Math.max(1, parseInt(limit) || 50), 100),
          offset: Math.max(0, parseInt(offset) || 0)
        }
      });
    } catch (err) {
      console.error('getAllWallets error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch wallets',
        code: 'WALLETS_FETCH_ERROR'
      });
    }
  }

  /**
   * ADMIN: GET /api/admin/financial-summary
   * Platform-wide financial overview
   */
  async getPlatformFinancialSummary(req, res) {
    try {
      const { id: actorId } = req.user || {};

      // Authorization: admin only
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ACCESS_DENIED'
        });
      }

      const summary = await walletsService.getPlatformFinancialSummary();

      return res.status(200).json({
        success: true,
        data: {
          totalAvailableBalance: summary.totalAvailableBalance || 0,
          totalPendingBalance: summary.totalPendingBalance || 0,
          totalBalance: (summary.totalAvailableBalance || 0) + (summary.totalPendingBalance || 0),
          totalEarned: summary.totalEarned || 0,
          totalCommissionDeducted: summary.totalCommissionDeducted || 0,
          totalRefunded: summary.totalRefunded || 0,
          totalPaidOut: summary.totalPaidOut || 0,
          activeWallets: summary.activeWallets || 0,
          suspendedWallets: summary.suspendedWallets || 0,
          platformCommissionCollected: summary.totalCommissionDeducted || 0,
          netSellerLiability: (summary.totalAvailableBalance || 0) + (summary.totalPendingBalance || 0)
        }
      });
    } catch (err) {
      console.error('getPlatformFinancialSummary error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch financial summary',
        code: 'FINANCIAL_SUMMARY_ERROR'
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/wallets/:walletId/suspend
   * Suspend wallet (prevent payouts)
   * Body: { reason: string }
   */
  async suspendWallet(req, res) {
    try {
      const { walletId } = req.params;
      const { reason } = req.body || {};
      const { id: actorId } = req.user || {};

      // Authorization: admin only
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ACCESS_DENIED'
        });
      }

      if (!reason || !String(reason).trim()) {
        return res.status(400).json({
          error: 'Suspension reason is required',
          code: 'INVALID_REQUEST'
        });
      }

      const wallet = await walletsService.suspendWallet(walletId, reason, {
        actor: actorId,
        actorType: 'ADMIN'
      });

      return res.status(200).json({
        success: true,
        message: 'Wallet suspended successfully',
        data: {
          id: wallet._id,
          status: wallet.status,
          notes: wallet.notes
        }
      });
    } catch (err) {
      console.error('suspendWallet error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to suspend wallet',
        code: 'WALLET_SUSPEND_ERROR'
      });
    }
  }

  /** POST /wallet/admin/wallets/:walletId/reactivate */
  async reactivateWallet(req, res) {
    try {
      const { walletId } = req.params;
      const { reason } = req.body || {};
      const { id: actorId } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_ACCESS_DENIED' });
      }
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'Reactivation reason is required', code: 'INVALID_REQUEST' });
      }

      const wallet = await walletsService.reactivateWallet(walletId, reason, {
        actor: actorId,
        actorType: 'ADMIN',
      });
      return res.status(200).json({
        success: true,
        message: 'Wallet reactivated successfully',
        data: { id: wallet._id, status: wallet.status, notes: wallet.notes },
      });
    } catch (err) {
      console.error('reactivateWallet error:', err);
      return res.status(err.statusCode || 500).json({
        error: err.message || 'Failed to reactivate wallet',
        code: 'WALLET_REACTIVATE_ERROR',
      });
    }
  }

  /** GET /wallet/admin/wallets/export */
  async exportWalletData(req, res) {
    try {
      const { role } = req.user || {};
      if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_ACCESS_DENIED' });
      }

      const result = await walletsService.exportWalletData({
        status: req.query.status,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        format: req.query.format || 'csv',
      });
      if ((req.query.format || 'csv') === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="wallets.csv"');
        return res.status(200).send(result);
      }
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('exportWalletData error:', err);
      return res.status(err.statusCode || 500).json({
        error: err.message || 'Failed to export wallet data',
        code: 'WALLET_EXPORT_ERROR',
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/wallets/:walletId/adjustment
   * Manual wallet adjustment (credit or debit)
   * Body: { amount: number (positive/negative), reason: string }
   */
  async createAdjustment(req, res) {
    try {
      const { walletId } = req.params;
      const { amount, reason } = req.body || {};
      const { id: actorId } = req.user || {};

      // Authorization: admin only
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ACCESS_DENIED'
        });
      }

      if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({
          error: 'Amount must be a non-zero number',
          code: 'INVALID_AMOUNT'
        });
      }

      if (!reason || !String(reason).trim()) {
        return res.status(400).json({
          error: 'Adjustment reason is required',
          code: 'INVALID_REQUEST'
        });
      }

      const result = await walletsService.createAdjustment(walletId, amount, reason, {
        actor: actorId,
        actorType: 'ADMIN'
      });

      return res.status(200).json({
        success: true,
        message: 'Adjustment created successfully',
        data: {
          walletId: result.wallet._id,
          adjustmentAmount: result.adjustment,
          newAvailableBalance: result.wallet.availableBalance,
          newPendingBalance: result.wallet.pendingBalance
        }
      });
    } catch (err) {
      console.error('createAdjustment error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to create adjustment',
        code: 'ADJUSTMENT_ERROR'
      });
    }
  }

  /**
   * Release pending balance to available balance (admin only)
   * Body: { amount?: number, reason?: string }
   */
  async releasePending(req, res) {
    try {
      const { walletId } = req.params;
      const { amount, reason } = req.body || {};
      const { id: actorId } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ACCESS_DENIED'
        });
      }

      let targetWalletId = walletId;
      const wallet = await walletsRepository.getWalletById(walletId).catch(() => null);
      if (!wallet) {
        const bySeller = await walletsRepository.getWalletBySellerId(walletId).catch(() => null);
        if (bySeller) targetWalletId = String(bySeller._id);
      }

      const result = await walletsService.releasePendingBalance(targetWalletId, amount ? Number(amount) : null, {
        actor: actorId,
        actorType: 'ADMIN',
        reason: reason || 'Admin settlement release'
      });

      return res.status(200).json({
        success: true,
        message: 'Pending balance released to available balance',
        data: {
          walletId: result.wallet._id,
          sellerId: result.wallet.sellerId,
          releasedAmount: result.released,
          availableBalance: result.wallet.availableBalance,
          pendingBalance: result.wallet.pendingBalance
        }
      });
    } catch (err) {
      console.error('releasePending error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to release pending balance',
        code: 'RELEASE_PENDING_ERROR'
      });
    }
  }
}

module.exports = new WalletController();
