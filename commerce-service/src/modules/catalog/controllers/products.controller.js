const productService = require('../services/products.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { sanitizeImageReference } = require('../../../shared/utils/imageRefs');
const { isAdmin } = require('../../../shared/utils/roles');

/**
 * Validate an image reference from the request body. Accepts external
 * http(s) URLs, data:image URIs, and real storage keys / /uploads paths
 * (audit: raw imageUrls was an XSS / javascript:-URI vector).
 * Returns null when the value is not an acceptable image reference.
 */
function sanitizeImageUrl(raw) {
  return sanitizeImageReference(raw);
}

async function createProduct(req, res, next) {
  try {
    const files = req.files || [];
    const uploadedImages = files.map((file) => file.path);

    let urlImages = [];
    if (req.body.imageUrls) {
      const raw = req.body.imageUrls;
      let urls = [];
      if (typeof raw === 'string') {
        urls = raw.split(',').map((u) => u.trim()).filter(Boolean);
      } else if (Array.isArray(raw)) {
        urls = raw.filter(Boolean);
      }
      urlImages = urls.map(sanitizeImageUrl).filter(Boolean);
    }

    const images = [...uploadedImages, ...urlImages];
    const sellerId = req.user ? req.user.id : (req.body.sellerId || null);
    const product = await productService.createProduct({ ...req.body, images, sellerId }, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_CREATED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: product.id || product._id, ipAddress });
    return created(res, { product });
  } catch (err) { return next(err); }
}

async function getShopProducts(req, res, next) {
  try {
    // Guard the raw path segment first. A non-ObjectId (e.g. an identity UUID
    // passed by mistake) used to be forwarded to Mongo, producing a 500 where a
    // clear 400 is expected.
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid shop id', errors: [] });
    }

    // Public shop pages call this without a token. Identity (when present) is
    // injected by the gateway as x-user-* headers; the service uses it to decide
    // ownership (full snapshot / inactive) vs anonymous (filtered + sanitized).
    const requester = req.headers['x-user-id']
      ? { id: req.headers['x-user-id'], role: req.headers['x-user-role'] || 'BUYER' }
      : null;
    const canRequestInactive = requester && (requester.role === 'SELLER' || requester.role === 'ADMIN');

    const products = await productService.getShopProducts(req.params.id, {
      includeInactive: canRequestInactive && req.query.includeInactive === 'true',
      requester,
    });
    return ok(res, { products });
  } catch (err) { return next(err); }
}

async function getProduct(req, res, next) {
  try {
    // Only the admin console may see reviews that are still pending/rejected;
    // buyer and seller product pages receive the moderated view.
    const includeUnmoderated = Boolean(req.user && isAdmin(req.user));
    const product = await productService.getProduct(req.params.id, {
      includeUnmoderated,
      requester: req.user || null,
    });
    if (!product) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product not found', errors: [] });
    }
    return ok(res, { product });
  } catch (err) { return next(err); }
}

async function updateProduct(req, res, next) {
  try {
    const files = req.files || [];
    const uploadedImages = files.map((file) => file.path);

    // URL references are passed through RAW here on purpose: the service knows
    // the product and can allow an entry that is already stored (a file this
    // service saved as `/uploads/…`, which the http(s)-only policy would reject
    // and silently drop on a list replacement) while still refusing anything
    // new that fails the policy. Create has no prior list, so it sanitises here.
    let urlRefs = [];
    if (req.body.imageUrls) {
      const raw = req.body.imageUrls;
      if (typeof raw === 'string') {
        urlRefs = raw.split(',').map((u) => u.trim()).filter(Boolean);
      } else if (Array.isArray(raw)) {
        urlRefs = raw.filter(Boolean).map((u) => String(u).trim()).filter(Boolean);
      }
    }

    const newImages = [...uploadedImages, ...urlRefs];
    const keep = String(req.body.keepExistingImages) === 'true';
    // `clearImages=true` is the explicit "empty the gallery" instruction; it can
    // only arrive alone (never alongside a keep).
    const clearImages = String(req.body.clearImages) === 'true' && !keep;

    const payload = { ...req.body };
    delete payload.keepExistingImages;
    delete payload.clearImages;
    const product = await productService.updateProduct(req.params.id, { ...payload, images: newImages, keepExisting: keep, clearImages }, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_UPDATED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, newValue: req.body, ipAddress });
    return ok(res, { product });
  } catch (err) { return next(err); }
}

async function getAllProducts(req, res, next) {
  try {
    // Buyer-facing by default; the admin console passes includeInactive=true so a
    // deactivated product stays visible (and re-activatable) there.
    //
    // Both operator-only behaviours are gated on the gateway-injected role, not
    // on the query string: any signed-in buyer can send `?includeInactive=true`,
    // and reviews are moderated, so neither may be self-granted.
    const isOperator = req.user && isAdmin(req.user);

    const result = await productService.getAllProducts({
      includeInactive: isOperator && req.query.includeInactive === 'true',
      includeUnmoderatedReviews: Boolean(isOperator),
      requester: req.user || null,
      // Console list filters — honoured ONLY for admins.
      filters: isOperator ? {
        search: req.query.search,
        status: req.query.status,
        category: req.query.category,
        shopId: req.query.shopId,
        // Ownership filters: pick a whole seller or a whole business from the
        // console's filter bar instead of pasting an id into the search box.
        ownerId: req.query.ownerId || req.query.sellerId,
        businessId: req.query.businessId,
        priceMin: req.query.priceMin,
        priceMax: req.query.priceMax,
        dateFrom: req.query.dateFrom,
        stockFilter: req.query.stockFilter,
        page: req.query.page,
        limit: req.query.limit,
      } : null,
      // Explicit pagination is honoured for EVERY caller (buyer, seller, admin).
      // Without it a non-admin list materialised the entire catalogue.
      pagination: { page: req.query.page, limit: req.query.limit },
    });
    return ok(res, {
      products: result.products,
      items: result.products,
      count: result.products.length,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err) { return next(err); }
}

/**
 * Bulk visibility action for the admin console: POST /product/bulk
 * body: { productIds: string[], action: 'activate' | 'deactivate' }
 */
async function bulkProductAction(req, res, next) {
  try {
    const { productIds, action } = req.body || {};
    const result = await productService.bulkSetProductVisibility(productIds, action);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_VISIBILITY_CHANGED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: null,
      details: { operation: 'bulk_visibility', action: result.action, updated: result.updated },
      ipAddress,
    });
    return ok(res, result, `${result.updated} product(s) updated`);
  } catch (err) { return next(err); }
}

async function deleteProduct(req, res, next) {
  try {
    const result = await productService.deleteProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_DELETED', level: 'WARNING', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, ipAddress });
    return ok(res, result);
  } catch (err) { return next(err); }
}

/**
 * Seller (or admin) publishes their draft. Route admits SELLER + ADMIN; the
 * service re-checks ownership (admins bypass, sellers must own the shop) and
 * requires an approved shop for non-admin publishers. No approval queue.
 */
async function publishProduct(req, res, next) {
  try {
    const product = await productService.publishProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_PUBLISHED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, ipAddress });
    return ok(res, { product }, 'Product published');
  } catch (err) { return next(err); }
}

/** Seller moves their product back to draft (unpublishes it). */
async function draftProduct(req, res, next) {
  try {
    const product = await productService.draftProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_DRAFTED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, ipAddress });
    return ok(res, { product }, 'Product moved to draft');
  } catch (err) { return next(err); }
}

async function createReview(req, res, next) {
  try {
    // The author is rebuilt from the VERIFIED token claims. `req.body.user` is
    // client-controlled, so letting it name the author would allow a review to
    // be attributed to any user id.
    const user = req.user
      ? { _id: req.user.id, id: req.user.id, email: req.user.email || null }
      : null;
    const result = await productService.createReview({ ...req.body, user });
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function searchProducts(req, res, next) {
  try {
    const query = (req.query.q || '').trim();
    const result = await productService.searchProducts(query, {
      requester: req.user || null,
      page: req.query.page,
      limit: req.query.limit,
    });
    return ok(res, {
      products: result.products,
      items: result.products,
      count: result.products.length,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err) { return next(err); }
}

async function restockProduct(req, res, next) {
  try {
    const product = await productService.restockProduct(req.params.id, req.body.quantity, req.body.note, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_RESTOCKED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, details: { operation: 'restock', quantity: req.body.quantity }, ipAddress });
    return ok(res, { product });
  } catch (err) { return next(err); }
}

async function adjustStock(req, res, next) {
  try {
    const product = await productService.adjustStock(req.params.id, req.body.quantity, req.body.note, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PRODUCT_STOCK_ADJUSTED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'product', targetId: req.params.id, details: { operation: 'adjust_stock', quantity: req.body.quantity }, ipAddress });
    return ok(res, { product });
  } catch (err) { return next(err); }
}

async function getStockHistory(req, res, next) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const movements = await productService.getStockHistory(req.params.id, limit, req.user);
    return ok(res, { movements });
  } catch (err) { return next(err); }
}

/**
 * POST /product/archive/:id — reversible retirement. The row, its stock ledger
 * and its reviews survive; only the storefront listing disappears.
 */
async function archiveProduct(req, res, next) {
  try {
    const product = await productService.archiveProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_ARCHIVED', level: 'WARNING', adminId, adminName,
      module: 'commerce', targetEntity: 'product', targetId: req.params.id,
      details: { operation: 'archive' }, ipAddress,
    });
    return ok(res, { product }, 'Product archived');
  } catch (err) { return next(err); }
}

/**
 * POST /product/unarchive/:id — restore to DRAFT. Going live again stays a
 * deliberate separate publish action.
 */
async function unarchiveProduct(req, res, next) {
  try {
    const product = await productService.unarchiveProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_UNARCHIVED', level: 'INFO', adminId, adminName,
      module: 'commerce', targetEntity: 'product', targetId: req.params.id,
      details: { operation: 'unarchive' }, ipAddress,
    });
    return ok(res, { product }, 'Product restored as draft');
  } catch (err) { return next(err); }
}

module.exports = { createProduct, getShopProducts, getAllProducts, getProduct, updateProduct, deleteProduct, publishProduct, draftProduct, archiveProduct, unarchiveProduct, createReview, searchProducts, restockProduct, adjustStock, getStockHistory, bulkProductAction };
