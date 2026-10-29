// Catalog Products Controller — handles buyer catalog browsing & search, plus seller product lifecycle, inventory, and visibility.
'use strict';

const productService = require('../services/products.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { sanitizeImageReference } = require('../../../shared/utils/imageRefs');
const { isAdmin } = require('../../../shared/utils/roles');

/**
 * Split a raw `imageUrls` body field into individual references.
 *
 * A comma-separated string is the seller-typed form ("url1, url2"), but an
 * inline `data:image/…` payload CONTAINS commas (base64) — splitting it
 * truncates the image. A string that is itself a data payload is therefore
 * kept whole. Repeated multipart fields arrive as an array and are never
 * split.
 * 
 * @param {string|string[]} raw - Raw image URL or array from request body
 * @returns {string[]} Sanitized array of individual image strings
 */
function parseImageUrls(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((u) => String(u).trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const value = raw.trim();
  if (!value) return [];
  if (/^data:image\//i.test(value)) return [value];
  return value.split(',').map((u) => u.trim()).filter(Boolean);
}

/**
 * Validate an image reference from the request body. Accepts external
 * http(s) URLs, data:image URIs, and real storage keys / /uploads paths
 * (audit: raw imageUrls was an XSS / javascript:-URI vector).
 * Returns null when the value is not an acceptable image reference.
 * 
 * @param {string} raw - Image string candidate
 * @returns {string|null} Safe image reference or null
 */
function sanitizeImageUrl(raw) {
  return sanitizeImageReference(raw);
}

/**
 * Create a new product under the seller's shop.
 * 
 * @param {import('express').Request} req - Express request with multipart files or body imageUrls
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function createProduct(req, res, next) {
  try {
    const files = req.files || [];
    const uploadedImages = files.map((file) => file.path);

    let urlImages = [];
    if (req.body.imageUrls) {
      urlImages = parseImageUrls(req.body.imageUrls).map(sanitizeImageUrl).filter(Boolean);
    }

    const images = [...uploadedImages, ...urlImages];
    const sellerId = req.user ? req.user.id : (req.body.sellerId || null);
    const product = await productService.createProduct({ ...req.body, images, sellerId }, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_CREATED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: product.id || product._id,
      ipAddress,
    });
    return created(res, { product });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve all products belonging to a specific shop.
 * 
 * @param {import('express').Request} req - Express request with params { id: shopId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve details of a single product by ID.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Update an existing product's metadata, images, and pricing.
 * 
 * @param {import('express').Request} req - Express request with params { id } and update fields
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
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
      urlRefs = parseImageUrls(req.body.imageUrls);
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
    sendAudit({
      action: 'PRODUCT_UPDATED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      newValue: req.body,
      ipAddress,
    });
    return ok(res, { product });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve a paginated list of catalog products.
 * Supports operator filters for administration and buyer filtering.
 * 
 * @param {import('express').Request} req - Express request with query parameters
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getAllProducts(req, res, next) {
  try {
    // Buyer-facing by default; the admin console passes includeInactive=true so a
    // deactivated product stays visible (and re-activatable) there.
    //
    // Both operator-only behaviours are gated on the gateway-injected role, not
    // on the query string: any signed-in buyer can send `?includeInactive=true`,
    // and reviews are moderated, so neither may be self-granted.
    const isOperator = req.user && isAdmin(req.user);

    const parsedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

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
        page: parsedPage,
        limit: parsedLimit,
      } : null,
      // Explicit pagination is honoured for EVERY caller (buyer, seller, admin).
      // Without it a non-admin list materialised the entire catalogue.
      pagination: { page: parsedPage, limit: parsedLimit },
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Bulk visibility action for the admin console / seller dashboard: POST /product/bulk
 * body: { productIds: string[], action: 'activate' | 'deactivate' }
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function bulkProductAction(req, res, next) {
  try {
    const { productIds, action } = req.body || {};
    
    // FIX #6: For sellers, verify they own all products being updated
    if (req.user && req.user.role === 'SELLER') {
      const result = await productService.bulkSetProductVisibility(productIds, action, req.user);
      return ok(res, result, `${result.updated} product(s) updated`);
    } else {
      // Admin can bulk update any products
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
    }
  } catch (err) {
    return next(err);
  }
}

/**
 * Delete a product by ID.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function deleteProduct(req, res, next) {
  try {
    const result = await productService.deleteProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_DELETED',
      level: 'WARNING',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      ipAddress,
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Seller (or admin) publishes their draft product.
 * Route admits SELLER + ADMIN; the service re-checks ownership.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function publishProduct(req, res, next) {
  try {
    const product = await productService.publishProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_PUBLISHED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      ipAddress,
    });
    return ok(res, { product }, 'Product published');
  } catch (err) {
    return next(err);
  }
}

/**
 * Seller moves their product back to draft (unpublishes it).
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function draftProduct(req, res, next) {
  try {
    const product = await productService.draftProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_DRAFTED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      ipAddress,
    });
    return ok(res, { product }, 'Product moved to draft');
  } catch (err) {
    return next(err);
  }
}

/**
 * Submit a customer review for a product.
 * 
 * @param {import('express').Request} req - Express request with authenticated buyer
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Full-text and geographic search across catalog products.
 * 
 * @param {import('express').Request} req - Express request with query params { q, page, limit, zoneId, cityId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function searchProducts(req, res, next) {
  try {
    const query = (req.query.q || '').trim();
    // FIX #7: Add zone and city filtering
    const { zoneId, cityId } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const result = await productService.searchProducts(query, {
      requester: req.user || null,
      page,
      limit,
      zoneId,
      cityId,
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Add stock quantity to a product inventory.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { quantity, note }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function restockProduct(req, res, next) {
  try {
    const product = await productService.restockProduct(req.params.id, req.body.quantity, req.body.note, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_RESTOCKED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      details: { operation: 'restock', quantity: req.body.quantity },
      ipAddress,
    });
    return ok(res, { product });
  } catch (err) {
    return next(err);
  }
}

/**
 * Adjust stock count upwards or downwards with audit trail.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { quantity, note }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function adjustStock(req, res, next) {
  try {
    const product = await productService.adjustStock(req.params.id, req.body.quantity, req.body.note, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_STOCK_ADJUSTED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      details: { operation: 'adjust_stock', quantity: req.body.quantity },
      ipAddress,
    });
    return ok(res, { product });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve stock ledger movement history for a product.
 * 
 * @param {import('express').Request} req - Express request with params { id } and query { limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getStockHistory(req, res, next) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const movements = await productService.getStockHistory(req.params.id, limit, req.user);
    return ok(res, { movements });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /product/archive/:id — reversible retirement. The row, its stock ledger
 * and its reviews survive; only the storefront listing disappears.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function archiveProduct(req, res, next) {
  try {
    const product = await productService.archiveProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_ARCHIVED',
      level: 'WARNING',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      details: { operation: 'archive' },
      ipAddress,
    });
    return ok(res, { product }, 'Product archived');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /product/unarchive/:id — restore to DRAFT. Going live again stays a
 * deliberate separate publish action.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function unarchiveProduct(req, res, next) {
  try {
    const product = await productService.unarchiveProduct(req.params.id, req.user);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PRODUCT_UNARCHIVED',
      level: 'INFO',
      adminId,
      adminName,
      module: 'commerce',
      targetEntity: 'product',
      targetId: req.params.id,
      details: { operation: 'unarchive' },
      ipAddress,
    });
    return ok(res, { product }, 'Product restored as draft');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createProduct,
  getShopProducts,
  getAllProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  publishProduct,
  draftProduct,
  archiveProduct,
  unarchiveProduct,
  createReview,
  searchProducts,
  restockProduct,
  adjustStock,
  getStockHistory,
  bulkProductAction,
};

