const express = require('express');
const walletsController = require('../controllers/wallets.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

const router = express.Router();

/**
 * WALLET ROUTES
 * 
 * Admin endpoints (admin role required):
 * - GET /admin/wallets - List all wallets
 * - GET /admin/financial-summary - Platform financial overview
 * - POST /admin/wallets/:walletId/suspend - Suspend wallet
 * - POST /admin/wallets/:walletId/adjustment - Manual adjustment
 * 
 * Seller endpoints (auth required):
 * - GET /:sellerId - Get wallet
 * - GET /:sellerId/dashboard - Get dashboard summary
 * - GET /:sellerId/transactions - Get transaction history
 * - GET /:sellerId/transaction/:transactionId - Get transaction detail
 */

// ADMIN ENDPOINTS (MUST COME FIRST to avoid /:sellerId matching)

/**
 * GET /admin/wallets
 * Get all seller wallets (admin only)
 * 
 * Authorization: Admin role only
 * 
 * Query parameters:
 * - limit: number (default 50, max 100)
 * - offset: number (default 0)
 * - status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' (optional filter)
 * 
 * Response:
 * {
 *   success: true,
 *   data: [ { id, sellerId, availableBalance, pendingBalance, ... }, ... ],
 *   pagination: { limit, offset }
 * }
 */
router.get(
  '/admin/wallets',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.getAllWallets(req, res);
  }
);

/**
 * GET /admin/financial-summary
 * Get platform-wide financial overview (admin only)
 * 
 * Authorization: Admin role only
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     totalAvailableBalance, totalPendingBalance, totalBalance,
 *     totalEarned, totalCommissionDeducted, totalRefunded, totalPaidOut,
 *     activeWallets, suspendedWallets,
 *     platformCommissionCollected, netSellerLiability
 *   }
 * }
 */
router.get(
  '/admin/financial-summary',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.getPlatformFinancialSummary(req, res);
  }
);

/**
 * POST /admin/wallets/:walletId/suspend
 * Suspend wallet (prevent payouts) - admin only
 * 
 * Authorization: Admin role only
 * 
 * Body:
 * {
 *   reason: string (required) - Why wallet is being suspended
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   message: 'Wallet suspended successfully',
 *   data: { id, status: 'SUSPENDED', notes }
 * }
 */
router.post(
  '/admin/wallets/:walletId/suspend',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.suspendWallet(req, res);
  }
);

/**
 * POST /admin/wallets/:walletId/adjustment
 * Create manual wallet adjustment (credit or debit) - admin only
 * 
 * Authorization: Admin role only
 * 
 * Body:
 * {
 *   amount: number (required, positive for credit, negative for debit),
 *   reason: string (required) - Why adjustment is being made
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   message: 'Adjustment created successfully',
 *   data: {
 *     walletId, adjustmentAmount, newAvailableBalance, newPendingBalance
 *   }
 * }
 */
router.post(
  '/admin/wallets/:walletId/adjustment',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.createAdjustment(req, res);
  }
);

// SELLER ENDPOINTS

/**
 * GET /:sellerId
 * Get seller wallet with current balances
 * 
 * Authorization: Seller (own wallet only) or Admin
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     id, sellerId, availableBalance, pendingBalance, totalBalance,
 *     totalEarned, totalCommissionDeducted, currency, status, ...
 *   }
 * }
 */
router.get(
  '/:sellerId',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await walletsController.getWallet(req, res);
  }
);

/**
 * GET /:sellerId/dashboard
 * Get wallet summary for dashboard
 * 
 * Authorization: Seller (own wallet only) or Admin
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     wallet: { availableBalance, pendingBalance, ... },
 *     recentTransactions: [ { id, type, amount, direction, timestamp, ... }, ... ],
 *     pendingTransactionCount: number
 *   }
 * }
 */
router.get(
  '/:sellerId/dashboard',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await walletsController.getWalletDashboard(req, res);
  }
);

/**
 * GET /:sellerId/transactions
 * Get wallet transaction history with pagination
 * 
 * Authorization: Seller (own wallet only) or Admin
 * 
 * Query parameters:
 * - limit: number (default 50, max 100)
 * - offset: number (default 0)
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 * 
 * Response:
 * {
 *   success: true,
 *   data: [ { id, type, amount, direction, status, timestamp, ... }, ... ],
 *   pagination: { limit, offset, hasMore }
 * }
 */
router.get(
  '/:sellerId/transactions',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await walletsController.getTransactionHistory(req, res);
  }
);

/**
 * GET /:sellerId/transaction/:transactionId
 * Get specific transaction detail
 * 
 * Authorization: Seller (own wallet only) or Admin
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     id, type, amount, direction, currency, status, reason,
 *     balanceBeforeTransaction, balanceAfterTransaction,
 *     relatedOrderId, relatedAllocationId, relatedPaymentId,
 *     timestamp, metadata, ...
 *   }
 * }
 */
router.get(
  '/:sellerId/transaction/:transactionId',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await walletsController.getTransaction(req, res);
  }
);

// ADMIN: Reactivate wallet
router.post(
  '/admin/wallets/:walletId/reactivate',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.reactivateWallet(req, res);
  }
);

// ADMIN: Release pending balance to available balance
router.post(
  '/admin/wallets/:walletId/release',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.releasePending(req, res);
  }
);

// ADMIN: Export wallet data
router.get(
  '/admin/wallets/export',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await walletsController.exportWalletData(req, res);
  }
);

module.exports = router;
