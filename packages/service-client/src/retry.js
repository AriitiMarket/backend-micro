/**
 * Retry Logic with Exponential Backoff
 */

class RetryStrategy {
  constructor(maxRetries = 3, initialDelay = 100, maxDelay = 10000) {
    this.maxRetries = maxRetries;
    this.initialDelay = initialDelay;
    this.maxDelay = maxDelay;
  }

  /**
   * Determine if should retry
   */
  shouldRetry(error, attempt) {
    if (attempt >= this.maxRetries) return false;

    // Retry on network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return true;
    }

    // Retry on timeout
    if (error.name === 'ServiceTimeoutError') {
      return true;
    }

    // Retry on 5xx errors
    if (error.statusCode && error.statusCode >= 500) {
      return true;
    }

    // Retry on 429 (rate limit)
    if (error.statusCode === 429) {
      return true;
    }

    // Don't retry on 4xx errors (except 429)
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return false;
    }

    return false;
  }

  /**
   * Calculate delay for attempt
   */
  calculateDelay(attempt) {
    const exponentialDelay = this.initialDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const delay = Math.min(exponentialDelay + jitter, this.maxDelay);
    return Math.round(delay);
  }

  /**
   * Sleep for specified milliseconds
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = RetryStrategy;
