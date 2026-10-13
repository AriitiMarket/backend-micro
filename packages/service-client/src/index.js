/**
 * @aritii/service-client - Main Entry Point
 */

const ServiceClient = require('./client');
const {
  ServiceCallError,
  ServiceTimeoutError,
  ServiceUnavailableError,
  ServiceAuthError
} = require('./errors');
const RetryStrategy = require('./retry');

module.exports = {
  // Main client
  ServiceClient,
  createClient: (serviceName, baseUrl, authToken, options) =>
    new ServiceClient(serviceName, baseUrl, authToken, options),

  // Errors
  ServiceCallError,
  ServiceTimeoutError,
  ServiceUnavailableError,
  ServiceAuthError,

  // Retry strategy
  RetryStrategy
};
