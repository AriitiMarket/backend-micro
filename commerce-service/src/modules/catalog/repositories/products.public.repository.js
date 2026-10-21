const Product = require('../models/Products');
const Order = require('../../fulfillment/models/Orders');
const { ORDER_STATUSES } = require('../../fulfillment/constants/orderStatuses');
const { inactiveProductCategoryTitles } = require('../../../shared/utils/categoryVisibility');

/**
 * Public Product Repository — read-only, field-limited queries for unauthenticated
 * marketplace browsing. Uses Mongoose .select() allowlists (never denylists) and
 * .lean() to avoid hydrating full Mongoose documents.
 */

const PUBLIC_LIST_FIELDS = '_id name description images discountPrice originalPrice category subcategory ratings sold_out stock reserved createdAt shop.name shop.avatar shop._id';
const PUBLIC_DETAIL_FIELDS = '_id name description images discountPrice originalPrice category ratings sold_out stock reserved createdAt reviews.rating reviews.comment reviews.createdAt reviews.moderationStatus shop.name shop.avatar shop._id';

/**
 * Visibility clauses — publicly visible products (all admin-curated gates):
 *   1. `isActive !== false` (admin kill-switch; `$ne: false` keeps pre-flag
 *      documents visible), AND
 *   2. `status` is PUBLISHED or absent (legacy documents predate the lifecycle
 *      and behave as published; an ARCHIVED product can never match), AND
 *   3. the shop's admin `showOnPublic` allow (embedded snapshot), AND
 *   4. the shop itself is in good standing (approved/active), AND
 *   5. the product's category is not one the admin has deactivated, AND
 *   6. at least one unit is available (`stock − reserved > 0`) — finished or
 *      fully-reserved stock belongs on the seller's own dashboard only.
 *
 * Returned as an ARRAY of AND-ed clauses rather than one object: the gates and
 * the text search BOTH need `$or`, and a single object can only hold one `$or`
 * key — assigning the search `$or` used to silently overwrite the status gate
 * and leak unpublished (DRAFT) products into public search results.
 */
function visibilityClauses(inactiveCategoryTitles = []) {
  const clauses = [
    { isActive: { $ne: false } },
    { $or: [{ status: 'PUBLISHED' }, { status: { $exists: false } }, { status: null }] },
    { 'shop.showOnPublic': { $ne: false } },
    // Gate #5: the shop itself must be in good standing. A rejected, suspended
    // or not-yet-approved seller must not keep selling, and the admin's status
    // change cascades into this snapshot (shops.service.syncShopSnapshot).
    // Missing/null keeps legacy documents visible (same `$ne: false` posture
    // as the other gates).
    {
      $or: [
        { 'shop.status': { $exists: false } },
        { 'shop.status': null },
        { 'shop.status': { $in: ['APPROVED', 'ACTIVE'] } },
      ],
    },
    // Gate #6: storefront only lists products a buyer can actually take.
    // $ifNull keeps legacy docs (missing stock/reserved) at 0 → hidden, which
    // matches the schema default of 0 for new rows.
    {
      $expr: {
        $gt: [
          { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
          0,
        ],
      },
    },
  ];
  // Only added when a product category is actually deactivated, so a legacy
  // product whose title matches no Category row is never hidden.
  if (inactiveCategoryTitles.length) {
    clauses.push({ category: { $nin: inactiveCategoryTitles } });
  }
  return clauses;
}

/** The same gates as a single filter document (for `$match`/`find` callers). */
function activeFilter(inactiveCategoryTitles = []) {
  return { $and: visibilityClauses(inactiveCategoryTitles) };
}

/**
 * Compute productCount per shop via aggregation.
 * Returns a Map<shopId, count>.
 */
async function computeProductCountsByShop() {
  const inactiveCategories = await inactiveProductCategoryTitles();
  const counts = await Product.aggregate([
    { $match: activeFilter(inactiveCategories) },
    { $group: { _id: '$shopId', count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const row of counts) {
    map.set(String(row._id), row.count);
  }
  return map;
}

/**
 * List public products with allowlisted fields.
 * Supports: search, category, shopId, zoneId, cityId, sort, page, limit.
 *
 * Location-aware discovery (Rule C):
 *   * `zoneId`  → only products from shops whose ACTIVE delivery coverage
 *                 includes that delivery zone. Shops without configured
 *                 coverage never match — not "serving every zone by default".
 *   * `cityId`  → only products from shops physically located in that city.
 * Both are AND-ed with the existing search/category/visibility filters.
 */
async function findPublicAll(opts = {}) {
  const {
    search,
    category,
    subcategory,
    shopId,
    regionId,
    minPrice,
    maxPrice,
    rating,
    sort = '-createdAt',
    page = 1,
    limit = 20,
    zoneId,
    cityId,
  } = opts;

  // AND-ed clauses: the visibility gates (including the category gate) and the
  // search `$or` coexist here.
  const clauses = visibilityClauses(await inactiveProductCategoryTitles());

  if (category) {
    clauses.push({ category: { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') } });
  }
  if (subcategory) {
    clauses.push({ subcategory: { $regex: new RegExp(`^${escapeRegex(subcategory)}$`, 'i') } });
  }
  if (shopId) {
    clauses.push({ shopId: String(shopId) });
  }
  if (search) {
    const terms = String(search).split(/\s+/).filter(Boolean).map(escapeRegex);
    if (terms.length) {
      clauses.push({
        $or: terms.flatMap((t) => {
          const re = new RegExp(t, 'i');
          return [
            { name: { $regex: re } },
            { category: { $regex: re } },
            { description: { $regex: re } },
          ];
        }),
      });
    }
  }

  // Price range filter on the effective selling price (discountPrice when set,
  // otherwise originalPrice).
  if (minPrice || maxPrice) {
    const priceExpr = { $and: [] };
    if (minPrice) {
      priceExpr.$and.push({
        $gte: [{ $ifNull: ['$discountPrice', '$originalPrice'] }, Number(minPrice)],
      });
    }
    if (maxPrice) {
      priceExpr.$and.push({
        $lte: [{ $ifNull: ['$discountPrice', '$originalPrice'] }, Number(maxPrice)],
      });
    }
    clauses.push({ $expr: priceExpr });
  }

  // Minimum rating filter.
  if (rating) {
    clauses.push({ ratings: { $gte: Number(rating) } });
  }

  // Location-aware filtering: resolve shop IDs that serve the selected
  // region / city / zone, then restrict products to those shops.
  if (regionId || zoneId || cityId) {
    const Shop = require('../../selling/models/Shops');
    const shopFilter = {};
    if (regionId) {
      shopFilter['locationSnapshot.regionId'] = String(regionId);
    }
    if (zoneId) {
      shopFilter['deliveryCoverage.zoneIds'] = String(zoneId);
      shopFilter['deliveryCoverage.status'] = 'ACTIVE';
    }
    if (cityId) {
      shopFilter['locationSnapshot.cityId'] = String(cityId);
    }
    const servingShops = await Shop.find(shopFilter).select('_id').lean();
    const servingShopIds = servingShops.map((s) => String(s._id));
    // A region/city/zone with no serving shops means zero products match —
    // fail-closed rather than showing everything.
    clauses.push({ shopId: { $in: servingShopIds.length ? servingShopIds : ['__none__'] } });
  }

  const filter = { $and: clauses };

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const sortObj = parseSort(sort);

  const [items, total] = await Promise.all([
    Product.find(filter).select(PUBLIC_LIST_FIELDS).sort(sortObj).skip(skip).limit(safeLimit).lean(),
    Product.countDocuments(filter),
  ]);

  return {
    products: items.map(toPublicProduct),
    count: items.length,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}

/**
 * Get a single public product by ID with allowlisted fields.
 *
 * Reviews are moderated (a new review starts as 'pending'), so only APPROVED
 * ones may be published. The moderation flag is selected purely to filter here
 * and is stripped again, which keeps the public payload shape unchanged.
 */
async function findPublicById(id) {
  // Visibility filter applied here: a deactivated product — or one whose
  // category the admin has removed from the public catalog — must 404 on the
  // public detail endpoint, not merely be hidden from lists.
  const product = await Product.findOne({ _id: id, ...activeFilter(await inactiveProductCategoryTitles()) })
    .select(PUBLIC_DETAIL_FIELDS)
    .lean();
  if (!product) return null;

  if (Array.isArray(product.reviews)) {
    product.reviews = product.reviews
      .filter((review) => review.moderationStatus === 'approved')
      .map(({ moderationStatus, ...review }) => review);
  }

  return toPublicProduct(product);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * The public shape of one product read with `.lean()`.
 *
 * `available` is what a buyer can actually order right now — `stock` minus the
 * units already held by open orders' reservations. Publishing only the raw
 * `stock` counter made the buyer's "N in stock" badge overstate availability,
 * so the derived figure is surfaced instead and `reserved` (an internal
 * accounting counter) is never sent.
 */
function toPublicProduct(product) {
  if (!product) return product;
  const stock = Number(product.stock) || 0;
  const reserved = Number(product.reserved) || 0;
  product.available = Math.max(0, stock - reserved);
  delete product.reserved;
  return product;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSort(sort) {
  if (!sort || typeof sort !== 'string') return { createdAt: -1 };
  const field = sort.replace(/^-/, '');
  const dir = sort.startsWith('-') ? -1 : 1;
  const allowed = ['createdAt', 'ratings', 'sold_out', 'discountPrice'];
  if (!allowed.includes(field)) return { createdAt: -1 };
  return { [field]: dir };
}

/**
 * Public product counts per category title — computed with the SAME visibility
 * gates as the storefront list (`activeFilter`), so a category chip can never
 * advertise products a buyer cannot actually see (a draft, a deactivated or
 * archived product, a product of a shop hidden from the public, or a product
 * whose category was itself deactivated).
 *
 * Returns a Map<categoryTitle, count>.
 */
async function countPublicProductsByCategory() {
  const inactiveCategories = await inactiveProductCategoryTitles();
  const rows = await Product.aggregate([
    { $match: activeFilter(inactiveCategories) },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const row of rows) {
    if (row._id) map.set(String(row._id), row.count);
  }
  return map;
}

/**
 * Best-selling products computed from real, qualifying sales.
 *
 * Qualifying sales are orders whose canonical status is one of Confirmed,
 * Shipped, In Transit or Delivered AND whose paymentStatus is CONFIRMED.
 * Cancelled, refunded, unpaid and still-processing orders never count.
 *
 * Units sold are summed from order cart lines over a configurable time
 * window (default 30 days). Only products that pass the same public
 * visibility gate as the storefront list are returned — a product whose
 * shop was later suspended, or that was archived/drafted, is excluded.
 *
 * Returns { products, count, total, page, limit, totalPages } where each
 * product carries an extra `unitsSold` field (units sold in the window).
 */
async function findBestSelling(opts = {}) {
  const { limit = 10, days = 30 } = opts;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 1, 1), 50);
  const safeDays = Math.max(parseInt(days, 10) || 30, 1);
  const startDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const qualifyingStatuses = [
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.SHIPPED,
    ORDER_STATUSES.IN_TRANSIT,
    ORDER_STATUSES.DELIVERED,
  ];

  // Aggregate qualifying order lines by product in the database — no
  // order rows are loaded into application memory.
  // Cart items carry either _id or productId (or both); use whichever is
  // present so best-seller ranking works regardless of how the order was
  // created (checkout vs request-to-order conversion).
  const rows = await Order.aggregate([
    {
      $match: {
        status: { $in: qualifyingStatuses },
        paymentStatus: 'CONFIRMED',
        createdAt: { $gte: startDate },
      },
    },
    { $unwind: '$cart' },
    {
      $group: {
        _id: {
          $cond: {
            if: { $ne: ['$cart._id', null] },
            then: '$cart._id',
            else: '$cart.productId',
          },
        },
        unitsSold: { $sum: { $toInt: '$cart.quantity' } },
      },
    },
    { $sort: { unitsSold: -1, _id: 1 } },
    { $limit: safeLimit },
  ]);

  if (!rows.length) {
    return { products: [], count: 0, total: 0, page: 1, limit: safeLimit, totalPages: 0 };
  }

  const unitsById = new Map(rows.map((row) => [String(row._id), row.unitsSold]));
  const productIds = rows.map((row) => String(row._id));

  // Apply the same public visibility gate as the storefront list so a
  // delisted product can never appear in best-sellers.
  const inactiveCategories = await inactiveProductCategoryTitles();
  const products = await Product.find({
    _id: { $in: productIds },
    ...activeFilter(inactiveCategories),
  })
    .select(PUBLIC_LIST_FIELDS)
    .lean();

  products.sort((a, b) => {
    const ua = unitsById.get(String(a._id)) || 0;
    const ub = unitsById.get(String(b._id)) || 0;
    if (ub !== ua) return ub - ua;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return {
    products: products.map((p) => ({
      ...toPublicProduct(p),
      unitsSold: unitsById.get(String(p._id)) || 0,
    })),
    count: products.length,
    total: products.length,
    page: 1,
    limit: safeLimit,
    totalPages: 1,
  };
}

/**
 * Publicly visible products that are on sale (discountPrice < originalPrice),
 * sorted by discount magnitude (largest savings first), then newest first.
 *
 * Returns { products, count, total, page, limit, totalPages }. Each product
 * carries an extra `discount` field (originalPrice − discountPrice) and
 * `discountPercent` (rounded integer percentage off).
 */
async function findDeals(opts = {}) {
  const { limit = 10 } = opts;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 1, 1), 50);
  const inactiveCategories = await inactiveProductCategoryTitles();

  const products = await Product.find({
    ...activeFilter(inactiveCategories),
    originalPrice: { $exists: true, $gt: 0 },
  })
    .select(PUBLIC_LIST_FIELDS)
    .lean();

  // Filter to discounted products (discountPrice < originalPrice) in JS,
  // since Mongo $expr cross-field comparison isn't available here.
  const withDiscount = products
    .map((p) => {
      const original = Number(p.originalPrice || 0);
      const discounted = Number(p.discountPrice || 0);
      const discount = original - discounted;
      return { ...toPublicProduct(p), discount, discountPercent: Math.round((discount / original) * 100) };
    })
    .filter((p) => p.discount > 0);

  withDiscount.sort((a, b) => {
    if (b.discountPercent !== a.discountPercent) return b.discountPercent - a.discountPercent;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const page = 1;
  const totalPages = 1;
  const total = withDiscount.length;
  const count = Math.min(withDiscount.length, safeLimit);
  const pageProducts = withDiscount.slice(0, safeLimit);

  return {
    products: pageProducts,
    count,
    total,
    page,
    limit: safeLimit,
    totalPages,
  };
}

module.exports = { findPublicAll, findPublicById, computeProductCountsByShop, countPublicProductsByCategory, findBestSelling, findDeals, inactiveProductCategoryTitles, activeFilter };
