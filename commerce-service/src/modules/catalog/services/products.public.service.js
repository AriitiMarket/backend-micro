const { findPublicAll, findPublicById } = require('../repositories/products.public.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Public ProductService — read-only, field-limited queries for unauthenticated
 * marketplace browsing. No ownership checks, no write operations.
 */
class PublicProductService {
  /**
   * List products with allowlisted fields. Applies the same visibility filter
   * (only active products) as the main service.
   */
  async getAllProducts(opts = {}) {
    return findPublicAll(opts);
  }

  /**
   * Get a single product with allowlisted fields.
   * Returns 404-compatible null for missing/hidden products.
   */
  async getProduct(id) {
    const product = await findPublicById(id);
    if (!product) throw new ApiError('Product not found', 404);
    return product;
  }
}

module.exports = new PublicProductService();
