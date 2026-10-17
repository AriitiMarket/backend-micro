const publicProductService = require('../services/products.public.service');
const { ok } = require('../../../shared/utils/response');

/**
 * Public Product Controller — handles unauthenticated marketplace browsing.
 * Returns only allowlisted fields; no private data is ever sent.
 */

async function getPublicAllProducts(req, res, next) {
  try {
    const result = await publicProductService.getAllProducts({
      search: req.query.search || req.query.q,
      category: req.query.category,
      shopId: req.query.shopId || req.query.shop,
      regionId: req.query.regionId,
      minPrice: req.query.minPrice,
      maxPrice: req.query.maxPrice,
      rating: req.query.rating,
      // Location-aware discovery: the buyer's selected region / city / zone.
      zoneId: req.query.zoneId || undefined,
      cityId: req.query.cityId || undefined,
      sort: req.query.sort || '-createdAt',
      page: req.query.page || 1,
      limit: req.query.limit || 20,
    });
    return ok(res, { products: result.products, count: result.count, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages });
  } catch (err) {
    return next(err);
  }
}

async function getPublicProductById(req, res, next) {
  try {
    const product = await publicProductService.getProduct(req.params.id);
    return ok(res, { product });
  } catch (err) {
    return next(err);
  }
}

async function getBestSellingProducts(req, res, next) {
  try {
    const result = await publicProductService.getBestSelling({
      limit: req.query.limit,
      days: req.query.days,
    });
    return ok(res, {
      products: result.products,
      count: result.count,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err) {
    return next(err);
  }
}

async function getPublicDealsProducts(req, res, next) {
  try {
    const result = await publicProductService.getDeals({
      limit: req.query.limit,
    });
    return ok(res, {
      products: result.products,
      count: result.count,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getPublicAllProducts, getPublicProductById, getBestSellingProducts, getPublicDealsProducts };
