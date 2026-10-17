// Shop controller.
//
// Auth model: identity is established exclusively by the API Gateway, which
// verifies the RS256 access token and injects x-user-id / x-user-role. There
// are no cookies, no seller_token session and no locally minted tokens — the
// Identity Service is the only issuer (OAuth 2.1 authorization code + PKCE).
const shopService = require('../services/shops.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { avatarRefFromInput } = require('../../../shared/utils/imageRefs');

/** File upload wins; otherwise accept an external URL or a real storage key. */
function resolveAvatar(req) {
  if (req.file) {
    return { public_id: req.file.filename, url: req.file.path };
  }
  return avatarRefFromInput(req.body && (req.body.avatarUrl || req.body.avatar));
}

async function createShop(req, res, next) {
  try {
    const avatar = resolveAvatar(req);
    // Ownership comes from the verified identity (route: authenticate +
    // authorize('SELLER')). `ownerId` in the body is ignored by the service.
    const shop = await shopService.createShop({ ...req.body, avatar }, req.user);
    return created(res, { shop });
  } catch (err) { return next(err); }
}

async function getSeller(req, res, next) {
  try {
    // Identity comes only from the gateway-injected header (or the
    // authenticate middleware). No cookie fallback exists.
    const ownerId = req.headers['x-user-id'] || (req.user && (req.user.id || req.user.sub)) || null;
    if (!ownerId) {
      return res.status(401).json({ success: false, message: 'Not logged in', errors: [] });
    }
    const email = req.headers['x-user-email'] || (req.user && req.user.email) || null;

    // A business may own SEVERAL shops: `shops` carries all of them (with a
    // real productCount each) and `seller` stays the primary one so existing
    // single-shop clients keep working.
    const shops = await shopService.getSellerShops(ownerId, email);

    if (!shops.length) {
      return ok(res, { seller: null, shops: [] }, 'No shop is linked to this account yet');
    }
    return ok(res, { seller: shops[0], shops });
  } catch (err) { return next(err); }
}

async function updateShopAvatar(req, res, next) {
  try {
    // Target = one of the caller's own shops (`shopId` in the body selects it;
    // required when the business owns more than one).
    const shop = await shopService.resolveOwnedShop(req.user, req.body.shopId);
    const avatar = resolveAvatar(req);
    if (!avatar) {
      return res.status(400).json({
        success: false, code: 'VALIDATION_ERROR',
        message: 'Please upload an image or provide an image URL / storage key',
        errors: [],
      });
    }
    const updated = await shopService.updateAvatar(shop, avatar);
    return ok(res, { shop: updated });
  } catch (err) { return next(err); }
}

async function updateShopInfo(req, res, next) {
  try {
    const shop = await shopService.resolveOwnedShop(req.user, req.body.shopId);
    const updated = await shopService.updateInfo(shop, req.body);
    return ok(res, { shop: updated });
  } catch (err) { return next(err); }
}

async function getShopInfo(req, res, next) {
  try {
    // The service decides what the caller may see: ADMIN/owner → full document,
    // everyone else → public allowlist (or 404 when the shop is not visible).
    const shop = await shopService.getShopInfo(req.params.id, req.user);
    return ok(res, { shop });
  } catch (err) { return next(err); }
}

async function getAllShops(req, res, next) {
  try {
    const result = await shopService.getAllShops({
      search: req.query.search || req.query.q,
      sort: req.query.sort || '-createdAt',
      page: req.query.page || 1,
      limit: req.query.limit || 20,
    });
    return ok(res, {
      shops: result.shops,
      count: result.count,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err) { return next(err); }
}

// Admin shop management.
//
// Role/permission is enforced ONCE per route: the gateway requires
// `shops.view`/`shops.manage` and the router carries `authorize('ADMIN')`. The
// controllers therefore only re-read the acting admin id (for the audit trail)
// — they no longer duplicate a second role check that could drift.
async function listShopsAdmin(req, res, next) {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * (parseInt(limit, 10) || 20);
    const result = await shopService.listShopsAdmin({ status, search, limit: parseInt(limit, 10) || 20, offset });
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function listPendingShops(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * (parseInt(limit, 10) || 20);
    const result = await shopService.listShopsAdmin({ status: 'PENDING_APPROVAL', limit: parseInt(limit, 10) || 20, offset });
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function getShopAdmin(req, res, next) {
  try {
    const shop = await shopService.getShopDetailForAdmin(req.params.id);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found', errors: [] });
    return ok(res, { shop });
  } catch (err) { return next(err); }
}

function adminId(req) {
  return req.headers['x-user-id'] || (req.user && req.user.id) || null;
}

async function approveShop(req, res, next) {
  try {
    const shop = await shopService.updateShopStatus(req.params.id, 'APPROVED', adminId(req));
    sendAudit({ action: ACTIONS.SHOP_APPROVED, ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, details: { shopName: shop.name } });
    return ok(res, { shop }, 'Shop approved');
  } catch (err) { return next(err); }
}

async function rejectShop(req, res, next) {
  try {
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    const shop = await shopService.updateShopStatus(req.params.id, 'INACTIVE', adminId(req), { reason });
    sendAudit({ action: ACTIONS.SHOP_REJECTED, level: 'WARNING', ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, reason, details: { shopName: shop.name } });
    return ok(res, { shop }, 'Shop rejected');
  } catch (err) { return next(err); }
}

/** Temporarily take a shop off the platform (status → SUSPENDED). */
async function suspendShop(req, res, next) {
  try {
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    const shop = await shopService.updateShopStatus(req.params.id, 'SUSPENDED', adminId(req), { reason });
    sendAudit({ action: ACTIONS.SHOP_SUSPENDED, level: 'WARNING', ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, reason, details: { shopName: shop.name, newStatus: 'SUSPENDED' } });
    return ok(res, { shop }, 'Shop suspended');
  } catch (err) { return next(err); }
}

/** Bring a suspended/rejected shop back into operation (status → APPROVED). */
async function activateShop(req, res, next) {
  try {
    const shop = await shopService.updateShopStatus(req.params.id, 'APPROVED', adminId(req));
    sendAudit({ action: ACTIONS.SHOP_APPROVED, ...getAdminFromReq(req), targetEntity: 'shop', targetId: req.params.id, details: { shopName: shop.name, via: 'activate' } });
    return ok(res, { shop }, 'Shop activated');
  } catch (err) { return next(err); }
}

/**
 * Admin "allow in public" toggle for a shop — the in-place switch on the
 * existing Stores table (public views are admin-curated; no separate page).
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
  } catch (err) { return next(err); }
}

/** ADMIN: set a shop's delivery coverage (service areas). */
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
