/**
 * Cache key builder
 * Centralized cache key naming convention
 */

class CacheKeyBuilder {
  /**
   * Product cache keys
   */
  static product(productId, variant = 'full') {
    return `product:${productId}:${variant}`;
  }

  static products(filters = {}) {
    const hash = this._hashObject(filters);
    return `products:list:${hash}`;
  }

  static productsByShop(shopId) {
    return `shop:${shopId}:products`;
  }

  static productsByCategory(category) {
    return `category:${category}:products`;
  }

  /**
   * Shop cache keys
   */
  static shop(shopId) {
    return `shop:${shopId}:full`;
  }

  static shopStats(shopId) {
    return `shop:${shopId}:stats`;
  }

  /**
   * Order cache keys
   */
  static order(orderId) {
    return `order:${orderId}`;
  }

  static userOrders(userId) {
    return `user:${userId}:orders`;
  }

  /**
   * User cache keys
   */
  static user(userId, variant = 'profile') {
    return `user:${userId}:${variant}`;
  }

  static userCart(userId) {
    return `user:${userId}:cart`;
  }

  static userWishlist(userId) {
    return `user:${userId}:wishlist`;
  }

  /**
   * Analytics cache keys
   */
  static analyticsCache(metric, params = {}) {
    const hash = this._hashObject(params);
    return `analytics:${metric}:${hash}`;
  }

  static dashboardMetrics(adminId) {
    return `admin:${adminId}:dashboard`;
  }

  /**
   * Search cache keys
   */
  static searchResults(query, filters = {}) {
    const hash = this._hashObject(filters);
    return `search:${query}:${hash}`;
  }

  static suggestions(prefix, type = 'product') {
    return `suggestions:${type}:${prefix}`;
  }

  /**
   * Invalidation patterns
   */
  static patternProduct(productId) {
    return `product:${productId}:*`;
  }

  static patternShop(shopId) {
    return `shop:${shopId}:*`;
  }

  static patternUser(userId) {
    return `user:${userId}:*`;
  }

  static patternSearch() {
    return 'search:*';
  }

  // Helper
  static _hashObject(obj) {
    const crypto = require('crypto');
    return crypto
      .createHash('md5')
      .update(JSON.stringify(obj))
      .digest('hex')
      .substring(0, 8);
  }
}

module.exports = CacheKeyBuilder;
