/**
 * Mobile offline storage manager
 * Handles local caching for offline-first mobile app
 */

class MobileOfflineService {
  /**
   * Get cacheable data for offline use
   */
  static getCacheableDataStrategy() {
    return [
      {
        key: 'products_home',
        endpoint: '/api/products/featured',
        ttl: 24 * 60 * 60, // 24 hours
        priority: 'high'
      },
      {
        key: 'categories',
        endpoint: '/api/categories',
        ttl: 7 * 24 * 60 * 60, // 7 days
        priority: 'high'
      },
      {
        key: 'user_profile',
        endpoint: '/api/user/profile',
        ttl: 60 * 60, // 1 hour
        priority: 'high'
      },
      {
        key: 'user_wishlist',
        endpoint: '/api/wishlist',
        ttl: 24 * 60 * 60,
        priority: 'medium'
      },
      {
        key: 'user_cart',
        endpoint: '/api/cart',
        ttl: 60 * 60,
        priority: 'high'
      },
      {
        key: 'orders_recent',
        endpoint: '/api/orders?limit=10',
        ttl: 60 * 60,
        priority: 'medium'
      }
    ];
  }

  /**
   * Detect offline state
   */
  static isOffline() {
    // Works in browser: navigator.onLine
    // For backend, check connectivity
    return false;
  }

  /**
   * Sync pending operations
   */
  static async syncPendingOperations(pendingOps) {
    const results = [];

    for (const op of pendingOps) {
      try {
        const response = await fetch(op.endpoint, {
          method: op.method,
          body: JSON.stringify(op.payload),
          headers: { 'Content-Type': 'application/json' }
        });

        results.push({
          id: op.id,
          success: response.ok,
          response: await response.json()
        });
      } catch (error) {
        results.push({
          id: op.id,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Get data for offline mode
   */
  static async getOfflineBundle(userId) {
    return {
      timestamp: new Date(),
      data: {
        products: await this._getOfflineProducts(),
        categories: await this._getOfflineCategories(),
        userProfile: await this._getUserProfile(userId),
        wishlist: await this._getUserWishlist(userId),
        cart: await this._getUserCart(userId),
        orders: await this._getUserOrders(userId)
      }
    };
  }

  // Stubs for implementation
  static async _getOfflineProducts() { return []; }
  static async _getOfflineCategories() { return []; }
  static async _getUserProfile(userId) { return {}; }
  static async _getUserWishlist(userId) { return []; }
  static async _getUserCart(userId) { return []; }
  static async _getUserOrders(userId) { return []; }
}

module.exports = MobileOfflineService;
