const allocationService = require('../services/allocation.service');
const { ok } = require('../../../shared/utils/response');
const { isAdmin, isSeller } = require('../../../shared/utils/roles');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * Seller: list their own allocations. A seller can ONLY ever see their own
 * rows — the service scopes by sellerId and the controller validates the
 * requested sellerId matches the authenticated caller.
 */
async function getSellerAllocations(req, res, next) {
  try {
    const { sellerId } = req.params;
    if (!isAdmin(req.user) && String(sellerId) !== String(req.user.id)) {
      return res.status(403).json({
        success: false, message: 'Forbidden: you can only view your own allocations', errors: [],
      });
    }
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.orderId) filter.orderId = req.query.orderId;
    const allocations = await allocationService.getSellerAllocations(sellerId, filter);
    return ok(res, { allocations, total: allocations.length });
  } catch (err) { return next(err); }
}

module.exports = { getSellerAllocations };
/**
 * Admin: list all allocations with filters and pagination.
 * Filters: sellerId, orderId, orderGroupId, status, from, to, search.
 */
async function getAdminAllocations(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const filter = {};
    if (req.query.sellerId) filter.sellerId = req.query.sellerId;
    if (req.query.orderId) filter.orderId = req.query.orderId;
    if (req.query.orderGroupId) filter.orderGroupId = req.query.orderGroupId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) filter.$or = [{ orderId: req.query.search }, { sellerId: req.query.search }];
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const SellerAllocationRepository = require('../repositories/sellerAllocation.repository');
    const [rows, count] = await Promise.all([
      SellerAllocationRepository.findAll(filter, { skip, limit, sort: { createdAt: -1 } }),
      SellerAllocationRepository.count(filter),
    ]);
    return ok(res, { allocations: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) });
  } catch (err) { return next(err); }
}

/**
 * Admin: allocation breakdown for one buyer order (order id or order group id).
 */
async function getAdminOrderAllocations(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const allocations = await allocationService.getOrderAllocations(req.params.orderId);
    return ok(res, { orderId: req.params.orderId, allocations, total: allocations.length });
  } catch (err) { return next(err); }
}

/**
 * Admin: record a settlement (payout) for one allocation. Audited.
 */
async function settleAllocation(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const { allocationId } = req.params;
    const { amount, reference, provider, reason } = req.body || {};
    const result = await allocationService.settleAllocation(allocationId, {
      amount, reference, provider,
      initiatedBy: req.user.id, initiatedByRole: req.user.role, reason,
      actor: req.user,
    });
    return ok(res, result, 'Settlement recorded');
  } catch (err) { return next(err); }
}

/**
 * Admin: record a refund against one allocation (reduces what the seller is owed).
 * Delegates to the allocation service (save-based so netPayable/pendingAmount
 * are recomputed) and emits an audit event.
 */
async function refundAllocation(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const { allocationId } = req.params;
    const { amount, reason } = req.body || {};
    const updated = await allocationService.refundAllocation(allocationId, {
      amount, reason, actor: req.user,
    });
    return ok(res, { allocation: updated }, 'Refund recorded');
  } catch (err) { return next(err); }
}

module.exports = { getSellerAllocations };
/**
 * Admin: list all allocations with filters and pagination.
 * Filters: sellerId, orderId, orderGroupId, status, from, to, search.
 */
async function getAdminAllocations(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const filter = {};
    if (req.query.sellerId) filter.sellerId = req.query.sellerId;
    if (req.query.orderId) filter.orderId = req.query.orderId;
    if (req.query.orderGroupId) filter.orderGroupId = req.query.orderGroupId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) filter.$or = [{ orderId: req.query.search }, { sellerId: req.query.search }];
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const SellerAllocationRepository = require('../repositories/sellerAllocation.repository');
    const [rows, count] = await Promise.all([
      SellerAllocationRepository.findAll(filter, { skip, limit, sort: { createdAt: -1 } }),
      SellerAllocationRepository.count(filter),
    ]);
    return ok(res, { allocations: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) });
  } catch (err) { return next(err); }
}

/**
 * Admin: allocation breakdown for one buyer order (order id or order group id).
 */
async function getAdminOrderAllocations(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const allocations = await allocationService.getOrderAllocations(req.params.orderId);
    return ok(res, { orderId: req.params.orderId, allocations, total: allocations.length });
  } catch (err) { return next(err); }
}

/**
 * Admin: record a settlement (payout) for one allocation. Audited.
 */
async function settleAllocation(req, res, next) {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: admin only', errors: [] });
    }
    const { allocationId } = req.params;
    const { amount, reference, provider, reason } = req.body || {};
    const result = await allocationService.settleAllocation(allocationId, {
      amount, reference, provider,
      initiatedBy: req.user.id, initiatedByRole: req.user.role, reason,
      actor: req.user,
    });
    return ok(res, result, 'Settlement recorded');
  } catch (err) { return next(err); }
}

module.exports = {
  getSellerAllocations,
  getAdminAllocations,
  getAdminOrderAllocations,
  settleAllocation,
  refundAllocation,
};

