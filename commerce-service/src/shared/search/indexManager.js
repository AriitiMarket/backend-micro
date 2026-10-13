/**
 * Full-text search indexing manager
 * Handles Elasticsearch/MongoDB text index setup
 */

class SearchIndexManager {
  constructor(esClient = null) {
    this.esClient = esClient; // Optional Elasticsearch client
  }

  /**
   * Create MongoDB text indexes for products and shops
   */
  async setupMongoDBTextIndexes(db) {
    try {
      // Product search index
      await db.collection('products').createIndex({
        name: 'text',
        description: 'text',
        category: 'text',
        tags: 'text'
      }, {
        weights: { name: 10, description: 5, category: 3, tags: 2 },
        default_language: 'english'
      });

      // Shop search index
      await db.collection('shops').createIndex({
        shopName: 'text',
        description: 'text',
        category: 'text'
      }, {
        weights: { shopName: 10, description: 5, category: 3 }
      });

      console.log('✅ MongoDB text indexes created');
      return { success: true };
    } catch (error) {
      console.error('❌ Index creation failed:', error);
      throw error;
    }
  }

  /**
   * Setup Elasticsearch indexes (if using)
   */
  async setupElasticsearchIndexes() {
    if (!this.esClient) {
      console.warn('⚠️ Elasticsearch not configured');
      return null;
    }

    try {
      // Create product index
      await this.esClient.indices.create({
        index: 'products',
        body: {
          settings: { number_of_shards: 1, number_of_replicas: 1 },
          mappings: {
            properties: {
              id: { type: 'keyword' },
              name: { type: 'text', analyzer: 'standard' },
              description: { type: 'text' },
              category: { type: 'keyword' },
              price: { type: 'float' },
              rating: { type: 'float' },
              sellerId: { type: 'keyword' },
              shopId: { type: 'keyword' },
              inStock: { type: 'boolean' },
              createdAt: { type: 'date' }
            }
          }
        }
      }).catch(err => {
        if (err.meta?.body?.error?.type !== 'resource_already_exists_exception') throw err;
      });

      // Create shops index
      await this.esClient.indices.create({
        index: 'shops',
        body: {
          settings: { number_of_shards: 1 },
          mappings: {
            properties: {
              id: { type: 'keyword' },
              shopName: { type: 'text' },
              description: { type: 'text' },
              rating: { type: 'float' },
              followers: { type: 'integer' },
              createdAt: { type: 'date' }
            }
          }
        }
      }).catch(err => {
        if (err.meta?.body?.error?.type !== 'resource_already_exists_exception') throw err;
      });

      console.log('✅ Elasticsearch indexes created');
      return { success: true };
    } catch (error) {
      console.error('❌ Elasticsearch setup failed:', error);
      throw error;
    }
  }

  /**
   * Index a single product to Elasticsearch
   */
  async indexProduct(product) {
    if (!this.esClient) return null;

    try {
      await this.esClient.index({
        index: 'products',
        id: product._id?.toString(),
        body: {
          id: product._id,
          name: product.name,
          description: product.description,
          category: product.category,
          price: product.price,
          rating: product.rating || 0,
          sellerId: product.sellerId,
          shopId: product.shopId,
          inStock: product.stock > 0,
          createdAt: product.createdAt
        }
      });

      return { success: true };
    } catch (error) {
      console.error('Elasticsearch indexing failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Bulk index products
   */
  async bulkIndexProducts(products) {
    if (!this.esClient) return null;

    const body = products.flatMap(product => [
      { index: { _index: 'products', _id: product._id?.toString() } },
      {
        name: product.name,
        description: product.description,
        category: product.category,
        price: product.price,
        rating: product.rating || 0,
        inStock: product.stock > 0,
        createdAt: product.createdAt
      }
    ]);

    try {
      const result = await this.esClient.bulk({ body });
      return { success: true, indexed: result.items.length };
    } catch (error) {
      console.error('Bulk indexing failed:', error);
      throw error;
    }
  }

  /**
   * Remove product from index
   */
  async removeProductIndex(productId) {
    if (!this.esClient) return null;

    try {
      await this.esClient.delete({
        index: 'products',
        id: productId.toString()
      });
      return { success: true };
    } catch (error) {
      if (error.meta?.statusCode !== 404) throw error;
      return { success: true };
    }
  }
}

module.exports = SearchIndexManager;
