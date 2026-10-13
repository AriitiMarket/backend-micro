/**
 * Product filter builder
 * Constructs MongoDB filters from user-selected criteria
 */

class ProductFilterBuilder {
  /**
   * Build filter query from filter criteria
   */
  static buildQuery(filters = {}) {
    const query = { active: true }; // Base filter

    // Price range
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      query.price = {};
      if (filters.minPrice !== undefined) {
        query.price.$gte = parseFloat(filters.minPrice);
      }
      if (filters.maxPrice !== undefined) {
        query.price.$lte = parseFloat(filters.maxPrice);
      }
    }

    // Rating
    if (filters.minRating !== undefined) {
      query.rating = { $gte: parseFloat(filters.minRating) };
    }

    // Seller
    if (filters.sellerId) {
      query.sellerId = filters.sellerId;
    }

    // Shop
    if (filters.shopId) {
      query.shopId = filters.shopId;
    }

    // Stock availability
    if (filters.inStock === true) {
      query.stock = { $gt: 0 };
    } else if (filters.inStock === false) {
      query.stock = { $eq: 0 };
    }

    // Category
    if (filters.category) {
      query.category = filters.category;
    }

    // Subcategory
    if (filters.subcategory) {
      query.subcategory = filters.subcategory;
    }

    // Multiple categories (OR)
    if (filters.categories && Array.isArray(filters.categories)) {
      query.category = { $in: filters.categories };
    }

    // Brand
    if (filters.brand) {
      query.brand = filters.brand;
    }

    // Multiple brands (OR)
    if (filters.brands && Array.isArray(filters.brands)) {
      query.brand = { $in: filters.brands };
    }

    // Condition (new, used, refurbished)
    if (filters.condition) {
      query.condition = filters.condition;
    }

    // Discount availability
    if (filters.hasDiscount === true) {
      query.discount = { $gt: 0 };
    }

    // Search term (text search)
    if (filters.search) {
      query.$text = { $search: filters.search };
    }

    return query;
  }

  /**
   * Build sort options
   */
  static buildSort(sortBy = 'relevance', filters = {}) {
    const sorts = {
      'relevance': filters.search ? { score: { $meta: 'textScore' } } : { createdAt: -1 },
      'newest': { createdAt: -1 },
      'price_low': { price: 1 },
      'price_high': { price: -1 },
      'rating_high': { rating: -1 },
      'popular': { totalSales: -1 },
      'discount': { discount: -1 }
    };

    return sorts[sortBy] || sorts['relevance'];
  }

  /**
   * Get available filter options (for UI)
   */
  static async getFilterOptions(productRepository) {
    const [categories, brands, priceRange, ratings] = await Promise.all([
      productRepository.distinct('category'),
      productRepository.distinct('brand'),
      productRepository.aggregate([
        {
          $group: {
            _id: null,
            minPrice: { $min: '$price' },
            maxPrice: { $max: '$price' }
          }
        }
      ]),
      productRepository.aggregate([
        {
          $group: {
            _id: '$rating',
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: -1 } }
      ])
    ]);

    return {
      categories: categories.filter(c => c),
      brands: brands.filter(b => b),
      priceRange: priceRange[0] || { minPrice: 0, maxPrice: 0 },
      ratings: ratings.map(r => ({
        rating: Math.floor(r._id),
        count: r.count
      }))
    };
  }

  /**
   * Get filters with counts
   */
  static async getFiltersWithCounts(productRepository, baseQuery = {}) {
    const categories = await productRepository.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const brands = await productRepository.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$brand', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const ratings = await productRepository.aggregate([
      { $match: baseQuery },
      {
        $bucket: {
          groupBy: '$rating',
          boundaries: [0, 1, 2, 3, 4, 5],
          default: 0,
          output: { count: { $sum: 1 } }
        }
      }
    ]);

    return {
      categories: categories.map(c => ({ name: c._id, count: c.count })),
      brands: brands.map(b => ({ name: b._id, count: b.count })),
      ratings: ratings.map((r, idx) => ({
        rating: idx,
        count: r.count
      }))
    };
  }
}

module.exports = ProductFilterBuilder;
