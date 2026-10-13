// Admin endpoints for order management.
//
// Every failure is forwarded with next(err) so the central errorHandler maps it
// (invalid ObjectId -> 400 INVALID_ID, not-found -> 404, unexpected -> masked
// 500). Responding with res.status(500) here used to leak the raw driver
// message and turned a bad identifier into a server fault.
const express = require('express');
const router = express.Router();
const Order = require('../models/Orders');
const { ORDER_STATUSES, ORDER_STATUS_VALUES, normalizeStatus, canTransition } = require('../constants/orderStatuses');
const productService = require('../../catalog/services/products.service');
const orderService = require('../services/orders.service');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');

// Admin list all orders
router.get('/admin', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const query = {};
    if (status && status !== '') {
      // The filter must go through the same normalization the write path uses.
      // A raw pass-through meant `?status=Delivered` silently missed every
      // legacy `DELIVERED` row, so the console reported an order as missing
      // while the analytics endpoint (which does normalize) counted it.
      const requested = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      const normalized = requested.map((s) => normalizeStatus(s));
      const unknown = normalized.filter((s) => !ORDER_STATUS_VALUES.includes(s));
      if (unknown.length > 0) {
        return res.status(400).json({
          success: false,
          code: 'UNKNOWN_STATUS',
          message: `Unknown order status: ${unknown.join(', ')}`,
          allowed: ORDER_STATUS_VALUES,
        });
      }
      query.status = normalized.length === 1 ? normalized[0] : { $in: normalized };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (pageNum - 1) * limitNum;

    const orders = await Order.find(query)
      .skip(skip)
      .limit(limitNum)
      .sort({ createdAt: -1 });
    const total = await Order.countDocuments(query);

    return res.json({
      success: true,
      orders,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    return next(err);
  }
});

// Admin get order detail
router.get('/admin/:orderId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found', errors: [] });
    }
    return res.json({ success: true, order });
  } catch (err) {
    return next(err);
  }
});

// Admin update order status.
//
// Validated against the ONE order state machine
// (orders/constants/orderStatuses.js). The route previously wrote whatever it was
// given, so an admin could move an order to any state — including backwards out
// of Cancelled or to a value no service recognises.
//
// Legacy rows: if the stored status is not a known status (older data used other
// spellings), the transition cannot be validated, so the update is allowed and the
// response says so. Everything else must be a legal transition.
router.put('/admin/:orderId/status', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !Object.values(ORDER_STATUSES).includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Unknown order status: ${status}`,
        allowed: Object.values(ORDER_STATUSES),
        errors: [],
      });
    }

    const oldOrder = await Order.findById(req.params.orderId);
    if (!oldOrder) {
      return res.status(404).json({ success: false, message: 'Order not found', errors: [] });
    }

    const currentIsKnown = Object.values(ORDER_STATUSES).includes(oldOrder.status);
    const transitionValidated = currentIsKnown;
    if (currentIsKnown && oldOrder.status === status) {
      const order = status === ORDER_STATUSES.CONFIRMED
        ? await orderService.updateOrderStatus(req.params.orderId, { status })
        : oldOrder;
      return res.json({ success: true, order, unchanged: true });
    }
    if (currentIsKnown && !canTransition(oldOrder.status, status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot move an order from ${oldOrder.status} to ${status}`,
        from: oldOrder.status,
        to: status,
        errors: [],
      });
    }

    if (status === ORDER_STATUSES.DELIVERED) {
      return res.status(409).json({ success: false, code: 'DELIVERY_OWNED_BY_DELIVERY_SERVICE', message: 'Mark the shipment delivered through the delivery workflow', errors: [] });
    }
    if ([ORDER_STATUSES.REFUND_REQUESTED, ORDER_STATUSES.REFUND_APPROVED, ORDER_STATUSES.REFUND_SUCCESS, ORDER_STATUSES.REFUND_REJECTED].includes(status)) {
      return res.status(409).json({ success: false, code: 'REFUND_WORKFLOW_REQUIRED', message: 'Refund status changes require the refund workflow', errors: [] });
    }

    if (status === ORDER_STATUSES.CANCELLED) {
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ success: false, message: 'A cancellation reason is required', errors: [] });
      const cancelled = await orderService.cancelOrder(req.params.orderId, reason);
      sendAudit({
        action: ACTIONS.ORDER_STATUS_CHANGED,
        ...getAdminFromReq(req),
        module: 'commerce', targetEntity: 'order', targetId: String(cancelled._id),
        previousValue: { status: oldOrder.status }, newValue: { status: cancelled.status },
        details: { reason, totalPrice: cancelled.totalPrice, transitionValidated: true },
      });
      return res.json({ success: true, order: cancelled, transitionValidated: true });
    }

    const order = await orderService.updateOrderStatus(req.params.orderId, { status });

    sendAudit({
      action: ACTIONS.ORDER_STATUS_CHANGED,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'order',
      targetId: String(order._id),
      previousValue: { status: oldOrder.status },
      newValue: { status },
      details: { totalPrice: order.totalPrice, transitionValidated },
    });
    return res.json({ success: true, order, transitionValidated });
  } catch (err) {
    return next(err);
  }
});

// Admin list orders awaiting review moderation.
//
// Reviews are stored on the Product documents (see products.services), so this
// delegates to the product service which pages over the embedded reviews.
router.get('/admin/reviews/pending', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const result = await productService.listPendingReviews({
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 10,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
});

// Approve a review — publishes it and recomputes the product rating from
// approved reviews only.
router.post('/admin/reviews/:reviewId/approve', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { review, ratings } = await productService.moderateReview(req.params.reviewId, {
      action: 'approve',
      adminId: req.user ? req.user.id : null,
    });
    sendAudit({
      action: ACTIONS.REVIEW_APPROVED,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'product_review',
      targetId: req.params.reviewId,
      newValue: { status: review ? review.status : null },
      details: {
        productId: review ? review.productId : null,
        operation: 'review_approved',
        ratings,
      },
    });
    return res.json({ success: true, review, ratings });
  } catch (err) {
    return next(err);
  }
});

// Reject a review — requires a reason (kept for the moderation trail).
router.post('/admin/reviews/:reviewId/reject', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const { review, ratings } = await productService.moderateReview(req.params.reviewId, {
      action: 'reject',
      reason,
      adminId: req.user ? req.user.id : null,
    });
    sendAudit({
      action: ACTIONS.REVIEW_REJECTED,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'product_review',
      targetId: req.params.reviewId,
      newValue: { status: review ? review.status : null },
      details: {
        productId: review ? review.productId : null,
        operation: 'review_rejected',
        reason: reason || null,
        ratings,
      },
    });
    return res.json({ success: true, review, ratings });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
