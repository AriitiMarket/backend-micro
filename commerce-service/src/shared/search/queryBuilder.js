/**
 * Full-text search query builder
 * Supports MongoDB text search and Elasticsearch queries
 */

class SearchQueryBuilder {
  /**
   * Build MongoDB text search query
   */
  static buildMongoDBQuery(searchTerm, filters = {}) {
    const query = { $text: { $search: searchTerm } };

    // Apply filters
    if (filters.minPrice || filters.maxPrice) {
      query.price = {};
      if (filters.minPrice) query.price.$gte = filters.minPrice;
      if (filters.maxPrice) query.price.$lte = filters.maxPrice;
    }

    if (filters.minRating) {
      query.rating = { $gte: filters.minRating };
    }

    if (filters.sellerId) {
      query.sellerId = filters.sellerId;
    }

    if (filters.shopId) {
      query.shopId = filters.shopId;
    }

    if (filters.inStock !== undefined) {
      query.stock = filters.inStock ? { $gt: 0 } : { $eq: 0 };
    }

    if (filters.category) {
      query.category = filters.category;
    }

    return query;
  }

  /**
   * Build Elasticsearch query (must_haves)
   */
  static buildElasticsearchQuery(searchTerm, filters = {}) {
    const must = [];
    const should = [];

    // Text search with boosting
    if (searchTerm) {
      must.push({
        multi_match: {
          query: searchTerm,
          fields: ['name^10', 'description^5', 'category^3'],
          fuzziness: 'AUTO'
        }
      });
    }

    // Filters
    if (filters.minPrice || filters.maxPrice) {
      const rangeFilter = {};
      if (filters.minPrice) rangeFilter.gte = filters.minPrice;
      if (filters.maxPrice) rangeFilter.lte = filters.maxPrice;
      must.push({ range: { price: rangeFilter } });
    }

    if (filters.minRating) {
      must.push({ range: { rating: { gte: filters.minRating } } });
    }

    if (filters.sellerId) {
      must.push({ term: { sellerId: filters.sellerId } });
    }

    if (filters.inStock) {
      must.push({ term: { inStock: true } });
    }

    if (filters.category) {
      must.push({ term: { category: filters.category } });
    }

    return {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        should,
        minimum_should_match: 0
      }
    };
  }

  /**
   * Build sort options
   */
  static buildSortOptions(sortBy) {
    const sorts = {
      'relevance': { _score: { order: 'desc' } },
      'price_asc': { price: { order: 'asc' } },
      'price_desc': { price: { order: 'desc' } },
      'rating': { rating: { order: 'desc' } },
      'newest': { createdAt: { order: 'desc' } },
      'popular': { _score: { order: 'desc' } } // Can use views/sales
    };
    return sorts[sortBy] || sorts['relevance'];
  }
}

module.exports = SearchQueryBuilder;
