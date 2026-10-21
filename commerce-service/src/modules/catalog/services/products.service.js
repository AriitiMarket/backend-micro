const productRepository = require('../repositories/products.repository');
const stockMovementRepository = require('../repositories/stockMovements.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const sellerApplicationRepository = require('../../selling/repositories/sellerApplications.repository');
const orderRepository = require('../../fulfillment/repositories/orders.repository');
const identityClient = require('../../../app/clients/identity.client').identityClient;
const settingsService = require('../../platform/services/settings.service');
const { validateCategory } = require('../../../shared/utils/categoryValidator');
const { inactiveProductCategoryTitles } = require('../../../shared/utils/categoryVisibility');
const { sanitizeImageReference } = require('../../../shared/utils/imageRefs');
const { isProductPubliclyVisible } = require('../../../shared/utils/productVisibility');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * Guard: total `stock` may never fall below the units already RESERVED for open
 * orders. Reserved units belong to orders that have not been confirmed yet, so
 * letting stock sink below them would over-sell the product the moment those
 * orders are confirmed. Applied by every path that writes `stock` directly
 * (`update-product`, `adjust-stock`) so the rule cannot be bypassed by picking a
 * different endpoint.
 */
function assertStockNotBelowReserved(nextStock, reserved = 0) {
  const reservedNow = Number(reserved) || 0;
  if (Number(nextStock) < reservedNow) {
    throw new ApiError(
      `Stock cannot be lower than the ${reservedNow} unit(s) currently reserved for open orders`,
      400
    );
  }
}

/**
 * Merge new image references into the existing set without duplicates — a
 * repeat upload of the same URL used to appear twice in the gallery because the
 * arrays were simply concatenated.
 */
function mergeImages(existing = [], incoming = []) {
  const seen = new Set();
  const merged = [];
  for (const url of [...(existing || []), ...(incoming || [])]) {
    const value = typeof url === 'string' ? url : (url && url.url);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

// ── Writable field set ─────────────────────────────────────────────────────
//
// The ONLY fields a seller owns. Everything else on a product document is
// server-owned and must never be copied from a request body:
//   status / publishedAt / archivedAt  — lifecycle (publish, draft, archive)
//   isActive                           — the ADMIN visibility kill-switch
//   reserved / sold_out / ratings      — derived from orders and moderation
//   reviews                            — moderated content (the public payload
//                                        publishes reviews whose
//                                        `moderationStatus` is 'approved', so a
//                                        body-supplied review would bypass
//                                        moderation completely)
//   shop / shopId / sellerId           — ownership and the embedded snapshot
//   categoryId / createdAt             — resolved or assigned by the server
//
// `create` used to spread the raw body (`{ ...payload }`), which let any seller
// inject all of the above.
const WRITABLE_FIELDS = [
  'name', 'description', 'category', 'tags', 'sku',
  'originalPrice', 'discountPrice', 'stock', 'lowStockThreshold',
];
const NUMERIC_WRITABLE_FIELDS = ['originalPrice', 'discountPrice', 'stock', 'lowStockThreshold'];
// Optional text fields a seller may deliberately EMPTY (an empty `name` is not
// a clear, it is invalid — the validator rejects it when it is sent as '').
const CLEARABLE_TEXT_FIELDS = ['tags', 'sku'];

/**
 * Build the writable field set from a client payload.
 *
 * Numeric fields are coerced and range-checked here, so an unchecked value that
 * the request validators do not cover (`lowStockThreshold` on create) can never
 * reach the document. In `partial` (update) mode an omitted field is left
 * untouched while `''` clears the clearable text fields.
 */
function buildWritableFields(payload = {}, { partial = false } = {}) {
  const out = {};
  for (const field of WRITABLE_FIELDS) {
    const raw = payload[field];
    if (raw === undefined || raw === null) continue;

    if (NUMERIC_WRITABLE_FIELDS.includes(field)) {
      if (raw === '') continue; // "not provided"
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ApiError(`${field} must be a number`, 400);
      if (field === 'discountPrice' && value <= 0) throw new ApiError('Price must be greater than 0', 400);
      if (field !== 'discountPrice' && value < 0) throw new ApiError(`${field} cannot be negative`, 400);
      // Stock is always whole units — fractional inventory is meaningless and
      // would desync the integer order reserve/deduct paths.
      if ((field === 'stock' || field === 'lowStockThreshold') && !Number.isInteger(value)) {
        throw new ApiError(`${field} must be a whole number`, 400);
      }
      out[field] = value;
      continue;
    }

    const text = String(raw);
    if (text === '') {
      if (partial && CLEARABLE_TEXT_FIELDS.includes(field)) out[field] = '';
      continue;
    }
    out[field] = text;
  }
  return out;
}

/**
 * Visibility clauses — ONLY publicly allowed content passes, six gates:
 *   1. `isActive !== false` — the admin activate/deactivate kill-switch
 *      (`$ne: false` keeps pre-flag documents visible so adding the field
 *      never hid the existing catalogue).
 *   2. `status` is PUBLISHED (or the field is absent/null — legacy documents
 *      predate the lifecycle and behave as published).
 *   3. the shop's admin `showOnPublic` allow (embedded snapshot, kept in sync
 *      by the admin Stores toggle) — hidden shop ⇒ hidden products.
 *   4. the shop must be in good standing (approved/active, or a legacy
 *      snapshot that never carried a status).
 *   5. the product's category has not been deactivated in the catalog.
 *   6. at least one unit available (`stock − reserved > 0`) — out-of-stock
 *      rows stay on the owner's/admin's management surfaces only.
 * An admin listing opts in with `includeInactive` and sees everything
 * (including empty stock — they manage it from the console).
 *
 * Returned as a list of AND-ed clauses (never one object) so callers that also
 * need a `$or` (text search) cannot clobber a gate by reusing the same key.
 */
async function visibilityClauses({ includeInactive = false } = {}) {
  if (includeInactive) return [];
  const clauses = [
    { isActive: { $ne: false } },
    { $or: [{ status: 'PUBLISHED' }, { status: { $exists: false } }, { status: null }] },
    { 'shop.showOnPublic': { $ne: false } },
    // Gate #5: the shop must be in good standing (approved/active, or a legacy
    // snapshot that never carried a status). Rejected/suspended/pending sellers
    // stop selling the moment the admin changes the status — the change is
    // cascaded into this snapshot by shops.service.syncShopSnapshot.
    {
      $or: [
        { 'shop.status': { $exists: false } },
        { 'shop.status': null },
        { 'shop.status': { $in: ['APPROVED', 'ACTIVE'] } },
      ],
    },
    // Gate #6: storefront / buyer lists only show orderable stock.
    {
      $expr: {
        $gt: [
          { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
          0,
        ],
      },
    },
  ];
  const inactiveCategories = await inactiveProductCategoryTitles();
  if (inactiveCategories.length) {
    clauses.push({ category: { $nin: inactiveCategories } });
  }
  return clauses;
}

/** The clauses as a single Mongo filter document (`{}` when none apply). */
async function visibilityFilter(opts = {}) {
  const clauses = await visibilityClauses(opts);
  return clauses.length ? { $and: clauses } : {};
}

/**
 * Fields stripped from the denormalised `shop` snapshot for anyone who is not
 * the shop owner or an admin. The embedded snapshot historically carried the
 * seller's wallet balance, transactions, email and phone on every product read
 * — including fully anonymous endpoints.
 */
const SENSITIVE_SHOP_FIELDS = ['availableBalance', 'transections', 'transactions', 'email', 'ownerId', 'phoneNumber', 'password'];

function sanitizeProduct(product, { includeSensitive = false } = {}) {
  if (!product) return product;
  const plain = typeof product.toObject === 'function' ? product.toObject() : (Array.isArray(product) ? product : { ...product });
  if (!includeSensitive && plain.shop && typeof plain.shop === 'object') {
    const safeShop = { ...plain.shop };
    for (const field of SENSITIVE_SHOP_FIELDS) delete safeShop[field];
    plain.shop = safeShop;
  }
  return plain;
}

function sanitizeProducts(products, opts = {}) {
  return (products || []).map((p) => sanitizeProduct(p, opts));
}

function isAdminRequester(requester) {
  return Boolean(requester && requester.role === 'ADMIN');
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class ProductService {
  /**
   * Create a product. The caller must own the target shop (admins excepted) —
   * previously any SELLER could attribute a product to any shopId that existed.
   *
   * New products start as DRAFT: the approved seller decides when to publish
   * (no admin approval step). The admin kill-switch starts enabled.
   */
  async createProduct(payload, requester) {
    const { shopId, images, sellerId, category } = payload;
    if (!shopId) throw new ApiError('shopId is required', 400);
    if (!isValidObjectId(shopId)) throw new ApiError('Invalid shop id', 400);
    const shop = await shopRepository.findById(shopId);
    if (!shop) throw new ApiError('Business not found', 404);
    if (!requester || !requester.id) throw new ApiError('Authentication required', 401);
    if (!isAdminRequester(requester) && String(shop.ownerId) !== String(requester.id)) {
      throw new ApiError('Forbidden: you can only create products for your own shop', 403);
    }
    const categoryDoc = await validateCategory(category, 'product');

    // Platform limits (settings are admin-editable; defaults: 8 images, 500
    // products). Previously both were configured but never enforced, so a seller
    // could upload an unbounded gallery / catalogue.
    const settings = await settingsService.getPlatformSettings();
    const normalizedImages = mergeImages([], images || []);
    const maxImages = Number(settings.maxImagesPerProduct);
    if (Number.isFinite(maxImages) && maxImages > 0 && normalizedImages.length > maxImages) {
      throw new ApiError(`A product can have at most ${maxImages} images`, 400);
    }
    const maxProducts = Number(settings.maxProductsPerSeller);
    if (Number.isFinite(maxProducts) && maxProducts > 0) {
      const existing = await productRepository.countByShop(shopId);
      if (existing >= maxProducts) {
        throw new ApiError(`This shop has reached the limit of ${maxProducts} products`, 400);
      }
    }

    // SKUs are unique per shop (partial unique index `uniq_shop_sku`). Checked
    // here so the seller gets a clear 409 instead of a raw duplicate-key error;
    // the index remains the authoritative guard against a concurrent double post.
    const sku = String(payload.sku || '').trim();
    if (sku) {
      const clash = await productRepository.findByShopAndSku(shopId, sku);
      if (clash) {
        throw new ApiError(`SKU "${sku}" is already used by another product in this shop`, 409);
      }
    }

    const data = {
      // Allowlisted: a request body may only supply seller-owned fields (see
      // WRITABLE_FIELDS). Everything else is resolved here or owned by the
      // server — status, isActive (admin kill-switch), reviews/ratings
      // (moderated), sold_out/reserved (order-derived), publishedAt, the
      // embedded shop snapshot and the ownership pointers.
      ...buildWritableFields(payload),
      // `shopId` is NOT writable input: it is the shop we just resolved and
      // checked ownership against, written back verbatim (the schema requires
      // it). It stays off WRITABLE_FIELDS on purpose — otherwise an update
      // could re-home a product into someone else's shop.
      shopId: String(shopId),
      sku,
      images: normalizedImages,
      shop,
      sellerId: isAdminRequester(requester) ? (sellerId || shop.ownerId || null) : requester.id,
      status: 'DRAFT',
      categoryId: categoryDoc ? String(categoryDoc._id) : null,
    };
    return productRepository.create(data);
  }

  /**
   * Seller publishes their own draft (DRAFT → PUBLISHED).
   *
   * There is NO admin approval: an approved seller publishes directly. The one
   * gate is the SHOP's own approval state — a pending/suspended/inactive shop
   * must not put new products in front of buyers. Admins may publish any
   * product (the kill-switch `isActive` remains their separate control).
   */
  async publishProduct(id, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    if (!isAdminRequester(requester)) {
      const shop = await shopRepository.findById(product.shopId);
      if (!shop) throw new ApiError('Business not found', 404);
      if (!['APPROVED', 'ACTIVE'].includes(shop.status)) {
        throw new ApiError('Your shop must be approved by the admin before products can be published', 403);
      }
    }

    const current = product.status || 'PUBLISHED'; // legacy = live
    if (current === 'PUBLISHED') return product; // idempotent

    const updated = await productRepository.publish(id);
    return updated || product; // concurrent publish → treat as success
  }

  /**
   * Seller moves their product back to DRAFT (unpublishes it). Legacy
   * documents without a status are live, so they transition too. Idempotent:
   * drafting an already-draft product is a no-op success.
   */
  async draftProduct(id, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    const updated = await productRepository.draft(id);
    return updated || product;
  }

  /**
   * Archive the product (owner or admin). Archiving is the REVERSIBLE retirement
   * path: the row, its stock ledger and its review history survive, and the
   * product leaves the storefront because ARCHIVED can never satisfy the
   * "PUBLISHED or absent" visibility gate. Idempotent.
   */
  async archiveProduct(id, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    if (product.status === 'ARCHIVED') return product; // idempotent
    const updated = await productRepository.archive(id);
    return updated || product;
  }

  /**
   * Restore an archived product. It always comes back as a DRAFT — going live
   * again stays a deliberate, separate publish action.
   */
  async unarchiveProduct(id, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    if (product.status !== 'ARCHIVED') return product; // nothing to restore
    const updated = await productRepository.unarchive(id);
    return updated || product;
  }

  /**
   * Products for one shop. Visibility/ownership rules:
   *   - anonymous/buyer → active products only, sensitive shop fields stripped
   *   - shop owner / admin → may opt into inactive, sees full snapshot
   */
  async getShopProducts(shopId, { includeInactive = false, requester = null } = {}) {
    const isAdmin = isAdminRequester(requester);
    let isOwner = false;
    if (requester && requester.id) {
      const shop = await shopRepository.findById(shopId);
      isOwner = Boolean(shop && String(shop.ownerId) === String(requester.id));
    }
    const canSeeInactive = isAdmin || isOwner;
    const products = await productRepository.findByShop(
      shopId,
      await visibilityFilter({ includeInactive: includeInactive && canSeeInactive })
    );
    // sanitizeProduct is a no-op when includeSensitive is true.
    return sanitizeProducts(products, { includeSensitive: isAdmin || isOwner });
  }

  /**
   * Product listing.
   *
   * `includeUnmoderatedReviews` is reserved for the admin console: buyer and
   * seller listings carry only APPROVED reviews, so the moderation queue cannot
   * be bypassed by reading the catalog.
   *
   * `filters` are honoured only for operator (admin) requests — they are the
   * console's list filters (search/status/category/price/date/shop + pagination).
   * A buyer/seller request never receives them, so the filter surface cannot be
   * used to probe other tenants' data.
   *
   * Returns `{ products, total, page, limit, totalPages }`.
   */
  async getAllProducts({
    includeInactive = false,
    includeUnmoderatedReviews = false,
    requester = null,
    filters = null,
    pagination = null,
  } = {}) {
    const isAdmin = isAdminRequester(requester) || includeUnmoderatedReviews;

    // Build the query as a list of AND-ed clauses so the search `$or` can never
    // overwrite the visibility gate (and an explicit status filter can replace
    // the default gate — admins must be able to list DRAFT/INACTIVE rows).
    let page = 1;
    let limit = 0;
    const statusFilter = isAdmin && filters ? filters.status : undefined;
    const stockFilter = isAdmin && filters ? filters.stockFilter : undefined;
    // Default buyer gate (incl. stock > 0) is skipped when an admin opts into a
    // listing mode that must see non-public rows: includeInactive, a status
    // filter (DRAFT/ARCHIVED…), or a stock filter (OUT_OF_STOCK would otherwise
    // AND-contradict the default `available > 0` and always return empty).
    const applyDefaultGate = !(includeInactive && isAdmin) && !statusFilter && !stockFilter;

    const clauses = [];
    if (applyDefaultGate) {
      clauses.push(...(await visibilityClauses()));
    }

    // Explicit pagination is honoured for EVERY signed-in caller — the list used
    // to be paginatable only for admins, so a buyer or seller request (and the
    // storefront that drives it) always materialised the entire catalogue.
    // The default stays unpaginated, so callers that never sent `limit` are
    // unaffected.
    if (pagination) {
      const p = parseInt(pagination.page, 10);
      const l = parseInt(pagination.limit, 10);
      if (Number.isFinite(p) && p > 0) page = p;
      if (Number.isFinite(l) && l > 0) limit = Math.min(200, l);
    }

    if (isAdmin && filters) {
      const { search, category, shopId, businessId, ownerId, priceMin, priceMax, dateFrom, page: p, limit: l } = filters;

      if (statusFilter === 'ACTIVE') clauses.push({ isActive: { $ne: false } });
      else if (statusFilter === 'INACTIVE') clauses.push({ isActive: false });
      else if (statusFilter === 'PUBLISHED') {
        clauses.push({ $or: [{ status: 'PUBLISHED' }, { status: { $exists: false } }, { status: null }] });
      } else if (statusFilter === 'DRAFT') clauses.push({ status: 'DRAFT' });
      else if (statusFilter === 'ARCHIVED') clauses.push({ status: 'ARCHIVED' });

      // Stock filters (admin console): available = stock − reserved.
      // out_of_stock / in_stock / low_stock (0 < stock ≤ 5).
      if (stockFilter === 'OUT_OF_STOCK') {
        clauses.push({
          $expr: {
            $lte: [
              { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
              0,
            ],
          },
        });
      } else if (stockFilter === 'IN_STOCK') {
        clauses.push({
          $expr: {
            $gt: [
              { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
              0,
            ],
          },
        });
      } else if (stockFilter === 'LOW_STOCK') {
        clauses.push({
          $expr: {
            $and: [
              {
                $gt: [
                  { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
                  0,
                ],
              },
              { $lte: [{ $ifNull: ['$stock', 0] }, 5] },
            ],
          },
        });
      }

      if (search && String(search).trim()) {
        const term = String(search).trim();
        const terms = term.split(/\s+/).map(escapeRegex);
        const orClauses = terms.flatMap((t) => {
          const re = new RegExp(t, 'i');
          return [
            { name: re },
            { category: re },
            { description: re },
            { tags: re },
            // One search field answers for the catalogue AND its ownership: an
            // admin types a product name, an SKU or a shop name and gets the
            // same list. Nobody searches by a Mongo id.
            { sku: re },
            { 'shop.name': re },
          ];
        });

        // A seller's name / phone / email never appears on a product document
        // (only `sellerId` does), so the term is resolved against Identity and
        // the shop store first and folded in as ids — still ONE Mongo query.
        const rx = new RegExp(escapeRegex(term), 'i');
        const [identityResult, namedShops] = await Promise.all([
          identityClient.searchUsers(term, 50),
          shopRepository
            .findAll({ $or: [{ name: rx }, { email: rx }, { phoneNumber: rx }] }, { limit: 50 })
            .catch(() => []),
        ]);
        const people = identityClient
          .displayUsers(identityResult)
          .map((user) => String(user.id || user._id || ''))
          .filter(Boolean);
        if (people.length) {
          orClauses.push({ sellerId: { $in: people } });
          orClauses.push({ 'shop.ownerId': { $in: people } });
        }
        const namedShopIds = (namedShops || []).map((s) => String(s._id || s.id || '')).filter(Boolean);
        if (namedShopIds.length) orClauses.push({ shopId: { $in: namedShopIds } });

        if (orClauses.length) clauses.push({ $or: orClauses });
      }
      if (category) clauses.push({ category: { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') } });
      if (shopId) clauses.push({ shopId: String(shopId) });
      // Filter a whole seller or a whole business. A product stores no
      // `businessId`, so the business expands to its shops — and a business with
      // no shops is an EMPTY list, never an unfiltered one.
      if (ownerId) {
        const id = String(ownerId);
        clauses.push({ $or: [{ sellerId: id }, { 'shop.ownerId': id }] });
      }
      if (businessId) {
        const businessShops = await shopRepository
          .findAll({ businessId: String(businessId) }, { limit: 500 })
          .catch(() => []);
        const shopIds = (businessShops || []).map((s) => String(s._id || s.id || '')).filter(Boolean);
        clauses.push({ shopId: { $in: shopIds } });
      }
      if (priceMin !== undefined && priceMin !== null && priceMin !== '') {
        clauses.push({ discountPrice: { $gte: Number(priceMin) } });
      }
      if (priceMax !== undefined && priceMax !== null && priceMax !== '') {
        clauses.push({ discountPrice: { $lte: Number(priceMax) } });
      }
      if (dateFrom) {
        const d = new Date(dateFrom);
        if (!Number.isNaN(d.getTime())) clauses.push({ createdAt: { $gte: d } });
      }

      page = Math.max(1, parseInt(p, 10) || 1);
      limit = Math.min(200, Math.max(1, parseInt(l, 10) || 20));
    }

    const filter = clauses.length ? { $and: clauses } : {};
    const hasPagination = limit > 0;
    const skip = hasPagination ? (page - 1) * limit : 0;

    const query = productRepository.findFiltered(filter, { sort: { createdAt: -1 }, skip, limit: hasPagination ? limit : 0 });
    let products;
    let total;
    if (hasPagination) {
      [products, total] = await Promise.all([query, productRepository.count(filter)]);
    } else {
      products = await query;
      total = products.length;
    }

    const shaped = includeUnmoderatedReviews
      ? sanitizeProducts(products, { includeSensitive: isAdmin })
      : sanitizeProducts(products.map(withApprovedReviewsOnly), { includeSensitive: isAdmin });

    return {
      products: isAdmin ? await this.enrichAdminProductRows(shaped) : shaped,
      total,
      page,
      limit: hasPagination ? limit : total,
      totalPages: hasPagination ? Math.ceil(total / limit) : 1,
    };
  }

  /**
   * Give admin product rows the shop, business and seller behind them.
   *
   * The Products console has to show Shop / Business / Seller as NAMES on every
   * row — never a bare `shopId`. The lookups are batched across the page and
   * every miss simply leaves the field blank instead of failing the list. Only
   * the admin listing reaches this path, so the storefront pays nothing for it.
   */
  async enrichAdminProductRows(rows = []) {
    if (!rows.length) return rows;

    const shopIds = [...new Set(rows.map((row) => row && row.shopId).filter(Boolean).map(String))];
    const ownerIds = [...new Set(rows.map((row) => row && row.sellerId).filter(Boolean).map(String))];

    const [shopRows, identityResult] = await Promise.all([
      shopIds.length
        ? shopRepository.findAll({ _id: { $in: shopIds } }, { limit: shopIds.length }).catch(() => [])
        : Promise.resolve([]),
      ownerIds.length ? identityClient.findUsersByIds(ownerIds) : Promise.resolve(null),
    ]);

    const shopsById = new Map();
    for (const shop of shopRows || []) {
      const id = String(shop._id || shop.id || '');
      if (id) shopsById.set(id, shop);
    }
    const ownersById = new Map();
    for (const user of identityClient.displayUsers(identityResult)) {
      const id = String(user.id || user._id || '');
      if (id) ownersById.set(id, user);
    }

    const businessIds = [...new Set(
      (shopRows || []).map((shop) => (shop && shop.businessId) || '').filter(Boolean).map(String)
    )];
    const businessDocs = businessIds.length
      ? await sellerApplicationRepository
          .findAll({ _id: { $in: businessIds } }, { limit: businessIds.length })
          .catch(() => [])
      : [];
    const businessesById = new Map();
    for (const doc of businessDocs || []) {
      const id = String(doc._id || doc.id || '');
      if (id) businessesById.set(id, doc);
    }

    return rows.map((row) => {
      const base = typeof row.toObject === 'function'
        ? row.toObject()
        : (row._doc ? { ...row._doc, ...row } : { ...row });
      delete base.$__;
      delete base.$isNew;
      delete base._doc;

      const shopId = base.shopId || (base.shop && (base.shop._id || base.shop.id)) || null;
      const shop = shopId ? shopsById.get(String(shopId)) || null : null;
      const ownerId = base.sellerId || (base.shop && (base.shop.ownerId || base.shop.userId)) || null;
      const owner = ownerId ? ownersById.get(String(ownerId)) || null : null;
      const businessId = (shop && shop.businessId) || (base.shop && base.shop.businessId) || null;
      const business = businessId ? businessesById.get(String(businessId)) || null : null;
      return {
        ...base,
        id: String(base._id || base.id),
        shopId: shopId || base.shopId || null,
        shopName: base.shopName || (base.shop && base.shop.name) || (shop ? shop.name : null) || null,
        businessId,
        businessName:
          (business && business.businessInformation && business.businessInformation.businessName) ||
          (business ? business.businessName || null : null) ||
          null,
        sellerId: ownerId,
        sellerName: base.sellerName || (owner ? owner.name || null : null) || null,
        sellerEmail: (owner ? owner.email || null : null) || (base.shop && base.shop.email) || null,
      };
    });
  }

  /**
   * A single product.
   *
   * `includeUnmoderated` is reserved for the admin console. Reviews are
   * moderated, so a buyer or seller reading a product must not receive pending
   * or rejected reviews — nor another reviewer's identity.
   *
   * Hidden products (admin-deactivated OR seller-drafted) are invisible to
   * everyone except the owner/admin — the same two gates as the listings.
   */
  async getProduct(id, { includeUnmoderated = false, includeInactive = false, requester = null } = {}) {
    const product = await productRepository.findById(id);
    if (!product) return null;

    const isAdmin = isAdminRequester(requester);
    const isOwner = Boolean(
      requester && requester.id &&
      ((product.sellerId && String(product.sellerId) === String(requester.id)) ||
        (product.shop && String(product.shop.ownerId) === String(requester.id)))
    );

    // Owner and admin always see their own rows. Everyone else must satisfy
    // the SAME gates as the storefront (kill-switch, seller lifecycle, the
    // shop's showOnPublic + operational status, active category). This read
    // used to check only the first two, so a buyer holding a stale id could
    // open a product the storefront had already hidden.
    if (!isAdmin && !isOwner && !includeInactive) {
      if (!(await isProductPubliclyVisible(product))) return null;
    }

    const base = includeUnmoderated ? product : withApprovedReviewsOnly(product);
    return sanitizeProduct(base, { includeSensitive: isAdmin });
  }

  /**
   * Bulk visibility action for the admin console.
   *
   * The console offers "Activate" / "Deactivate" over a selection of products.
   * Both act on the real `isActive` flag that the public listing already filters
   * on, so a deactivated product actually disappears from the storefront instead
   * of the button being decorative.
   */
  async bulkSetProductVisibility(productIds, action, seller = null) {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new ApiError('productIds must be a non-empty array', 400);
    }
    if (productIds.length > 500) {
      throw new ApiError('Too many products: the limit is 500 per action', 400);
    }
    if (!['activate', 'deactivate', 'publish', 'draft', 'archive', 'unarchive'].includes(action)) {
      throw new ApiError('action must be one of: activate, deactivate, publish, draft, archive, unarchive', 400);
    }
    // One malformed id used to CastError the whole batch into a 400 with no
    // per-id detail; reject the bad shapes up front with a clear message.
    const invalid = productIds.filter((id) => !isValidObjectId(id));
    if (invalid.length) {
      throw new ApiError(`productIds contains ${invalid.length} invalid id(s)`, 400);
    }

    // FIX #6: If seller is provided, verify they own all products
    if (seller && seller.role === 'SELLER') {
      const products = await productRepository.find({ _id: { $in: productIds } });
      const unownedIds = products.filter(p => String(p.sellerId) !== String(seller.id)).map(p => p._id);
      
      if (unownedIds.length > 0) {
        throw new ApiError(`You can only bulk update your own products. ${unownedIds.length} product(s) not owned by you.`, 403);
      }
    }

    // Perform the bulk action
    let result;
    switch (action) {
      case 'activate':
      case 'deactivate':
        const isActive = action === 'activate';
        result = await productRepository.setActiveForIds(productIds, isActive);
        break;
        
      case 'publish':
        result = await productRepository.updateMany(
          { _id: { $in: productIds } },
          { status: 'PUBLISHED' }
        );
        break;
        
      case 'draft':
        result = await productRepository.updateMany(
          { _id: { $in: productIds } },
          { status: 'DRAFT' }
        );
        break;
        
      case 'archive':
        result = await productRepository.updateMany(
          { _id: { $in: productIds } },
          { archived: true }
        );
        break;
        
      case 'unarchive':
        result = await productRepository.updateMany(
          { _id: { $in: productIds } },
          { archived: false }
        );
        break;
    }

    return {
      action,
      requested: productIds.length,
      updated: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
    };
  }

  /**
   * Full-text-ish catalogue search.
   *
   * Previously this loaded the ENTIRE visible collection into memory and then
   * filtered it in JavaScript, with no cap and no pagination — an anonymous
   * caller could force a full-collection scan on every request. The matching
   * rule is unchanged (any term, case-insensitive substring across
   * name/description/category/tags), but it is now expressed as a single indexed
   * Mongo query with a bounded page size.
   *
   * FIX #7: Added zone/city filtering to show only products from shops serving that area
   *
   * Returns `{ products, total, page, limit, totalPages }`.
   */
  async searchProducts(query, { requester = null, page = 1, limit = 50, zoneId = null, cityId = null } = {}) {
    // Always visibility-filtered: unauthenticated search used to load the raw
    // collection and leaked deactivated products + unmoderated reviews.
    const isAdmin = isAdminRequester(requester);

    const clauses = [];
    // Gates as AND-ed clauses (never one object) so the search `$or` below
    // cannot clobber them — same class of bug as the public list leak.
    clauses.push(...(await visibilityClauses({ includeInactive: isAdmin })));
    
    // FIX #7: Filter by zone/city if provided
    if (zoneId || cityId) {
      const shopQuery = {};
      if (zoneId) {
        shopQuery['deliveryCoverage.zoneIds'] = zoneId;
      }
      if (cityId) {
        shopQuery['locationSnapshot.cityId'] = cityId;
      }
      
      const shopsInZone = await shopRepository.find(shopQuery).select('_id');
      const shopIds = shopsInZone.map(s => String(s._id));
      
      if (shopIds.length === 0) {
        // No shops serve this zone, return empty results
        return {
          products: [],
          total: 0,
          page: Math.max(1, Number(page)),
          limit: Math.max(1, Math.min(Number(limit) || 50, 200)),
          totalPages: 0
        };
      }
      
      clauses.push({ shopId: { $in: shopIds } });
    }

    const terms = String(query || '').trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    if (terms.length) {
      clauses.push({
        $or: terms.flatMap((t) => {
          const re = new RegExp(t, 'i');
          return [{ name: re }, { description: re }, { category: re }, { tags: re }];
        }),
      });
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const filter = clauses.length ? { $and: clauses } : {};

    const [rows, total] = await Promise.all([
      productRepository.findFiltered(filter, {
        sort: { createdAt: -1 },
        skip: (safePage - 1) * safeLimit,
        limit: safeLimit,
      }),
      productRepository.count(filter),
    ]);

    const shaped = isAdmin ? rows : rows.map(withApprovedReviewsOnly);
    return {
      products: sanitizeProducts(shaped, { includeSensitive: isAdmin }),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  async assertOwnership(product, requester) {
    if (!requester || !requester.id) {
      throw new ApiError('Authentication required', 401);
    }
    if (isAdminRequester(requester)) return;

    // The live Shop is authoritative. The `shop` snapshot embedded on the
    // product is a denormalised copy and can outlive an ownership transfer
    // (`getSellerShop` re-links `ownerId`), so trusting it alone could keep
    // granting a previous owner access. `sellerId` is only a fallback for the
    // one case the live shop cannot answer: the shop document is gone.
    const shop = product.shopId ? await shopRepository.findById(product.shopId) : null;
    if (shop) {
      const isOwner =
        String(shop.ownerId) === String(requester.id) ||
        (requester.shopId && String(shop._id) === String(requester.shopId));
      if (!isOwner) throw new ApiError('Forbidden: you can only manage products from your own business', 403);
      return;
    }

    const snapshotOwner = product.shop && product.shop.ownerId ? String(product.shop.ownerId) : null;
    const isOwner =
      (product.sellerId && String(product.sellerId) === String(requester.id)) ||
      (snapshotOwner === String(requester.id));
    if (!isOwner) throw new ApiError('Forbidden: you can only manage products from your own business', 403);
  }

  async updateProduct(id, payload, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);

    await this.assertOwnership(product, requester);

    // Allowlisted + numerically validated (see buildWritableFields). `partial`
    // keeps update semantics: an omitted field stays untouched, and `''` clears
    // the optional text fields (`sku`, `tags`) — which previously could never be
    // emptied once set, because an empty string was read as "not provided".
    const update = buildWritableFields(payload, { partial: true });

    // SKU: trimmed, and unique within the shop (partial unique index
    // `uniq_shop_sku`). Excluding this product's own id lets a seller re-save a
    // product without colliding with itself.
    let skuChanged = false;
    if (update.sku !== undefined) {
      update.sku = String(update.sku).trim();
      skuChanged = update.sku !== String(product.sku || '');
      if (update.sku && skuChanged) {
        const clash = await productRepository.findByShopAndSku(product.shopId, update.sku, id);
        if (clash) {
          throw new ApiError(`SKU "${update.sku}" is already used by another product in this shop`, 409);
        }
      }
    }

    // Selling price may never exceed the list price (whichever side is being set).
    const effectiveDiscount = update.discountPrice !== undefined ? update.discountPrice : Number(product.discountPrice);
    const effectiveOriginal = update.originalPrice !== undefined ? update.originalPrice : Number(product.originalPrice);
    if (Number.isFinite(effectiveDiscount) && Number.isFinite(effectiveOriginal) && effectiveOriginal > 0 && effectiveDiscount > effectiveOriginal) {
      throw new ApiError('Selling price cannot exceed the original price', 400);
    }

    if (update.category) {
      const categoryDoc = await validateCategory(update.category, 'product');
      // Keep the optional FK in sync with the title (resolved when the
      // Category collection has a match; null otherwise).
      update.categoryId = categoryDoc ? String(categoryDoc._id) : null;
    }

    const incoming = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];
    // Explicit gallery replacement: the caller edited the list client-side and
    // asks for EXACTLY what it now holds — including nothing at all. Without
    // this flag an empty list meant "leave the gallery alone", so a seller could
    // add photos but never remove the last one.
    if (payload.clearImages) {
      update.images = [];
    } else if (incoming.length > 0) {
      // Policy check happens HERE, not in the controller, because only this
      // layer knows the stored gallery: an entry that is already stored (a
      // file saved as `/uploads/…`) survives the policy, while any NEW
      // reference must pass it — external http(s) links, data:image, and real
      // storage keys (`eshop/…`, `folder/key`) are accepted; a `javascript:`
      // URI can never enter.
      const stored = new Set((product.images || []).map((src) => String(src)));
      const accepted = incoming
        .map((ref) => {
          const value = String(ref);
          return stored.has(value) ? value : sanitizeImageReference(value);
        })
        .filter(Boolean);

      // De-duplicated: `keepExistingImages=true` used to concatenate blindly, so
      // re-submitting the same URL produced a duplicate gallery entry.
      const nextImages = payload.keepExisting
        ? mergeImages(product.images || [], accepted)
        : mergeImages([], accepted);

      const settings = await settingsService.getPlatformSettings();
      const maxImages = Number(settings.maxImagesPerProduct);
      if (Number.isFinite(maxImages) && maxImages > 0 && nextImages.length > maxImages) {
        throw new ApiError(`A product can have at most ${maxImages} images`, 400);
      }
      update.images = nextImages;
    }

    // Ledger: a stock change through the generic update path used to bypass
    // the StockMovement history entirely — and could silently set stock below
    // what open orders already hold reserved. Same guard as adjust-stock, so the
    // rule cannot be dodged by choosing the other endpoint.
    const stockChanged = update.stock !== undefined && update.stock !== (product.stock || 0);
    if (stockChanged) {
      assertStockNotBelowReserved(update.stock, product.reserved);
    }

    const updated = await productRepository.updateById(id, update);

    if (stockChanged && updated) {
      const stockBefore = product.stock || 0;
      const stockAfter = updated.stock || 0;
      await stockMovementRepository.create({
        productId: id,
        shopId: product.shopId,
        sellerId: product.sellerId,
        type: 'adjustment',
        quantity: stockAfter - stockBefore,
        stockBefore,
        stockAfter,
        note: 'Stock edited through product update',
      });
    }
    return updated;
  }

  async deleteProduct(id, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    // Never hard-delete a product that orders reference. Order lines store the
    // product id they were priced against, so removing the row breaks the
    // buyer's order history and the seller's sold/revenue figures — and the
    // stock ledger (StockMovements) that explains those figures. Archiving is
    // the reversible alternative: the listing leaves the marketplace, the
    // record stays.
    const orderCount = await orderRepository.countByProduct(id);
    if (orderCount > 0) {
      throw new ApiError(
        `This product appears in ${orderCount} order(s), so it cannot be deleted. Archive it instead — it leaves the marketplace but keeps its history.`,
        409
      );
    }

    await productRepository.deleteById(id);
    // Only reachable for a product with no order history: take its ledger rows
    // with it so no movement references a product that no longer exists.
    await stockMovementRepository.deleteByProduct(id);
    return { message: 'Product deleted successfully' };
  }

  async restockProduct(id, quantity, note, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new ApiError('Quantity must be a positive whole number', 400);

    const stockBefore = product.stock || 0;
    const updated = await productRepository.updateStock(id, qty);

    await stockMovementRepository.create({
      productId: id,
      shopId: product.shopId,
      sellerId: product.sellerId,
      type: 'restock',
      quantity: qty,
      stockBefore,
      stockAfter: updated.stock,
      note: note || `Restocked ${qty} units`,
    });

    return updated;
  }

  async adjustStock(id, newQuantity, note, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    const target = Number(newQuantity);
    if (!Number.isFinite(target) || target < 0 || !Number.isInteger(target)) {
      throw new ApiError('Stock must be a whole number greater than or equal to 0', 400);
    }
    // Same reserved guard as `update-product`: setting the total to a value the
    // open orders already hold would let the product be over-sold on
    // confirmation. This endpoint used to skip the check entirely.
    assertStockNotBelowReserved(target, product.reserved);

    const stockBefore = product.stock || 0;
    const delta = target - stockBefore;
    if (delta === 0) return product;

    const updated = await productRepository.updateStock(id, delta);

    await stockMovementRepository.create({
      productId: id,
      shopId: product.shopId,
      sellerId: product.sellerId,
      type: 'adjustment',
      quantity: delta,
      stockBefore,
      stockAfter: updated.stock,
      note: note || `Adjusted from ${stockBefore} to ${target}`,
    });

    return updated;
  }

  async getStockHistory(id, limit = 50, requester = null) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);
    const movements = await stockMovementRepository.findByProduct(id, limit);
    return movements;
  }

  /**
   * Submit (or update) the caller's review of a product.
   *
   * The author is taken from the AUTHENTICATED identity only. It used to be read
   * from the request body, which let a caller attribute their review to any user
   * id; the controller now passes the trusted claims.
   *
   * One author has at most one review per product, so re-submitting updates the
   * existing review rather than appending a duplicate — and it re-enters
   * moderation, because an edited review must not keep its previous approval.
   */
  async createReview({ productId, orderId, user, rating, comment }) {
    const product = await productRepository.findById(productId);
    if (!product) throw new ApiError('Product not found', 404);

    const reviewerId = resolveReviewerId(user);
    if (!reviewerId) throw new ApiError('Authentication required', 401);
    const ratingValue = Number(rating);
    // Unbounded ratings (0, -3, 999) used to pass Number.isFinite and then
    // poison the approved-only average that the storefront displays.
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      throw new ApiError('Rating must be between 1 and 5', 400);
    }
    if (comment !== undefined && comment !== null && String(comment).length > 2000) {
      throw new ApiError('Review comment must be at most 2000 chars', 400);
    }

    // Verified purchase: only a buyer with a non-cancelled order containing
    // this product may review it — and never the product's own shop owner.
    if (product.shop && product.shop.ownerId && String(product.shop.ownerId) === reviewerId) {
      throw new ApiError('You cannot review your own product', 403);
    }
    const purchased = await orderRepository.existsOwnedOrder(reviewerId, productId);
    if (!purchased) {
      throw new ApiError('Only verified purchasers can review this product', 403);
    }

    // Every new/edited review re-enters moderation: an edited review must not
    // keep its previous approval.
    const review = {
      user,
      rating: ratingValue,
      comment: comment !== undefined && comment !== null ? String(comment) : '',
      productId,
      moderationStatus: 'pending',
      moderatedAt: null,
      moderatedBy: null,
      rejectionReason: null,
    };
    const existing = (product.reviews || []).find(
      (rev) => reviewAuthorId(rev) === reviewerId
    );

    if (existing) {
      existing.rating = review.rating;
      existing.comment = review.comment;
      existing.user = user;
      existing.moderationStatus = 'pending';
      existing.moderatedAt = null;
      existing.moderatedBy = null;
      existing.rejectionReason = null;
    } else {
      product.reviews.push(review);
    }
    product.ratings = averageApprovedRating(product.reviews);
    await product.save({ validateBeforeSave: false });
    if (orderId) {
      // The order must belong to THIS reviewer and contain THIS product —
      // otherwise any buyer could flip `isReviewed` on someone else's cart line.
      const ownsOrder = await orderRepository.ownsOrderContaining(orderId, reviewerId, productId);
      if (ownsOrder) {
        await orderRepository.findByIdAndUpdate(orderId, {
          $set: { 'cart.$[elem].isReviewed': true },
        }, {
          arrayFilters: [{ $or: [{ 'elem._id': productId }, { 'elem.productId': productId }] }],
        });
      }
    }
    return { message: 'Review submitted for moderation' };
  }

  /**
   * Reviews awaiting moderation, newest product first.
   *
   * Reviews are embedded in product documents, so this pages over the REVIEWS
   * (via $unwind) rather than over products — otherwise a single product with 50
   * pending reviews would occupy one "page" row.
   *
   * Legacy reviews created before moderation existed have no `moderationStatus`
   * and are treated as pending, matching the `{field: null}` semantics of an
   * equality query on a missing field.
   */
  async listPendingReviews({ page = 1, limit = 10 } = {}) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const pendingMatch = {
      $or: [
        { 'reviews.moderationStatus': 'pending' },
        { 'reviews.moderationStatus': { $exists: false } },
        { 'reviews.moderationStatus': null },
      ],
    };

    const [result] = await productRepository.aggregate([
      { $unwind: '$reviews' },
      { $match: pendingMatch },
      { $sort: { createdAt: -1, 'reviews._id': 1 } },
      {
        $facet: {
          items: [
            { $skip: (safePage - 1) * safeLimit },
            { $limit: safeLimit },
            {
              $project: {
                _id: 0,
                reviewId: { $toString: '$reviews._id' },
                productId: { $toString: '$_id' },
                productName: '$name',
                rating: '$reviews.rating',
                comment: '$reviews.comment',
                user: '$reviews.user',
                status: { $ifNull: ['$reviews.moderationStatus', 'pending'] },
                createdAt: '$reviews.createdAt',
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const items = (result && result.items) || [];
    const total = (result && result.total && result.total[0] && result.total[0].count) || 0;

    return {
      reviews: items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  /**
   * Approves or rejects one review and recomputes the product's public rating
   * from APPROVED reviews only, so moderation actually controls what is shown.
   */
  async moderateReview(productId, reviewId, options) {
    // Backward compatibility for the existing `/order/admin/reviews/:id/*`
    // endpoint. New `/review/admin/:productId/:reviewId/*` calls are scoped.
    if (options === undefined && reviewId && typeof reviewId === 'object') {
      options = reviewId;
      reviewId = productId;
      productId = undefined;
    }
    const { action, reason, adminId } = options || {};
    if (!['approve', 'reject'].includes(action)) {
      throw new ApiError('action must be "approve" or "reject"', 400);
    }
    if (action === 'reject' && !String(reason || '').trim()) {
      throw new ApiError('A rejection reason is required', 400);
    }

    const product = await productRepository.updateReviewModeration(reviewId, {
      productId,
      status: action === 'approve' ? 'approved' : 'rejected',
      moderatedBy: adminId,
      reason,
    });
    if (!product) throw new ApiError('Review not found', 404);

    product.ratings = averageApprovedRating(product.reviews);
    await product.save({ validateBeforeSave: false });

    const review = product.reviews.id
      ? product.reviews.id(reviewId)
      : (product.reviews || []).find((rev) => String(rev._id) === String(reviewId));

    return {
      review: toReviewDto(product, review),
      ratings: product.ratings,
    };
  }
}

/**
 * Single review DTO shared by the pending list and the moderation responses, so
 * the console cannot receive two different shapes for the same record.
 */
function toReviewDto(product, review) {
  if (!review) return null;
  return {
    reviewId: String(review._id),
    productId: String(product._id),
    productName: product.name || null,
    rating: review.rating,
    comment: review.comment,
    user: review.user || null,
    status: review.moderationStatus || 'pending',
    createdAt: review.createdAt || null,
  };
}

/**
 * Public rating = mean of APPROVED reviews only. Returns 0 when nothing has been
 * approved, so an unmoderated product never advertises a rating.
 */
function averageApprovedRating(reviews = []) {
  const approved = reviews.filter(
    (rev) => rev.moderationStatus === 'approved' && Number.isFinite(Number(rev.rating))
  );
  if (!approved.length) return 0;
  const total = approved.reduce((sum, rev) => sum + Number(rev.rating), 0);
  return total / approved.length;
}

/**
 * The author id of a candidate review.
 *
 * Accepts every shape the id is kept in across the app: `id` (commerce's
 * authenticate() claim), `sub` (the JWT subject) and `_id` (Mongo-ish clients).
 */
function resolveReviewerId(user) {
  if (!user) return null;
  const raw = user.id || user.sub || user._id;
  return raw ? String(raw) : null;
}

/** Same, for an author already stored on an embedded review. */
function reviewAuthorId(review) {
  const user = (review && review.user) || null;
  if (!user) return null;
  const raw = user._id || user.id || user.sub;
  return raw ? String(raw) : null;
}

/**
 * Project a product down to the reviews the public may see, as a plain object.
 *
 * Embedded reviews are a Mongoose DocumentArray, so the array is replaced rather
 * than mutated, and `ratings` is kept equal to the approved-only average (the
 * same rule createReview/moderation apply).
 */
function withApprovedReviewsOnly(product) {
  const plain = typeof product.toObject === 'function' ? product.toObject() : product;
  const approved = (plain.reviews || []).filter(
    (review) => review.moderationStatus === 'approved'
  );
  plain.reviews = approved;
  plain.ratings = averageApprovedRating(approved);
  return plain;
}

module.exports = new ProductService();
