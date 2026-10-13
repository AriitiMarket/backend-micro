/**
 * @aritii/database - Main Entry Point
 */

const MongoDBConfig = require('./mongodb');
const TransactionHelper = require('./transactions');
const ConnectionPool = require('./pool');

module.exports = {
  MongoDBConfig,
  TransactionHelper,
  ConnectionPool,

  // Factory methods
  createMongoConfig: (uri, options) => new MongoDBConfig(uri, options),
  createConnectionPool: (maxSize, minSize) => new ConnectionPool(maxSize, minSize)
};
