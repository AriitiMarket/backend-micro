/**
 * @packages/service-client - Main Entry Point
 */
'use strict';

const internalClient = require('./internal-client');
const ServiceClient = require('./client');
const {
  ServiceCallError: BaseServiceCallError,
  ServiceTimeoutError,
  ServiceUnavailableError,
  ServiceAuthError
} = require('./errors');
const RetryStrategy = require('./retry');

module.exports = {
  // Canonical internal client
  ...internalClient,

  // Object-oriented client and errors
  ServiceClient,
  createClient: (serviceName, baseUrl, authToken, options) =>
    new ServiceClient(serviceName, baseUrl, authToken, options),

  ServiceTimeoutError,
  ServiceUnavailableError,
  ServiceAuthError,

  RetryStrategy,
};
