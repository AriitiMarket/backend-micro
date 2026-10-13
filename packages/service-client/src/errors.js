/**
 * Service Client Errors
 */

class ServiceCallError extends Error {
  constructor(serviceName, endpoint, statusCode, message, retryable = false) {
    super(`[${serviceName}] ${endpoint}: ${message}`);
    this.name = 'ServiceCallError';
    this.serviceName = serviceName;
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

class ServiceTimeoutError extends ServiceCallError {
  constructor(serviceName, endpoint, timeout) {
    super(
      serviceName,
      endpoint,
      null,
      `Request timeout after ${timeout}ms`,
      true
    );
    this.name = 'ServiceTimeoutError';
    this.timeout = timeout;
  }
}

class ServiceUnavailableError extends ServiceCallError {
  constructor(serviceName, endpoint) {
    super(
      serviceName,
      endpoint,
      503,
      'Service unavailable',
      true
    );
    this.name = 'ServiceUnavailableError';
  }
}

class ServiceAuthError extends ServiceCallError {
  constructor(serviceName, endpoint, message) {
    super(
      serviceName,
      endpoint,
      401,
      message || 'Authentication failed',
      false
    );
    this.name = 'ServiceAuthError';
  }
}

module.exports = {
  ServiceCallError,
  ServiceTimeoutError,
  ServiceUnavailableError,
  ServiceAuthError
};
