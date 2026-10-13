/**
 * Mobile-specific data optimization
 * Lightweight responses, image optimization, pagination
 */

class MobileDataOptimizationService {
  /**
   * Get products with mobile optimization
   */
  static async getMobileProducts(filters = {}, options = {}) {
    const { page = 1, limit = 10 } = options;

    const products = await Product.find(filters)
      .select(['name', 'price', 'image', 'rating', 'stock'])
      .limit(limit * page)
      .skip((page - 1) * limit)
      .lean();

    return {
      products: products.map(p => ({
        id: p._id,
        name: p.name,
        price: p.price,
        image: this._optimizeImage(p.image, 'small'),
        rating: p.rating,
        inStock: p.stock > 0
      })),
      pagination: { page, limit, hasMore: products.length === limit }
    };
  }

  /**
   * Get order summary (lightweight)
   */
  static async getMobileOrderSummary(orderId) {
    const order = await Order.findById(orderId)
      .select(['_id', 'status', 'totalPrice', 'estimatedDelivery', 'seller'])
      .lean();

    return {
      id: order._id,
      status: order.status,
      total: order.totalPrice,
      eta: order.estimatedDelivery,
      seller: order.seller
    };
  }

  /**
   * Batch API for mobile (multiple endpoints in one call)
   */
  static async batchRequest(requests) {
    const results = [];

    for (const req of requests) {
      try {
        const result = await this._executeRequest(req);
        results.push({ id: req.id, success: true, data: result });
      } catch (error) {
        results.push({ id: req.id, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Image optimization for mobile
   */
  static _optimizeImage(url, size = 'small') {
    if (!url) return null;

    const sizes = {
      thumbnail: { w: 50, h: 50 },
      small: { w: 200, h: 200 },
      medium: { w: 400, h: 400 }
    };

    const dims = sizes[size] || sizes.small;

    if (url.includes('cloudinary')) {
      return `${url}?w=${dims.w}&h=${dims.h}&c=fill&q=auto:good`;
    }

    return url;
  }

  static async _executeRequest(req) {
    // Execute batched request (stub)
    return {};
  }
}

module.exports = MobileDataOptimizationService;
