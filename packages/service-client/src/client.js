/**
 * Service-to-Service HTTP Client
 */

const fetch = require('node-fetch');
const { ServiceCallError, ServiceTimeoutError, ServiceAuthError } = require('./errors');
const RetryStrategy = require('./retry');

class ServiceClient {
  constructor(serviceName, baseUrl, authToken, options = {}) {
    this.serviceName = serviceName;
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    this.timeout = options.timeout || 10000;
    this.retryStrategy = new RetryStrategy(
      options.maxRetries || 3,
      options.initialDelay || 100,
      options.maxDelay || 10000
    );
    this.logger = options.logger || console;
  }

  /**
   * Build full URL
   */
  buildUrl(endpoint, params = {}) {
    let url = `${this.baseUrl}${endpoint}`;

    const queryString = new URLSearchParams(params).toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    return url;
  }

  /**
   * Create request headers
   */
  createHeaders(method = 'GET', contentType = 'application/json') {
    const headers = {
      'Content-Type': contentType,
      'x-internal-auth': this.authToken,
      'x-service-name': this.serviceName,
      'x-request-id': `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    return headers;
  }

  /**
   * Perform HTTP request with retries
   */
  async request(method, endpoint, options = {}) {
    const url = this.buildUrl(endpoint, options.params);
    const headers = this.createHeaders(method, options.contentType);
    let lastError;

    for (let attempt = 0; attempt <= this.retryStrategy.maxRetries; attempt++) {
      try {
        return await this.performRequest(method, url, headers, options, attempt);
      } catch (error) {
        lastError = error;

        if (!this.retryStrategy.shouldRetry(error, attempt)) {
          throw error;
        }

        if (attempt < this.retryStrategy.maxRetries) {
          const delay = this.retryStrategy.calculateDelay(attempt);
          this.logger.warn(
            `Retry ${attempt + 1}/${this.retryStrategy.maxRetries} for ${endpoint} after ${delay}ms`
          );
          await this.retryStrategy.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Perform actual HTTP request
   */
  async performRequest(method, url, headers, options, attempt) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch {
          errorData = { message: response.statusText };
        }

        if (response.status === 401 || response.status === 403) {
          throw new ServiceAuthError(
            this.serviceName,
            url,
            errorData.message || 'Unauthorized'
          );
        }

        throw new ServiceCallError(
          this.serviceName,
          url,
          response.status,
          errorData.message || response.statusText,
          response.status >= 500
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new ServiceTimeoutError(this.serviceName, url, this.timeout);
      }

      throw error;
    }
  }

  /**
   * GET request
   */
  async get(endpoint, params = {}, options = {}) {
    return this.request('GET', endpoint, { ...options, params });
  }

  /**
   * POST request
   */
  async post(endpoint, body, params = {}, options = {}) {
    return this.request('POST', endpoint, { ...options, body, params });
  }

  /**
   * PUT request
   */
  async put(endpoint, body, params = {}, options = {}) {
    return this.request('PUT', endpoint, { ...options, body, params });
  }

  /**
   * DELETE request
   */
  async delete(endpoint, params = {}, options = {}) {
    return this.request('DELETE', endpoint, { ...options, params });
  }

  /**
   * Health check
   */
  async health() {
    try {
      const result = await this.get('/health');
      return {
        healthy: true,
        service: this.serviceName,
        data: result
      };
    } catch (error) {
      return {
        healthy: false,
        service: this.serviceName,
        error: error.message
      };
    }
  }
}

module.exports = ServiceClient;
