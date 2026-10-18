const express = require('express');
const router = express.Router();
const returnsService = require('../services/returns.service');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { ok } = require('../../../shared/utils/response');

/**
 * FIX #9: Returns Management Routes
 */

// Buyer creates return request
router.post('/', authenticate, authorize('BUYER'), async (req, res, next) => {
  try {
    const { orderId, reason, description, images, items, returnAmount } = req.body;
    const returnRequest = await returnsService.createReturn(orderId, req.user.id, {
      reason,
      description,
      images,
      items,
      returnAmount
    });
    return ok(res, { return: returnRequest }, 'Return request created', 201);
  } catch (err) { return next(err); }
});

// Get specific return
router.get('/:returnId', authenticate, async (req, res, next) => {
  try {
    const returnRequest = await returnsService.getReturn(req.params.returnId, req.user.id, req.user.role);
    return ok(res, { return: returnRequest });
  } catch (err) { return next(err); }
});

// Buyer list their returns
router.get('/list/mine', authenticate, authorize('BUYER'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const result = await returnsService.getBuyerReturns(req.user.id, { page: Number(page), limit: Number(limit) });
    return ok(res, result);
  } catch (err) { return next(err); }
});

// Buyer cancel return request
router.post('/:returnId/cancel', authenticate, async (req, res, next) => {
  try {
    const returnRequest = await returnsService.cancelReturn(req.params.returnId, req.user.id, req.user.role);
    return ok(res, { return: returnRequest }, 'Return cancelled');
  } catch (err) { return next(err); }
});

// ── SELLER ROUTES ──────────────────────────────────────────────────────
// Seller view returns for their products
router.get('/seller/list', authenticate, authorize('SELLER'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const result = await returnsService.getSellerReturns(req.user.id, {
      page: Number(page),
      limit: Number(limit),
      status
    });
    return ok(res, result);
  } catch (err) { return next(err); }
});

// Seller mark return as picked up
router.post('/:returnId/picked-up', authenticate, authorize('SELLER'), async (req, res, next) => {
  try {
    const returnRequest = await returnsService.markPickedUp(req.params.returnId, req.user.id);
    return ok(res, { return: returnRequest }, 'Return marked as picked up');
  } catch (err) { return next(err); }
});

// Seller confirm goods received
router.post('/:returnId/returned', authenticate, authorize('SELLER'), async (req, res, next) => {
  try {
    const returnRequest = await returnsService.confirmReturned(req.params.returnId, req.user.id);
    return ok(res, { return: returnRequest }, 'Return confirmed received');
  } catch (err) { return next(err); }
});

// ── ADMIN ROUTES ───────────────────────────────────────────────────────
// Admin list all returns
router.get('/admin/list', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, buyerId, sellerId } = req.query;
    const result = await returnsService.listReturns({
      page: Number(page),
      limit: Number(limit),
      status,
      buyerId,
      sellerId
    });
    return ok(res, result);
  } catch (err) { return next(err); }
});

// Admin approve return
router.post('/:returnId/approve', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { notes } = req.body || {};
    const returnRequest = await returnsService.approveReturn(req.params.returnId, req.user.id, notes);
    return ok(res, { return: returnRequest }, 'Return approved');
  } catch (err) { return next(err); }
});

// Admin reject return
router.post('/:returnId/reject', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { rejectionReason } = req.body || {};
    const returnRequest = await returnsService.rejectReturn(req.params.returnId, req.user.id, rejectionReason);
    return ok(res, { return: returnRequest }, 'Return rejected');
  } catch (err) { return next(err); }
});

// Admin process refund
router.post('/:returnId/refund', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { paymentId } = req.body || {};
    const returnRequest = await returnsService.processRefund(req.params.returnId, paymentId);
    return ok(res, { return: returnRequest }, 'Refund processed');
  } catch (err) { return next(err); }
});

// Admin returns statistics
router.get('/admin/stats', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await returnsService.getStats({
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null
    });
    return ok(res, stats);
  } catch (err) { return next(err); }
});

module.exports = router;
