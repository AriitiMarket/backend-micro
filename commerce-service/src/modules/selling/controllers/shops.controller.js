// Seller & Shop Management Controller — handles shop creation, seller profiles, public discovery, and administrative curation.
'use strict';

const shopService = require('../services/shops.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { avatarRefFromInput } = require('../../../shared/utils/imageRefs');

/**
 * Resolve avatar reference from either an uploaded file or a body string URL.
 * 
 * @param {import('express').Request} req - Express request
 * @returns {{ public_id?: string, url?: string }|null}
 */
function resolveAvatar(req) {
  if (req.file) {
    return { public_id: req.file.filename, url: req.file.path };
  }
  return avatarRefFromInput(req.body && (req.body.avatarUrl || req.body.avatar));
}

/**
 * Resolve acting administrator ID from request headers or verified token.
 * 
 * @param {import('express').Request} req - Express request
 * @returns {string|null}
 */
function adminId(req) {
  return req.headers['x-user-id'] || (req.user && req.user.id) || null;
}

/**
 * Create a new merchant shop under the verified seller account.
 * 
 * @param {import('express').Request} req - Express request with shop payload and authenticated user
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function createShop(req, res, next) {
  try {
    const avatar = resolveAvatar(req);
    const shop = await shopService.createShop({ ...req.body, avatar }, req.user);
    return created(res, { shop });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve seller profile and all merchant shops owned by the authenticated seller.
 * 
 * @param {import('express').Request} req - Express request with verified user identity
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getSeller(req, res, next) {
  try {
    const ownerId = req.headers['x-user-id'] || (req.user && (req.user.id || req.user.sub)) || null;
    if (!ownerId) {
      return res.status(401).json({ success: false, message: 'Not logged in', errors: [] });
    }
    const email = req.headers['x-user-email'] || (req.user && req.user.email) || null;

    const shops = await shopService.getSellerShops(ownerId, email);

    if (!shops.length) {
      return ok(res, { seller: null, shops: [] }, 'No shop is linked to this account yet');
    }
    return ok(res, { seller: shops[0], shops });
  } catch (err) {
    return next(err);
  }
}

/**
 * Update the avatar image for an owned merchant shop.
 * 
 * @param {import('express').Request} req - Express request with shopId and avatar image
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function updateShopAvatar(req, res, next) {
  try {
    const shop = await shopService.resolveOwnedShop(req.user, req.body.shopId);
    const avatar = resolveAvatar(req);
    if (!avatar) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Please upload an image or provide an image URL / storage key',
        errors: [],
      });
    }
    const updated = await shopService.updateAvatar(shop, avatar);
    return ok(res, { shop: updated });
  } catch (err) {
    return next(err);
  }
}

/**
 * Update descriptive information, name, or metadata for an owned merchant shop.
 * 
 * @param {import('express').Request} req - Express request with shopId and update body
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function updateShopInfo(req, res, next) {
  try {
    const shop = await shopService.resolveOwnedShop(req.user, req.body.shopId);
    const updated = await shopService.updateInfo(shop, req.body);
    return ok(res, { shop: updated });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve public shop profile and catalogue overview for buyers or administrators.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getShopInfo(req, res, next) {
  try {
    const shop = await shopService.getShopInfo(req.params.id, req.user);
    return ok(res, { shop });
  } catch (err) {
    return next(err);
  }
}

/**
 * Public discovery endpoint: list approved shops with search, sorting, and pagination.
 * 
 * @param {import('express').Request} req - Express request with query params { search, sort, page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getAllShops(req, res, next) {
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    const result = await shopService.getAllShops({
      search: req.query.search || req.query.q,
      sort: req.query.sort || '-createdAt',
      page: pageNum,
      limit: limitNum,
    });
    return ok(res, {
      shops: result.shops,
      count: result.count,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: list all shops with status and search filters.
 * 
 * @param {import('express').Request} req - Express request with query params { status, search, page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listShopsAdmin(req, res, next) {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;

    const result = await shopService.listShopsAdmin({ status, search, limit: limitNum, offset });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: list shops pending approval.
 * 
 * @param {import('express').Request} req - Express request with query params { page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listPendingShops(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;

    const result = await shopService.listShopsAdmin({ status: 'PENDING_APPROVAL', limit: limitNum, offset });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: retrieve detailed shop record for review.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getShopAdmin(req, res, next) {
  try {
    const shop = await shopService.getShopDetailForAdmin(req.params.id);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found', errors: [] });
    return ok(res, { shop });
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: approve a merchant shop for trading.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function approveShop(req, res, next) {
  try {
    const shop = await shopService.updateShopStatus(req.params.id, 'APPROVED', adminId(req));
    sendAudit({ action: ACTIONS.SHOP_APPROVED, ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, details: { shopName: shop.name } });
    return ok(res, { shop }, 'Shop approved');
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: reject a merchant shop application with an optional reason.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { reason }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function rejectShop(req, res, next) {
  try {
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    const shop = await shopService.updateShopStatus(req.params.id, 'INACTIVE', adminId(req), { reason });
    sendAudit({ action: ACTIONS.SHOP_REJECTED, level: 'WARNING', ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, reason, details: { shopName: shop.name } });
    return ok(res, { shop }, 'Shop rejected');
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: temporarily suspend an active shop.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { reason }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function suspendShop(req, res, next) {
  try {
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    const shop = await shopService.updateShopStatus(req.params.id, 'SUSPENDED', adminId(req), { reason });
    sendAudit({ action: ACTIONS.SHOP_SUSPENDED, level: 'WARNING', ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, reason, details: { shopName: shop.name, newStatus: 'SUSPENDED' } });
    return ok(res, { shop }, 'Shop suspended');
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: reactivate a suspended or inactive shop.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function activateShop(req, res, next) {
  try {
    const shop = await shopService.updateShopStatus(req.params.id, 'APPROVED', adminId(req));
    sendAudit({ action: ACTIONS.SHOP_APPROVED, ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, details: { shopName: shop.name, via: 'activate' } });
    return ok(res, { shop }, 'Shop activated');
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: toggle public catalogue visibility for a shop.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { showOnPublic }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function setShopShowOnPublic(req, res, next) {
  try {
    if (typeof req.body.showOnPublic !== 'boolean') {
      return res.status(400).json({ success: false, message: 'showOnPublic (boolean) is required', errors: [] });
    }
    const shop = await shopService.setShowOnPublic(req.params.id, req.body.showOnPublic);
    sendAudit({
      action: ACTIONS.SHOP_PUBLIC_UPDATED,
      level: 'INFO',
      ...getAdminFromReq(req),
      targetEntity: 'shop',
      targetId: req.params.id,
      newValue: { showOnPublic: req.body.showOnPublic },
      details: { shopName: shop.name },
    });
    return ok(
      res,
      { shop },
      req.body.showOnPublic ? 'Shop is visible to the public' : 'Shop removed from the public view'
    );
  } catch (err) {
    return next(err);
  }
}

/**
 * Administrative: set delivery coverage and service area zones for a shop.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { zoneIds, status }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function setShopCoverage(req, res, next) {
  try {
    const { zoneIds, status } = req.body || {};
    const admin = {
      id: req.user && (req.user.id || req.user.sub),
      name: req.user && (req.user.name || req.user.email || req.headers['x-user-email']),
    };
    const updated = await shopService.setCoverage(req.params.id, { zoneIds, status }, admin);
    sendAudit({
      action: 'SHOP_COVERAGE_UPDATED',
      ...getAdminFromReq(req),
      targetEntity: 'shop',
      targetId: req.params.id,
      details: { zoneIds, status },
    });
    return ok(res, { shop: updated }, 'Delivery coverage updated');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createShop,
  getSeller,
  updateShopAvatar,
  updateShopInfo,
  getShopInfo,
  getAllShops,
  listShopsAdmin,
  listPendingShops,
  getShopAdmin,
  approveShop,
  rejectShop,
  suspendShop,
  activateShop,
  setShopShowOnPublic,
  setShopCoverage,
};
