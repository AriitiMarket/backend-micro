/**
 * CDN cache management and image optimization
 * Handles cache headers, invalidation, and warming
 */

class CDNCacheManager {
  /**
   * Get cache headers for image responses
   */
  static getCacheHeaders(imageType = 'product') {
    const cacheConfig = {
      product: {
        'Cache-Control': 'public, max-age=2592000, immutable', // 30 days
        'CDN-Cache-Control': 'max-age=2592000'
      },
      profile: {
        'Cache-Control': 'public, max-age=604800, must-revalidate', // 7 days
        'CDN-Cache-Control': 'max-age=604800'
      },
      banner: {
        'Cache-Control': 'public, max-age=86400', // 1 day
        'CDN-Cache-Control': 'max-age=86400'
      }
    };

    return cacheConfig[imageType] || cacheConfig.product;
  }

  /**
   * Invalidate CDN cache for image
   */
  static async invalidateImageCache(imageUrl) {
    // This would integrate with Cloudinary's cache invalidation
    // or your CDN provider's API
    try {
      // Example: Cloudinary invalidation
      if (imageUrl.includes('cloudinary')) {
        const publicId = this._extractPublicId(imageUrl);
        // Call Cloudinary API to invalidate
        return { success: true, invalidated: publicId };
      }

      return { success: true };
    } catch (error) {
      console.error('Cache invalidation failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Warm CDN cache by preloading variants
   */
  static async warmCache(imageUrl, variants = ['small', 'medium', 'large']) {
    // Preload image variants to warm CDN edge locations
    const ImageUploadManager = require('./imageUploadManager');

    const urls = [
      imageUrl,
      ImageUploadManager.getOptimizedUrl(imageUrl, { width: 300, height: 300 }),
      ImageUploadManager.getOptimizedUrl(imageUrl, { width: 600, height: 600 }),
      ImageUploadManager.getOptimizedUrl(imageUrl, { width: 1200, height: 1200 })
    ];

    try {
      // Fetch each variant (this triggers CDN to cache)
      await Promise.all(
        urls.map(url => fetch(url).catch(err => console.warn('Warm failed:', url, err)))
      );
      return { success: true, warmed: urls.length };
    } catch (error) {
      console.error('Cache warming failed:', error);
      return { success: false };
    }
  }

  /**
   * Get image optimization metrics
   */
  static async getOptimizationMetrics(imageUrl) {
    try {
      const response = await fetch(imageUrl, { method: 'HEAD' });
      const headers = {
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        cacheControl: response.headers.get('cache-control'),
        lastModified: response.headers.get('last-modified'),
        eTag: response.headers.get('etag')
      };

      return {
        url: imageUrl,
        status: response.status,
        headers,
        optimized: !!headers.contentType?.includes('webp')
      };
    } catch (error) {
      console.error('Metrics retrieval failed:', error);
      return null;
    }
  }

  /**
   * Schedule cache refresh for images
   */
  static createCacheRefreshSchedule(imageUrls, intervalDays = 7) {
    return {
      urls: imageUrls,
      interval: intervalDays,
      refreshAt: new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000),
      created: new Date()
    };
  }

  static _extractPublicId(url) {
    const match = url.match(/\/(?:upload|w_\d+)\/(.+?)(?:\.|$)/);
    return match ? match[1] : null;
  }
}

module.exports = CDNCacheManager;
