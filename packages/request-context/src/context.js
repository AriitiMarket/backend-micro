/**
 * Request context management
 */

const crypto = require('crypto');

class RequestContext {
  static storage = new Map();

  /**
   * Generate new trace ID
   */
  static newTraceId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Generate request ID
   */
  static newRequestId() {
    return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Normalize trace ID
   */
  static normalizeTraceId(id) {
    if (!id) return this.newTraceId();
    return id.substring(0, 16);
  }

  /**
   * Set context for request
   */
  static setContext(requestId, context) {
    this.storage.set(requestId, {
      traceId: this.normalizeTraceId(context.traceId),
      requestId,
      serviceName: context.serviceName,
      userId: context.userId,
      startTime: Date.now(),
      ...context
    });
  }

  /**
   * Get current context
   */
  static getContext(requestId) {
    return this.storage.get(requestId) || {};
  }

  /**
   * Clear context
   */
  static clearContext(requestId) {
    this.storage.delete(requestId);
  }

  /**
   * Get trace ID
   */
  static getTraceId(requestId) {
    return this.getContext(requestId).traceId || 'unknown';
  }

  /**
   * Format log entry
   */
  static formatLog(requestId, level, message, data = {}) {
    const context = this.getContext(requestId);
    const duration = context.startTime ? Date.now() - context.startTime : 0;

    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId: context.traceId,
      requestId,
      serviceName: context.serviceName,
      userId: context.userId,
      duration,
      ...data
    };
  }
}

module.exports = RequestContext;
