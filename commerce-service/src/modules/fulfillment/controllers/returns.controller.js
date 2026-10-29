/**
 * Returns Controller — manages buyer return requests, seller return review & approval, refunds, and admin statistics.
 */
'use strict';

const returnsService = require('../services/returns.service');
const { isAdmin } = require('../../../shared/utils/roles');

class ReturnsController {
  /**
   * Request a return for items from a delivered order (buyer action).
   * 
   * @param {import('express').Request} req - Express request with params { orderId } and body { items, reason, comments }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async requestReturn(req, res, next) {
    try {
      const { orderId } = req.params;
      const buyerId = req.user?.id || req.user?._id;
      const { items, reason, comments } = req.body || {};

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

      return res.status(201).json({
        message: 'Return request created',
        return: returnRecord,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Approve a return request and trigger inventory restoration (seller action).
   * 
   * @param {import('express').Request} req - Express request with params { returnId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async approveReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const sellerId = req.user?.id || req.user?._id;

      const returnRecord = await returnsService.approveReturn(returnId, {
        sellerId,
        role: req.user?.role,
      });

      return res.json({
        message: 'Return approved',
        return: returnRecord,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Process refund against an approved return with amount validation.
   * 
   * @param {import('express').Request} req - Express request with params { returnId } and body { amount, method, notes }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async processRefund(req, res, next) {
    try {
      const { returnId } = req.params;
      const { amount, method, notes } = req.body || {};

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

      return res.json({
        message: 'Refund processed successfully',
        refund: result,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Reject a return request with explanation (seller action).
   * 
   * @param {import('express').Request} req - Express request with params { returnId } and body { reason }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async rejectReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const sellerId = req.user?.id || req.user?._id;
      const { reason } = req.body || {};

      const returnRecord = await returnsService.rejectReturn(returnId, {
        sellerId,
        reason,
        role: req.user?.role,
      });

      return res.json({
        message: 'Return rejected',
        return: returnRecord,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Retrieve full details of a specific return request.
   * 
   * @param {import('express').Request} req - Express request with params { returnId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getReturn(req, res, next) {
    try {
      const { returnId } = req.params;
      const returnRecord = await returnsService.getReturn(returnId, {
        userId: req.user?.id || req.user?._id,
        role: req.user?.role,
      });

      return res.json(returnRecord);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Retrieve summary return status counters for a seller's shop dashboard.
   * 
   * @param {import('express').Request} req - Express request with params { shopId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getSellerReturnsDashboard(req, res, next) {
    try {
      const { shopId } = req.params;
      const result = await returnsService.getSellerReturnsDashboard(shopId);
      return res.json({ success: true, data: { shopId, ...result } });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Admin: List returns with pagination and status/participant filtering.
   * GET /api/admin/returns/list
   * 
   * @param {import('express').Request} req - Express request with query { page, limit, status, buyerId, sellerId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async listReturns(req, res, next) {
    try {
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY',
        });
      }

      const { status, buyerId, sellerId } = req.query || {};
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

      const result = await returnsService.listReturns({
        page,
        limit,
        status,
        buyerId,
        sellerId,
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Admin: Retrieve platform-wide return metrics and statistics.
   * GET /api/admin/returns/stats
   * 
   * @param {import('express').Request} req - Express request with query { startDate, endDate }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getStats(req, res, next) {
    try {
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          error: 'Admin access required',
          code: 'ADMIN_ONLY',
        });
      }

      const { startDate, endDate } = req.query || {};
      const stats = await returnsService.getStats({
        startDate,
        endDate,
      });

      return res.json({
        success: true,
        data: stats,
      });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new ReturnsController();

