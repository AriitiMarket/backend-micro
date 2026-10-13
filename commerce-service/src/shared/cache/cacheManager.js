/**
 * Redis cache manager
 * Central caching layer with TTL and invalidation
 */

class CacheManager {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * Get from cache or execute function
   */
  async getOrSet(key, fetcher, ttl = 3600) {
    try {
      // Try cache first
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }

      // Fetch and cache
      const data = await fetcher();
      await this.redis.setex(key, ttl, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`Cache miss for ${key}:`, error);
      // Fallback to direct fetch if cache fails
      return fetcher();
    }
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttl = 3600) {
    try {
      await this.redis.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Cache set failed for ${key}:`, error);
      return false;
    }
  }

  /**
   * Get value from cache
   */
  async get(key) {
    try {
      const value = await this.redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`Cache get failed for ${key}:`, error);
      return null;
    }
  }

  /**
   * Delete cache keys
   */
  async invalidate(keys) {
    if (!Array.isArray(keys)) keys = [keys];
    try {
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      return true;
    } catch (error) {
      console.error('Invalidation failed:', error);
      return false;
    }
  }

  /**
   * Invalidate by pattern (e.g., product:*)
   */
  async invalidatePattern(pattern) {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      return { invalidated: keys.length };
    } catch (error) {
      console.error('Pattern invalidation failed:', error);
      return { invalidated: 0 };
    }
  }

  /**
   * Warm cache with frequent queries
   */
  async warmCache(warmStrategies) {
    const warmed = [];

    for (const strategy of warmStrategies) {
      try {
        const data = await strategy.fetcher();
        await this.set(strategy.key, data, strategy.ttl || 3600);
        warmed.push(strategy.key);
      } catch (error) {
        console.error(`Warm failed for ${strategy.key}:`, error);
      }
    }

    return { warmed, total: warmStrategies.length };
  }

  /**
   * Get cache stats
   */
  async getStats() {
    try {
      const info = await this.redis.info('memory');
      const dbsize = await this.redis.dbsize();
      
      return {
        keys: dbsize,
        memory: this._parseMemoryInfo(info)
      };
    } catch (error) {
      console.error('Stats retrieval failed:', error);
      return null;
    }
  }

  _parseMemoryInfo(info) {
    const lines = info.split('\r\n');
    const memory = {};
    for (const line of lines) {
      const [key, value] = line.split(':');
      if (key?.startsWith('used_memory')) {
        memory[key] = value;
      }
    }
    return memory;
  }
}

module.exports = CacheManager;
