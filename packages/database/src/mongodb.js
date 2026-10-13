/**
 * MongoDB connection and configuration
 */

const mongoose = require('mongoose');
const ConnectionPool = require('./pool');

class MongoDBConfig {
  constructor(uri, options = {}) {
    this.uri = uri;
    this.options = {
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 45000,
      ...options
    };
    this.pool = null;
    this.connection = null;
  }

  /**
   * Connect to MongoDB
   */
  async connect() {
    try {
      this.connection = await mongoose.connect(this.uri, this.options);
      console.log('✅ MongoDB connected');
      return this.connection;
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect() {
    if (this.connection) {
      await mongoose.disconnect();
      console.log('✅ MongoDB disconnected');
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: mongoose.connection.readyState === 1,
      state: mongoose.connection.readyState,
      host: mongoose.connection.host,
      database: mongoose.connection.name
    };
  }

  /**
   * Run database migrations
   */
  async runMigrations(migrationsDir) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const files = await fs.readdir(migrationsDir);
      const sortedFiles = files.sort();

      for (const file of sortedFiles) {
        if (file.endsWith('.js')) {
          const migration = require(path.join(migrationsDir, file));
          if (migration.up) {
            console.log(`Running migration: ${file}`);
            await migration.up();
          }
        }
      }
      console.log('✅ Migrations completed');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  }

  /**
   * Create indexes
   */
  async createIndexes(schemas = {}) {
    for (const [name, schema] of Object.entries(schemas)) {
      try {
        await schema.collection.createIndexes();
        console.log(`✅ Indexes created for ${name}`);
      } catch (error) {
        console.warn(`⚠️ Index creation for ${name}: ${error.message}`);
      }
    }
  }
}

module.exports = MongoDBConfig;
