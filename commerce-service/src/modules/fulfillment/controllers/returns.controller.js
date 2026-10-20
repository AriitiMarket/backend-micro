/**
 * Returns Controller
 * FIX #3: Unified returns/refunds workflow
 * FIX #6: Refund amount validation
 * FIX #15: Backend support for seller returns dashboard
 */

const returnsService = require('../services/returns.service');

class ReturnsController {
  /**
   * Request return (buyer initiated)
   */
  async requestReturn(req, res, next) {
    try {
      const { orderId } = req.params;
      const buyerId = req.user?.id || req.user?._id;
      const { items, reason, comments } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items array required' });
      }

      const returnRecord = await returnsService.requestReturn(orderId, {
        buyerId,
        items,
        reason,
        comments,
        role: req.user?.role,
      });

      res.status(201).json({
        message: 'Return request created',
        return: returnRecord,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Approve return (seller action)
   * FIX #3: Triggers inventory restoration
   */
  async approveReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const sellerId = req.user?.id || req.user?._id;

      const returnRecord = await returnsService.approveReturn(returnId, {
        sellerId,
        role: req.user?.role,
      });

      res.json({
        message: 'Return approved',
        return: returnRecord,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Process refund
   * FIX #6: Validates refund amount does not exceed order total
   */
  async processRefund(req, res, next) {
    try {
      const { returnId } = req.params;
      const { amount, method, notes } = req.body;

      const result = await returnsService.processRefund(returnId, {
        amount,
        method,
        notes,
      }, {
        sellerId: req.user?.id || req.user?._id,
        userId: req.user?.id || req.user?._id,
        actorType: req.user?.role,
        role: req.user?.role,
      });

      res.json({
        message: 'Refund processed successfully',
        refund: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Reject return (seller action)
   */
  async rejectReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const sellerId = req.user?.id || req.user?._id;
      const { reason } = req.body;

      const returnRecord = await returnsService.rejectReturn(returnId, {
        sellerId,
        reason,
        role: req.user?.role,
      });

      res.json({
        message: 'Return rejected',
        return: returnRecord,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get return details
   */
  async getReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const returnRecord = await returnsService.getReturn(returnId, {
        userId: req.user?.id || req.user?._id,
        role: req.user?.role,
      });

      res.json(returnRecord);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get seller returns dashboard (FIX #15 backend)
   * Shows pending, approved, inspecting, completed counts
   */
  async getSellerReturnsDashboard(req, res, next) {
    try {
      const { shopId } = req.params;
      const result = await returnsService.getSellerReturnsDashboard(shopId);
      res.json({ success: true, data: { shopId, ...result } });
    } catch (err) {
      next(err);
    }
  }
/**
   * ADMIN: GET /api/admin/returns/list
   * List all returns with pagination and filters
   */
  async listReturns(req, res, next) {
    try {
      const { role } = req.user || {};
      const { page = 1, limit = 20, status, buyerId, sellerId } = req.query;

      if (!isAdmin(role)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const result = await returnsService.listReturns({
        page: parseInt(page),
        limit: parseInt(limit),
        status,
        buyerId,
        sellerId
      });

      res.json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * ADMIN: GET /api/admin/returns/stats
   * Get returns statistics
   */
  async getStats(req, res, next) {
    try {
      const { role } = req.user || {};
      const { startDate, endDate } = req.query;

      if (!isAdmin(role)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY'
        });
      }

      const stats = await returnsService.getStats({
        startDate,
        endDate
      });

      res.json({
        success: true,
        data: stats
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ReturnsController();
