const express = require('express');
const payoutsController = require('../controllers/payouts.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

const router = express.Router();

/**
 * PAYOUT ROUTES
 * 
 * Seller endpoints:
 * - POST /api/payouts/request - Request payout
 * - GET /api/payouts - List own payouts
 * - GET /api/payouts/:payoutId - Get payout detail
 * 
 * Admin endpoints:
 * - GET /api/admin/payouts/pending - List pending
 * - POST /api/admin/payouts/:payoutId/approve - Approve
 * - POST /api/admin/payouts/:payoutId/reject - Reject
 * - POST /api/admin/payouts/:payoutId/complete - Complete
 * - POST /api/admin/payouts/:payoutId/fail - Mark failed
 * - GET /api/admin/payouts/statistics/platform - Stats
 */

// SELLER ENDPOINTS

/**
 * POST /api/payouts/request
 * Request payout from available balance
 */
router.post(
  '/request',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await payoutsController.requestPayout(req, res);
  }
);

/**
 * GET /api/payouts
 * List seller's payout requests
 */
router.get(
  '/',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await payoutsController.getSellerPayouts(req, res);
  }
);

/**
 * GET /api/payouts/:payoutId
 * Get payout detail
 */
router.get(
  '/:payoutId',
  authenticate,
  authorize(['SELLER', 'ADMIN']),
  async (req, res) => {
    await payoutsController.getPayout(req, res);
  }
);

// ADMIN ENDPOINTS

/**
 * GET /api/admin/payouts/pending
 * Get all pending payouts
 */
router.get(
  '/admin/payouts/pending',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.getPendingPayouts(req, res);
  }
);

/**
 * GET /api/admin/payouts/statistics/platform
 * Get platform payout statistics
 */
router.get(
  '/admin/payouts/statistics/platform',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.getPlatformPayoutStats(req, res);
  }
);

/**
 * POST /api/admin/payouts/:payoutId/approve
 * Approve payout request
 */
router.post(
  '/admin/payouts/:payoutId/approve',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.approvePayout(req, res);
  }
);

/**
 * POST /api/admin/payouts/:payoutId/reject
 * Reject payout request and refund
 */
router.post(
  '/admin/payouts/:payoutId/reject',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.rejectPayout(req, res);
  }
);

/**
 * POST /api/admin/payouts/:payoutId/complete
 * Complete successful payout
 */
router.post(
  '/admin/payouts/:payoutId/complete',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.completePayout(req, res);
  }
);

/**
 * POST /api/admin/payouts/:payoutId/fail
 * Mark payout as failed, refund funds
 */
router.post(
  '/admin/payouts/:payoutId/fail',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.failPayout(req, res);
  }
);

// ADMIN: Get all payouts
router.get(
  '/admin/payouts',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.getAllPayouts(req, res);
  }
);

// ADMIN: Export payout data
router.get(
  '/admin/payouts/export',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    await payoutsController.exportPayoutData(req, res);
  }
);

module.exports = router;
