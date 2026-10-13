/**
 * Connection pooling utilities
 */

class ConnectionPool {
  constructor(maxPoolSize = 10, minPoolSize = 2) {
    this.maxPoolSize = maxPoolSize;
    this.minPoolSize = minPoolSize;
    this.connections = [];
    this.available = [];
    this.waiting = [];
  }

  /**
   * Initialize pool
   */
  async initialize(connectionFactory) {
    for (let i = 0; i < this.minPoolSize; i++) {
      const conn = await connectionFactory();
      this.connections.push(conn);
      this.available.push(conn);
    }
  }

  /**
   * Get connection from pool
   */
  async getConnection(connectionFactory) {
    if (this.available.length > 0) {
      return this.available.pop();
    }

    if (this.connections.length < this.maxPoolSize) {
      const conn = await connectionFactory();
      this.connections.push(conn);
      return conn;
    }

    // Wait for available connection
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /**
   * Release connection back to pool
   */
  releaseConnection(conn) {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      resolve(conn);
    } else {
      this.available.push(conn);
    }
  }

  /**
   * Close all connections
   */
  async closeAll() {
    for (const conn of this.connections) {
      if (conn.close) await conn.close();
    }
    this.connections = [];
    this.available = [];
  }

  /**
   * Get pool stats
   */
  getStats() {
    return {
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.length - this.available.length,
      waiting: this.waiting.length
    };
  }
}

module.exports = ConnectionPool;
