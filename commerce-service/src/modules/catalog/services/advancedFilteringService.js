/**
 * Advanced filtering service
 * Combines filters, search, and sorting
 */

const ProductFilterBuilder = require('./filterBuilder');
const CacheManager = require('../../../shared/cache/cacheManager');
const CacheKeyBuilder = require('../../../shared/cache/cacheKeyBuilder');

class AdvancedFilteringService {
  constructor(productRepository, cacheManager = null) {
    this.repository = productRepository;
    this.cache = cacheManager;
  }

  /**
   * Filter and sort products
   */
  async filterProducts(filters = {}, options = {}) {
    const {
      page = 1,
      limit = 20,
      sortBy = 'relevance',
      includeFilters = false
    } = options;

    const skip = (page - 1) * limit;
    const query = ProductFilterBuilder.buildQuery(filters);
    const sort = ProductFilterBuilder.buildSort(sortBy, filters);

    // Check cache
    if (this.cache) {
      const cacheKey = CacheKeyBuilder.products({ ...filters, sortBy, page });
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }

    // Execute query
    const [products, total] = await Promise.all([
      this.repository.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('sellerId', 'name rating')
        .lean(),
      this.repository.countDocuments(query)
    ]);

    // Get available filters if requested
    let availableFilters = null;
    if (includeFilters) {
      availableFilters = await ProductFilterBuilder.getFiltersWithCounts(
        this.repository,
        query
      );
    }

    const result = {
      products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      filters: availableFilters,
      applied: filters
    };

    // Cache result
    if (this.cache) {
      const cacheKey = CacheKeyBuilder.products({ ...filters, sortBy, page });
      await this.cache.set(cacheKey, result, 300); // 5 minutes
    }

    return result;
  }

  /**
   * Get available filter options
   */
  async getAvailableFilters() {
    if (this.cache) {
      const cacheKey = 'filters:available';
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const filters = await ProductFilterBuilder.getFilterOptions(this.repository);

    if (this.cache) {
      const cacheKey = 'filters:available';
      await this.cache.set(cacheKey, filters, 3600); // 1 hour
    }

    return filters;
  }

  /**
   * Get filter suggestions during search
   */
  async getFilterSuggestions(partialFilters = {}) {
    const query = ProductFilterBuilder.buildQuery(partialFilters);
    return ProductFilterBuilder.getFiltersWithCounts(this.repository, query);
  }

  /**
   * Clear filter cache when products change
   */
  async invalidateFilterCache() {
    if (this.cache) {
      await this.cache.invalidatePattern(CacheKeyBuilder.patternSearch());
    }
  }
}

module.exports = AdvancedFilteringService;
