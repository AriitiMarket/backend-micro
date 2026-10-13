/**
 * Wishlist recommendations engine
 * AI-based product recommendations for wishlist items
 */

class WishlistRecommendationService {
  /**
   * Get recommendations based on wishlist items
   */
  static async getRecommendations(wishlistId, limit = 5, productRepository) {
    const wishlist = await Wishlist.findById(wishlistId).populate('items.productId');
    if (!wishlist) return [];

    const categories = [...new Set(wishlist.items.map(i => i.productId.category))];
    const priceRange = this._getPriceRange(wishlist.items);

    // Find similar products
    const recommended = await productRepository.find({
      category: { $in: categories },
      price: { $gte: priceRange.min * 0.8, $lte: priceRange.max * 1.2 },
      _id: { $nin: wishlist.items.map(i => i.productId._id) }
    })
      .sort({ rating: -1, totalSales: -1 })
      .limit(limit)
      .lean();

    return recommended.map(p => ({
      ...p,
      recommendationReason: this._getRecommendationReason(p, wishlist)
    }));
  }

  /**
   * Get complementary products
   */
  static async getComplementary(productId, limit = 5, productRepository) {
    const product = await productRepository.findById(productId);
    if (!product) return [];

    // Find products that are typically bought together
    const complementary = await productRepository.find({
      category: product.category,
      subcategory: product.subcategory,
      _id: { $ne: productId },
      price: { $gte: product.price * 0.5, $lte: product.price * 2 }
    })
      .sort({ rating: -1 })
      .limit(limit)
      .lean();

    return complementary;
  }

  /**
   * Get trending items for wishlist
   */
  static async getTrendingItems(limit = 10, productRepository) {
    return productRepository.find({ trending: true })
      .sort({ views: -1, sales: -1 })
      .limit(limit)
      .lean();
  }

  static _getPriceRange(items) {
    const prices = items.map(i => i.productId.price);
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: prices.reduce((a, b) => a + b) / prices.length
    };
  }

  static _getRecommendationReason(product, wishlist) {
    const categories = wishlist.items.map(i => i.productId.category);
    if (categories.includes(product.category)) {
      return `Popular in ${product.category}`;
    }
    return 'Similar to items in your wishlist';
  }
}

module.exports = WishlistRecommendationService;
