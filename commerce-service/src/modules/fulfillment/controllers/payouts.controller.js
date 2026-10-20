const payoutsService = require('../services/payouts.service');
const { isSeller, isAdmin } = require('../../../shared/utils/roles');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * PAYOUT CONTROLLER
 * 
 * Handles payout request endpoints.
 * 
 * Seller: Request payout, view own requests
 * Admin: Approve, reject, complete, fail payouts
 */
class PayoutController {
  /**
   * POST /api/payouts/request
   * Seller requests payout
   */
  async requestPayout(req, res) {
    try {
      const { id: sellerId, role } = req.user || {};

      if (!isSeller(req.user)) {
        return res.status(403).json({
          error: 'Only sellers can request payouts',
          code: 'SELLER_ONLY'
        });
      }

      const { amount, payoutMethod, payoutDetails } = req.body || {};

      const result = await payoutsService.requestPayout(
        sellerId,
        amount,
        payoutMethod,
        payoutDetails
      );

      return res.status(201).json({
        success: true,
        message: 'Payout request submitted successfully',
        data: {
          payoutRequestId: result.payoutRequest._id,
          amount: result.deductedAmount,
          processingFee: result.processingFee,
          netPayoutAmount: result.netPayoutAmount,
          remainingBalance: result.remainingBalance,
          status: result.payoutRequest.status
        }
      });
    } catch (err) {
      console.error('requestPayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to request payout',
        code: 'PAYOUT_REQUEST_ERROR'
      });
    }
  }

  /**
   * GET /api/payouts
   * Get seller's payout requests
   */
  async getSellerPayouts(req, res) {
    try {
      const { id: sellerId, role } = req.user || {};
      const { limit = 50, offset = 0, status } = req.query;

      // The route's authorize(['SELLER', 'ADMIN']) is the authority check. Do
      // not repeat it against only the primary role here: seller capabilities
      // may be secondary to BUYER, and an admin may also inspect their own list.
      if (!sellerId) {
        return res.status(400).json({ error: 'Authenticated user ID required', code: 'USER_ID_REQUIRED' });
      }

      const payouts = await payoutsService.getSellerPayouts(sellerId, {
        limit: Math.min(Math.max(1, parseInt(limit)), 100),
        offset: Math.max(0, parseInt(offset)),
        status
      });

      return res.status(200).json({
        success: true,
        data: payouts.map(p => ({
          id: p._id,
          amount: p.amount,
          status: p.status,
          payoutMethod: p.payoutMethod,
          processingFee: p.processingFee,
          netPayoutAmount: p.netPayoutAmount,
          requestedAt: p.createdAt,
          approvedAt: p.approvedAt,
          processedAt: p.processedAt,
          transactionId: p.transactionId
        }))
      });
    } catch (err) {
      console.error('getSellerPayouts error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch payouts',
        code: 'PAYOUTS_FETCH_ERROR'
      });
    }
  }

  /**
   * GET /api/payouts/:payoutId
   * Get specific payout
   */
  async getPayout(req, res) {
    try {
      const { payoutId } = req.params;
      const { id: actorId, role } = req.user || {};

      const payout = await payoutsService.getPayout(
        payoutId,
        isSeller(req.user) ? actorId : null
      );

      return res.status(200).json({
        success: true,
        data: {
          id: payout._id,
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
          payoutMethod: payout.payoutMethod,
          payoutDetails: payout.payoutDetails,
          processingFee: payout.processingFee,
          netPayoutAmount: payout.netPayoutAmount,
          isVerified: payout.isVerified,
          requestedAt: payout.createdAt,
          approvedAt: payout.approvedAt,
          approvedBy: payout.approvedBy,
          processedAt: payout.processedAt,
          processedBy: payout.processedBy,
          transactionId: payout.transactionId,
          rejectionReason: payout.rejectionReason,
          cancellationReason: payout.cancellationReason
        }
      });
    } catch (err) {
      console.error('getPayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch payout',
        code: 'PAYOUT_FETCH_ERROR'
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/payouts/:payoutId/approve
   * Approve payout request
   */
  async approvePayout(req, res) {
    try {
      const { payoutId } = req.params;
      const { notes } = req.body || {};
      const { id: adminId, role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const payout = await payoutsService.approvePayout(payoutId, adminId, notes);

      return res.status(200).json({
        success: true,
        message: 'Payout request approved',
        data: {
          id: payout._id,
          status: payout.status,
          approvedAt: payout.approvedAt
        }
      });
    } catch (err) {
      console.error('approvePayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to approve payout',
        code: 'PAYOUT_APPROVE_ERROR'
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/payouts/:payoutId/reject
   * Reject payout request
   */
  async rejectPayout(req, res) {
    try {
      const { payoutId } = req.params;
      const { reason } = req.body || {};
      const { id: adminId, role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      if (!reason) {
        return res.status(400).json({
          error: 'Rejection reason is required',
          code: 'INVALID_REQUEST'
        });
      }

      const result = await payoutsService.rejectPayout(payoutId, reason, adminId);

      return res.status(200).json({
        success: true,
        message: 'Payout request rejected',
        data: {
          id: result.payout._id,
          status: result.payout.status,
          refundedAmount: result.refundedAmount,
          reason: result.reason
        }
      });
    } catch (err) {
      console.error('rejectPayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to reject payout',
        code: 'PAYOUT_REJECT_ERROR'
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/payouts/:payoutId/complete
   * Complete successful payout
   */
  async completePayout(req, res) {
    try {
      const { payoutId } = req.params;
      const { transactionId, providerResponse } = req.body || {};
      const { id: adminId, role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const payout = await payoutsService.completePayout(
        payoutId,
        transactionId,
        providerResponse,
        adminId
      );

      return res.status(200).json({
        success: true,
        message: 'Payout completed successfully',
        data: {
          id: payout._id,
          status: payout.status,
          transactionId: payout.transactionId,
          netPayoutAmount: payout.netPayoutAmount,
          completedAt: payout.processedAt
        }
      });
    } catch (err) {
      console.error('completePayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to complete payout',
        code: 'PAYOUT_COMPLETE_ERROR'
      });
    }
  }

  /**
   * ADMIN: POST /api/admin/payouts/:payoutId/fail
   * Mark payout as failed (refund funds)
   */
  async failPayout(req, res) {
    try {
      const { payoutId } = req.params;
      const { reason, transactionId, providerResponse } = req.body || {};
      const { id: adminId, role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      if (!reason) {
        return res.status(400).json({
          error: 'Failure reason is required',
          code: 'INVALID_REQUEST'
        });
      }

      const result = await payoutsService.failPayout(
        payoutId,
        reason,
        transactionId,
        providerResponse,
        adminId
      );

      return res.status(200).json({
        success: true,
        message: 'Payout marked as failed, funds refunded',
        data: {
          id: result.payout._id,
          status: result.payout.status,
          refundedAmount: result.refundedAmount,
          reason: result.reason
        }
      });
    } catch (err) {
      console.error('failPayout error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to mark payout as failed',
        code: 'PAYOUT_FAIL_ERROR'
      });
    }
  }

  /**
   * ADMIN: GET /api/admin/payouts/pending
   * Get all pending payouts
   */
  async getPendingPayouts(req, res) {
    try {
      const { id: adminId, role } = req.user || {};
      const { limit = 50, offset = 0 } = req.query;

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const payouts = await payoutsService.getPendingPayouts({
        limit: Math.min(Math.max(1, parseInt(limit)), 100),
        offset: Math.max(0, parseInt(offset))
      });

      return res.status(200).json({
        success: true,
        data: payouts.map(p => ({
          id: p._id,
          sellerId: p.sellerId,
          amount: p.amount,
          payoutMethod: p.payoutMethod,
          requestedAt: p.createdAt,
          netPayoutAmount: p.netPayoutAmount
        }))
      });
    } catch (err) {
      console.error('getPendingPayouts error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch pending payouts',
        code: 'PENDING_PAYOUTS_ERROR'
      });
    }
  }

  /**
   * ADMIN: GET /api/admin/payouts/statistics/platform
   * Get platform payout statistics
   */
  async getPlatformPayoutStats(req, res) {
    try {
      const { id: adminId, role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const stats = await payoutsService.getPlatformPayoutStats();

      return res.status(200).json({
        success: true,
        data: {
          totalRequested: stats.totalRequested || 0,
          totalCompleted: stats.totalCompleted || 0,
          totalFailed: stats.totalFailed || 0,
          totalPending: stats.totalPending || 0,
          totalProcessingFees: stats.totalProcessingFees || 0,
          completedCount: stats.completedCount || 0,
          failedCount: stats.failedCount || 0,
          pendingCount: stats.pendingCount || 0
        }
      });
    } catch (err) {
      console.error('getPlatformPayoutStats error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch payout statistics',
        code: 'STATS_ERROR'
      });
    }
  }
/**
   * ADMIN: GET /api/admin/payouts
   * Get all payouts with filtering
   */
  async getAllPayouts(req, res) {
    try {
      const { role } = req.user || {};
      const { limit = 50, offset = 0, status, startDate, endDate } = req.query;

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const payouts = await payoutsService.getAllPayouts({
        limit: Math.min(Math.max(1, parseInt(limit)), 100),
        offset: Math.max(0, parseInt(offset)),
        status,
        startDate,
        endDate
      });

      return res.status(200).json({
        success: true,
        data: payouts.map(p => ({
          id: p._id,
          sellerId: p.sellerId,
          amount: p.amount,
          status: p.status,
          payoutMethod: p.payoutMethod,
          processingFee: p.processingFee,
          netPayoutAmount: p.netPayoutAmount,
          requestedAt: p.createdAt,
          approvedAt: p.approvedAt,
          processedAt: p.processedAt,
          transactionId: p.transactionId
        }))
      });
    } catch (err) {
      console.error('getAllPayouts error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to fetch payouts',
        code: 'PAYOUTS_FETCH_ERROR'
      });
    }
  }

  /**
   * ADMIN: GET /api/admin/payouts/export
   * Export payout data to CSV
   */
  async exportPayoutData(req, res) {
    try {
      const { role } = req.user || {};

      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const { status, startDate, endDate, format = 'csv' } = req.query;

      const csvData = await payoutsService.exportPayoutData({
        status,
        startDate,
        endDate,
        format
      });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="payouts-export-${new Date().toISOString().split('T')[0]}.csv"`);
        return res.status(200).send(csvData);
      }

      return res.status(200).json({
        success: true,
        data: csvData
      });
    } catch (err) {
      console.error('exportPayoutData error:', err);
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to export payout data',
        code: 'PAYOUT_EXPORT_ERROR'
      });
    }
  }
}

module.exports = new PayoutController();
