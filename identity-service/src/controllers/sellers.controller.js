// Seller identity controller — only used internally by Commerce Service.
const sellersService = require('../services/sellers.service');
const auditService = require('../services/audit.service');
const { ok, created } = require('../utils/response');

async function createSeller(req, res, next) {
  try {
    const result = await sellersService.createSeller({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
    });
    return created(res, result, 'Seller created');
  } catch (err) {
    return next(err);
  }
}

async function linkShopId(req, res, next) {
  try {
    const result = await sellersService.linkShopId({ userId: req.body.userId, shopId: req.body.shopId });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function findUserById(req, res, next) {
  try {
    const result = await sellersService.findUserById({ userId: req.params.id });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function grantSellerRole(req, res, next) {
  try {
    const result = await sellersService.grantSellerRole({ userId: req.body.userId });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * PHASE 3: Suspend a seller.
 * Called by Commerce Service when admin suspends a seller.
 */
async function suspendSeller(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const result = await sellersService.suspendSeller({ userId: req.body.userId });
    await auditService.logSellerSuspended(adminId, adminName, req.body.userId, req.body.reason || null, req);
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * PHASE 3: Reactivate a seller.
 * Called by Commerce Service when admin reactivates a seller.
 */
async function reactivateSeller(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const result = await sellersService.reactivateSeller({ userId: req.body.userId });
    await auditService.logSellerReactivated(adminId, adminName, req.body.userId, req);
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * PHASE 3: Get seller status.
 * Called by Commerce Service to check if seller is suspended.
 */
async function getSellerStatus(req, res, next) {
  try {
    const result = await sellersService.getSellerStatus({ userId: req.body.userId });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Set seller status.
 * Called by Commerce Service when approving/rejecting seller applications.
 */
async function setSellerStatus(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const { userId, status } = req.body;
    const result = await sellersService.setSellerStatus({ userId, status });
    if (status === 'suspended') {
      await auditService.logSellerSuspended(adminId, adminName, userId, req.body.reason || null, req);
    } else if (status === 'active' || status === 'approved') {
      await auditService.logSellerReactivated(adminId, adminName, userId, req);
    } else if (status === 'rejected') {
      await auditService.logSellerRejected(adminId, adminName, userId, req.body.reason || null, req);
    }
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { createSeller, linkShopId, findUserById, grantSellerRole, suspendSeller, reactivateSeller, getSellerStatus, setSellerStatus };
