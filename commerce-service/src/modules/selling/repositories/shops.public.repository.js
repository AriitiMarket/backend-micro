const Shop = require('../models/Shops');
const Product = require('../../catalog/models/Products');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { publicVisibilityFilter } = require('../shops.mapper');
const { inactiveProductCategoryTitles, activeFilter } = require('../../catalog/repositories/products.public.repository');

/**
 * Public Shop Repository — read-only, field-limited queries for unauthenticated
 * marketplace browsing. Uses Mongoose .select() allowlists and .lean().
 */

const PUBLIC_LIST_FIELDS = '_id name avatar description address ratings ratingCount productCount category locationSnapshot.cityName locationSnapshot.areaName locationSnapshot.regionName locationSnapshot.sectorName locationSnapshot.fullAddress deliveryCoverage.zoneIds deliveryCoverage.zoneNames deliveryCoverage.status';
const PUBLIC_DETAIL_FIELDS = '_id name avatar description address ratings ratingCount productCount category locationSnapshot.regionName locationSnapshot.areaName locationSnapshot.cityName locationSnapshot.sectorName locationSnapshot.fullAddress locationSnapshot.landmark locationSnapshot.resolvedAt deliveryCoverage.zoneIds deliveryCoverage.zoneNames deliveryCoverage.status';

/**
 * Visibility filter — admin-curated public view: approved/active status AND
 * the admin's `showOnPublic` allow (missing flag counts as allowed so legacy
 * docs are never hidden by its introduction). Shared with the authenticated
 * shop-detail gate so the two can never disagree.
 */
function approvedFilter() {
  return publicVisibilityFilter();
}

/**
 * Compute productCount per shop via aggregation.
 * Only publicly visible products count — same activeFilter() gate as the
 * storefront product listing (isActive, PUBLISHED status, showOnPublic,
 * shop in good standing, active category, stock > reserved).
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
 * Compute ratings and ratingCount per shop from product reviews.
 * Only reviews of publicly visible products count, and only reviews with
 * moderationStatus 'approved' — matching what the storefront renders.
 * Returns a Map<shopId, { ratings, ratingCount }>.
 */
async function computeShopRatings() {
  const inactiveCategories = await inactiveProductCategoryTitles();
  const rows = await Product.aggregate([
    { $match: activeFilter(inactiveCategories) },
    { $unwind: '$reviews' },
    { $match: { 'reviews.moderationStatus': 'approved' } },
    {
      $group: {
        _id: '$shopId',
        sum: { $sum: '$reviews.rating' },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    map.set(String(row._id), {
      ratings: row.count ? row.sum / row.count : 0,
      ratingCount: row.count,
    });
  }
  return map;
}

/**
 * List public shops with allowlisted fields and computed productCount/ratings.
 *
 * Location-aware discovery (Rule C):
 *   * `zoneId`  → only shops whose ACTIVE coverage includes that delivery zone.
 *                 A shop with no configured coverage can never match — it is
 *                 not "serving every zone by default".
 *   * `cityId`  → only shops whose physical location snapshot is in that city.
 * Both are AND-ed with the existing search/category/visibility filters, so the
 * same eligibility rule applies wherever shops are listed.
 */
async function findPublicAll(opts = {}) {
  const { search, category, sort = '-createdAt', page = 1, limit = 20, zoneId, cityId } = opts;
  const filter = approvedFilter();

  if (zoneId) {
    filter['deliveryCoverage.zoneIds'] = String(zoneId);
    filter['deliveryCoverage.status'] = 'ACTIVE';
  }
  if (cityId) {
    filter['locationSnapshot.cityId'] = String(cityId);
  }

  // Shop category browse (type 'business') — exact, case-insensitive match on
  // the title-as-FK, exactly how products.public.repository filters `category`.
  // AND-ed with the search clause below and with the visibility gate.
  if (category) {
    filter.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') };
  }

  if (search) {
    const terms = search.split(/\s+/).filter(Boolean).map(escapeRegex);
    const regexes = terms.map((t) => new RegExp(t, 'i'));
    filter.$or = regexes.map((re) => ({
      $or: [
        { name: { $regex: re } },
        { description: { $regex: re } },
        { category: { $regex: re } },
      ],
    }));
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const sortObj = parseSort(sort);

  const [rawShops, total] = await Promise.all([
    Shop.find(filter).select(PUBLIC_LIST_FIELDS).sort(sortObj).skip(skip).limit(safeLimit).lean(),
    Shop.countDocuments(filter),
  ]);

  // Enrich with productCount and ratings
  const [productCounts, shopRatings] = await Promise.all([
    computeProductCountsByShop(),
    computeShopRatings(),
  ]);

  const shops = rawShops.map((shop) => {
    const sid = String(shop._id);
    return {
      ...shop,
      productCount: productCounts.get(sid) || 0,
      ratings: shopRatings.get(sid)?.ratings || shop.ratings || 0,
      ratingCount: shopRatings.get(sid)?.ratingCount || shop.ratingCount || 0,
    };
  });

  return { shops, count: shops.length, total, page: safePage, limit: safeLimit };
}

/**
 * Get a single public shop by ID with allowlisted fields.
 *
 * A malformed id answers "not found" (null → 404 upstream) instead of a
 * CastError surfacing as 400, and a hidden/inactive shop is indistinguishable
 * from a missing one — same gate as the list.
 */
async function findPublicById(id) {
  if (!isValidObjectId(id)) return null;

  const shop = await Shop.findOne({ _id: id, ...approvedFilter() })
    .select(PUBLIC_DETAIL_FIELDS)
    .lean();
  if (!shop) return null;

  // Enrich with productCount and ratings — only publicly visible products count.
  const inactiveCategories = await inactiveProductCategoryTitles();
  const products = await Product.find({
    shopId: String(shop._id),
    ...activeFilter(inactiveCategories),
  }).lean();
  const reviewRatings = [];
  for (const p of products) {
    for (const r of (p.reviews || [])) {
      if (r && r.rating) reviewRatings.push(r.rating);
    }
  }
  const ratings = reviewRatings.length
    ? reviewRatings.reduce((a, b) => a + b, 0) / reviewRatings.length
    : 0;

  return {
    ...shop,
    productCount: products.length,
    ratings,
    ratingCount: reviewRatings.length,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSort(sort) {
  if (!sort || typeof sort !== 'string') return { createdAt: -1 };
  const field = sort.replace(/^-/, '');
  const dir = sort.startsWith('-') ? -1 : 1;
  const allowed = ['createdAt', 'ratings', 'name'];
  if (!allowed.includes(field)) return { createdAt: -1 };
  return { [field]: dir };
}

module.exports = {
  findPublicAll,
  findPublicById,
  computeProductCountsByShop,
  computeShopRatings,
};
