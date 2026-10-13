/**
 * Search service - unified interface for MongoDB/Elasticsearch
 * Minimal orchestration layer
 */

const SearchQueryBuilder = require('./queryBuilder');
const SearchAnalyticsTracker = require('./analyticsTracker');

class SearchService {
  constructor(searchRepository, esClient = null) {
    this.repository = searchRepository;
    this.esClient = esClient;
  }

  /**
   * Search products with MongoDB or Elasticsearch
   */
  async searchProducts(searchTerm, filters = {}, options = {}) {
    const { limit = 20, skip = 0, sortBy = 'relevance' } = options;

    try {
      let results;

      if (this.esClient) {
        results = await this._searchElasticsearch(searchTerm, filters, options);
      } else {
        results = await this._searchMongoDB(searchTerm, filters, options);
      }

      // Track search
      await SearchAnalyticsTracker.trackSearch(
        searchTerm,
        results.total,
        options.userId
      );

      return {
        results,
        query: searchTerm,
        filters,
        pagination: { skip, limit, total: results.total }
      };
    } catch (error) {
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  /**
   * Autocomplete suggestions
   */
  async getAutocompleteSuggestions(prefix, type = 'product', limit = 10) {
    if (!prefix || prefix.length < 2) return [];

    if (this.esClient) {
      return this._getESAutoComplete(prefix, type, limit);
    } else {
      return this._getMongoAutoComplete(prefix, type, limit);
    }
  }

  /**
   * Get search analytics
   */
  async getSearchAnalytics() {
    return {
      popular: await SearchAnalyticsTracker.getPopularSearches(),
      trending: await SearchAnalyticsTracker.getTrendingSearches(),
      noResults: await SearchAnalyticsTracker.getSearchGaps()
    };
  }

  // Private methods

  async _searchMongoDB(searchTerm, filters, options) {
    const query = SearchQueryBuilder.buildMongoDBQuery(searchTerm, filters);
    const sort = SearchQueryBuilder.buildSortOptions(options.sortBy);

    const [products, total] = await Promise.all([
      this.repository.find(query)
        .sort(sort)
        .skip(options.skip || 0)
        .limit(options.limit || 20),
      this.repository.count(query)
    ]);

    return { data: products, total };
  }

  async _searchElasticsearch(searchTerm, filters, options) {
    const query = SearchQueryBuilder.buildElasticsearchQuery(searchTerm, filters);
    const sort = SearchQueryBuilder.buildSortOptions(options.sortBy);

    const result = await this.esClient.search({
      index: 'products',
      body: {
        query,
        sort: [sort],
        from: options.skip || 0,
        size: options.limit || 20
      }
    });

    return {
      data: result.hits.hits.map(hit => hit._source),
      total: result.hits.total.value
    };
  }

  async _getMongoAutoComplete(prefix, type, limit) {
    const field = type === 'product' ? 'name' : 'shopName';
    return this.repository.find({
      [field]: new RegExp(`^${prefix}`, 'i')
    })
      .select([field])
      .limit(limit)
      .lean();
  }

  async _getESAutoComplete(prefix, type, limit) {
    const field = type === 'product' ? 'name' : 'shopName';
    const result = await this.esClient.search({
      index: type === 'product' ? 'products' : 'shops',
      body: {
        query: {
          match_phrase_prefix: {
            [field]: prefix
          }
        },
        size: limit
      }
    });

    return result.hits.hits.map(hit => ({
      [field]: hit._source[field],
      id: hit._id
    }));
  }
}

module.exports = SearchService;
